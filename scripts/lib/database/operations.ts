// Batch insert operations
import { createHash } from "crypto";
import type { Collection } from "@datastax/astra-db-ts";
import type { ParentRecord, ChildRecord } from "../utils/chunking.js";

export interface InsertResult {
  recordsAdded: number;
}

export const batchInsertParents = async (
  collection: Collection,
  parentDocs: ParentRecord[],
): Promise<InsertResult> => {
  const INSERT_BATCH = 20;
  let recordsAdded = 0;

  for (let b = 0; b < parentDocs.length; b += INSERT_BATCH) {
    const batch = parentDocs.slice(b, b + INSERT_BATCH);
    try {
      const res = await collection.insertMany(batch, { ordered: false });
      recordsAdded += res.insertedCount;
    } catch (insertErr: unknown) {
      const msg = insertErr instanceof Error ? insertErr.message : "";
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        const inserted =
          (insertErr as Error & { partialResult?: { insertedCount?: number } })
            .partialResult?.insertedCount ?? 0;
        recordsAdded += inserted;
        console.log(
          `  Parent batch had duplicates, inserted ${inserted} new docs`,
        );
      } else {
        throw insertErr;
      }
    }
  }

  return { recordsAdded };
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
        };
      });

    try {
      const res = await collection.insertMany(batchDocs, { ordered: false });
      recordsAdded += res.insertedCount;
    } catch (insertErr: unknown) {
      const msg = insertErr instanceof Error ? insertErr.message : "";
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        const inserted =
          (insertErr as Error & { partialResult?: { insertedCount?: number } })
            .partialResult?.insertedCount ?? 0;
        recordsAdded += inserted;
        console.log(
          `  Child batch had duplicates, inserted ${inserted} new docs`,
        );
      } else {
        throw insertErr;
      }
    }
  }

  return { recordsAdded };
};
