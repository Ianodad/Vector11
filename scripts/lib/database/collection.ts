// Collection creation/management
import { DataAPIResponseError } from "@datastax/astra-db-ts";
import type { Db } from "@datastax/astra-db-ts";
import { isEnabled } from "../config/env.js";

export type SimilarityMetric = "cosine" | "euclidean" | "dot_product";

export const createCollection = async (
  db: Db,
  collectionName: string,
  similarityMetric: SimilarityMetric,
  vectorDimensions: number,
  allowRecreate: string | undefined,
  forceRecreate = false,
): Promise<number> => {
  // If force recreate is enabled, drop existing collection first
  if (forceRecreate && isEnabled(allowRecreate)) {
    try {
      console.log(`Force recreate enabled - dropping existing collection '${collectionName}'...`);
      await db.dropCollection(collectionName);
      console.log(`Collection '${collectionName}' dropped successfully`);
    } catch (dropErr) {
      // Collection might not exist, which is fine
      if (dropErr instanceof Error && !dropErr.message.includes("does not exist")) {
        console.warn(`Warning dropping collection: ${dropErr.message}`);
      }
    }
  }

  try {
    const res = await db.createCollection(collectionName, {
      vector: {
        dimension: vectorDimensions,
        metric: similarityMetric,
      },
    });
    console.log(res);
    return vectorDimensions;
  } catch (err) {
    if (
      err instanceof DataAPIResponseError &&
      err.message.includes("Collection already exists")
    ) {
      const existing = await db.collection(collectionName).options();
      const existingDimensions = existing.vector?.dimension;
      if (!existingDimensions) {
        throw new Error(
          `Collection '${collectionName}' exists but has no vector dimension.`,
        );
      }
      if (existingDimensions !== vectorDimensions) {
        if (!isEnabled(allowRecreate)) {
          throw new Error(
            `Collection '${collectionName}' dimension mismatch: existing=${existingDimensions}, requested=${vectorDimensions}. Set ALLOW_COLLECTION_RECREATE=true to recreate the collection.`,
          );
        }
        console.log(
          `Recreating collection with ${vectorDimensions} dimensions (existing was ${existingDimensions})`,
        );
        await db.dropCollection(collectionName);
        const res = await db.createCollection(collectionName, {
          vector: {
            dimension: vectorDimensions,
            metric: similarityMetric,
          },
        });
        console.log(res);
        return vectorDimensions;
      }
      console.log(
        `Using existing collection with ${existingDimensions} dimensions`,
      );
      return existingDimensions;
    }
    throw err;
  }
};
