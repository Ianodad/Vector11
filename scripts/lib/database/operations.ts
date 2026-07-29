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

const isOversized = (doc: { content: string; $lexical?: string }): boolean =>
  Buffer.byteLength(doc.content, "utf8") > MAX_DOCUMENT_BYTES ||
  (doc.$lexical !== undefined && Buffer.byteLength(doc.$lexical, "utf8") > MAX_DOCUMENT_BYTES);

// CollectionInsertManyError (astra-db-ts's actual thrown type for a partial,
// unordered insertMany failure) exposes insertedIds()/errors(), not a
// partialResult field — this reads the real per-batch success count instead
// of inferring it from which documents we think should have succeeded.
const insertedCountOf = (err: unknown): number =>
  err instanceof CollectionInsertManyError ? err.insertedIds().length : 0;

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
      const res = await collection.insertMany(batch, { ordered: false });
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
      const res = await collection.insertMany(batchDocs, { ordered: false });
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
