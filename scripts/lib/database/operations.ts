// Batch insert operations
import { createHash } from "crypto";
import { CollectionInsertManyError, type Collection } from "@datastax/astra-db-ts";
import { MAX_DOCUMENT_BYTES, type ParentRecord, type ChildRecord } from "../utils/chunking.js";

export interface InsertResult {
  recordsAdded: number;
  recordsSkipped: number;
}

// Matches Astra's rejection message for an indexed field (content/$lexical)
// over the 8,000-byte ceiling. A single oversized document must not abort a
// 2-hour seed run — it gets logged and skipped instead.
const SIZE_LIMIT_RE = /document size limitation|exceeds maximum allowed/i;

// Matches transient Astra/Cassandra errors that are safe to retry.
const TRANSIENT_RE = /timeout|timed out|replica|unavailable|NullPointer|server error/i;

const MAX_RETRY_ATTEMPTS = 6;

const isOversized = (doc: { content: string; $lexical?: string }): boolean =>
  Buffer.byteLength(doc.content, "utf8") > MAX_DOCUMENT_BYTES ||
  (doc.$lexical !== undefined && Buffer.byteLength(doc.$lexical, "utf8") > MAX_DOCUMENT_BYTES);

// CollectionInsertManyError (astra-db-ts's actual thrown type for a partial,
// unordered insertMany failure) exposes insertedIds()/errors(), not a
// partialResult field — this reads the real per-batch success count instead
// of inferring it from which documents we think should have succeeded.
const insertedCountOf = (err: unknown): number =>
  err instanceof CollectionInsertManyError ? err.insertedIds().length : 0;

// Wraps a single insertMany call with retry on transient Astra/Cassandra errors.
// Duplicate and size-limit errors are NOT retried — they propagate immediately so
// the existing handling in batchInsertParents / batchInsertChildren is unchanged.
const insertManyWithRetry = async (
  doInsert: () => Promise<{ insertedCount: number }>,
  batchIdx: number,
): Promise<{ insertedCount: number }> => {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await doInsert();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      // Duplicate and size-limit are not transient — propagate for existing handling
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        SIZE_LIMIT_RE.test(msg)
      ) {
        throw err;
      }
      // Non-transient unknown error — propagate immediately
      if (!TRANSIENT_RE.test(msg)) {
        throw err;
      }
      // Transient — retry if attempts remain, otherwise propagate
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = attempt * 10_000;
        console.log(
          `  [Retry] Batch ${batchIdx} attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed (transient), ` +
            `retrying in ${delay / 1000}s — ${msg.slice(0, 120)}`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
  // Unreachable — loop always returns or throws
  throw new Error("insertManyWithRetry: unreachable");
};

export const batchInsertParents = async (
  collection: Collection,
  parentDocs: ParentRecord[],
): Promise<InsertResult> => {
  const INSERT_BATCH = 20;
  let recordsAdded = 0;
  let recordsSkipped = 0;

  for (let b = 0; b < parentDocs.length; b += INSERT_BATCH) {
    const batch = parentDocs.slice(b, b + INSERT_BATCH);
    try {
      const res = await insertManyWithRetry(
        () => collection.insertMany(batch, { ordered: false }),
        b / INSERT_BATCH,
      );
      recordsAdded += res.insertedCount;
    } catch (insertErr: unknown) {
      const msg = insertErr instanceof Error ? insertErr.message : "";
      const inserted = insertedCountOf(insertErr);
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        recordsAdded += inserted;
        console.log(
          `  Parent batch had duplicates, inserted ${inserted} new docs`,
        );
      } else if (SIZE_LIMIT_RE.test(msg)) {
        const oversized = batch.filter(isOversized);
        if (oversized.length === 0) {
          // Astra reported a size violation but our own byte check found no
          // culprit in this batch — don't silently swallow an error we can't
          // attribute to a specific document.
          throw insertErr;
        }
        for (const doc of oversized) {
          console.warn(
            `  Skipped oversized parent document (exceeds ${MAX_DOCUMENT_BYTES}-byte Astra limit): _id=${doc._id} source=${doc.source} url=${doc.url}`,
          );
        }
        recordsSkipped += oversized.length;
        recordsAdded += inserted;
      } else {
        throw insertErr;
      }
    }
  }

  return { recordsAdded, recordsSkipped };
};

export const batchInsertChildren = async (
  collection: Collection,
  childTexts: string[],
  childMeta: { parentId: string }[],
  allVectors: number[][],
  source: string,
  url: string,
  category: string,
  scrapedAt: string,
): Promise<InsertResult> => {
  const INSERT_BATCH = 20;
  let recordsAdded = 0;
  let recordsSkipped = 0;

  for (let b = 0; b < childTexts.length; b += INSERT_BATCH) {
    const batchDocs: ChildRecord[] = childTexts
      .slice(b, b + INSERT_BATCH)
      .map((chunk, idx) => {
        const globalIdx = b + idx;
        const childId = createHash("md5")
          .update(`${childMeta[globalIdx].parentId}|${chunk}`)
          .digest("hex");
        return {
          _id: childId,
          content: chunk,
          parentId: childMeta[globalIdx].parentId,
          source,
          url,
          category,
          scrapedAt,
          type: "child" as const,
          $vector: allVectors[globalIdx],
          $lexical: chunk,
        };
      });

    try {
      const res = await insertManyWithRetry(
        () => collection.insertMany(batchDocs, { ordered: false }),
        b / INSERT_BATCH,
      );
      recordsAdded += res.insertedCount;
    } catch (insertErr: unknown) {
      const msg = insertErr instanceof Error ? insertErr.message : "";
      const inserted = insertedCountOf(insertErr);
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        recordsAdded += inserted;
        console.log(
          `  Child batch had duplicates, inserted ${inserted} new docs`,
        );
      } else if (SIZE_LIMIT_RE.test(msg)) {
        const oversized = batchDocs.filter(isOversized);
        if (oversized.length === 0) {
          throw insertErr;
        }
        for (const doc of oversized) {
          console.warn(
            `  Skipped oversized child document (exceeds ${MAX_DOCUMENT_BYTES}-byte Astra limit): _id=${doc._id} source=${doc.source} url=${doc.url}`,
          );
        }
        recordsSkipped += oversized.length;
        recordsAdded += inserted;
      } else {
        throw insertErr;
      }
    }
  }

  return { recordsAdded, recordsSkipped };
};
