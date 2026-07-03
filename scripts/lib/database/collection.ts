// Collection creation/management
import { DataAPIResponseError } from "@datastax/astra-db-ts";
import type { Db } from "@datastax/astra-db-ts";
import { isEnabled } from "../config/env.js";
import { getErrorMessage, sleepMs } from "../utils/retry.js";

export type SimilarityMetric = "cosine" | "euclidean" | "dot_product";

/**
 * Serverless Astra databases hibernate after a period of inactivity. The first
 * request after a pause fails fast with a 503 "Resuming your database, please
 * try again shortly" — which is why the scheduled 3am seed (cold DB) always
 * died in ~45s while manual daytime runs (warm DB) succeeded.
 *
 * This pings the DB with a cheap metadata call and waits out the resume, using
 * a capped backoff (no single multi-minute sleep). It retries on ANY error, not
 * just the 503 text, because a waking DB can also surface connection/timeout
 * errors. Total worst-case wait ≈ maxAttempts * maxDelayMs.
 */
export const waitForDbReady = async (
  db: Db,
  { maxAttempts = 15, baseDelayMs = 2000, maxDelayMs = 15000 } = {},
): Promise<void> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.listCollections({ nameOnly: true });
      if (attempt > 1) console.log(`[db] ready after ${attempt} attempt(s)`);
      return;
    } catch (err) {
      const msg = getErrorMessage(err);
      const resuming = /resum|503|not (yet )?ready|starting|initializ/i.test(msg);
      if (attempt === maxAttempts) {
        throw new Error(
          `Database not ready after ${maxAttempts} attempts (${resuming ? "still resuming" : "last error"}: ${msg})`,
        );
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.warn(
        `[db] not ready (attempt ${attempt}/${maxAttempts}${resuming ? ", serverless resuming" : ""}): ${msg}. Waiting ${delayMs}ms`,
      );
      await sleepMs(delayMs);
    }
  }
};

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
