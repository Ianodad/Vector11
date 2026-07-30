// Collection creation/management
import { DataAPIResponseError, DataAPITimeoutError } from "@datastax/astra-db-ts";
import type { Db, CollectionDescriptor } from "@datastax/astra-db-ts";
import { isEnabled } from "../config/env.js";
import { getErrorMessage, sleepMs } from "../utils/retry.js";

export type SimilarityMetric = "cosine" | "euclidean" | "dot_product";

// Astra serverless proven failure modes (live-measured 2026-07-30):
//  - createCollection can time out SERVER-side (PT30S, not client-tunable) and
//    then materialize anyway (sometimes with PARTIAL config).
//  - dropCollection/truncate can fail with a replica error that Astra itself
//    documents as safe to retry.
// The constants below bound the retry/poll behaviour that works around both.
const DROP_VERIFY_ATTEMPTS = 5;
const CREATE_RETRY_ATTEMPTS = 4;
const CREATE_POLL_TIMEOUT_MS = 60_000;
const CREATE_POLL_INTERVAL_MS = 5_000;

const listCollectionNames = (db: Db): Promise<string[]> =>
  db.listCollections({ nameOnly: true });

const listCollectionDefinitions = (db: Db): Promise<CollectionDescriptor[]> =>
  db.listCollections();

const isTransientError = (err: unknown): boolean => {
  if (err instanceof DataAPITimeoutError) return true;
  const msg = getErrorMessage(err);
  return /timeout|timed out|replica|unavailable|resum|server error|ECONNRESET|ETIMEDOUT/i.test(
    msg,
  );
};

const isAlreadyExistsError = (err: unknown): boolean =>
  err instanceof DataAPIResponseError && err.message.includes("Collection already exists");

/**
 * Poll for up to `timeoutMs` to see if `collectionName` shows up in
 * `listCollections()` (full definitions). Used after a createCollection call
 * that errored client-side (e.g. a server-side PT30S timeout) — the
 * collection may still be materializing server-side.
 */
const pollForCollection = async (
  db: Db,
  collectionName: string,
  timeoutMs = CREATE_POLL_TIMEOUT_MS,
  intervalMs = CREATE_POLL_INTERVAL_MS,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const defs = await listCollectionDefinitions(db);
      if (defs.some((c) => c.name === collectionName)) return true;
    } catch (err) {
      // The DB is flakiest right after a create timeout — exactly when this
      // poll runs. A thrown list call here must not abort the whole
      // create-retry loop; treat it as "collection not visible yet" and keep
      // polling until the deadline.
      console.warn(
        `[db] listCollections failed while polling for '${collectionName}': ${getErrorMessage(err)}`,
      );
    }
    if (Date.now() >= deadline) return false;
    await sleepMs(intervalMs);
  }
};

/**
 * A failed drop must never be swallowed: a replica error ("Truncate failed on
 * replica ...") that Astra says is retry-safe would otherwise leave the
 * caller thinking the collection is gone when it's still there, and creation
 * would proceed against a stale/wrong-config survivor. This verifies via
 * `listCollections` after every attempt and only returns once the collection
 * is confirmed absent; if it's still present after all retries, it throws
 * (aborting the run) rather than proceeding.
 */
const dropCollectionVerified = async (
  db: Db,
  collectionName: string,
): Promise<void> => {
  for (let attempt = 1; attempt <= DROP_VERIFY_ATTEMPTS; attempt += 1) {
    try {
      await db.dropCollection(collectionName);
    } catch (dropErr) {
      const msg = getErrorMessage(dropErr);
      if (msg.includes("does not exist")) return; // clean no-op
      console.warn(
        `Warning dropping collection '${collectionName}' (attempt ${attempt}/${DROP_VERIFY_ATTEMPTS}): ${msg}`,
      );
    }

    const stillThere = (await listCollectionNames(db)).includes(collectionName);
    if (!stillThere) {
      if (attempt > 1) {
        console.log(`Collection '${collectionName}' confirmed dropped after ${attempt} attempt(s)`);
      }
      return;
    }

    if (attempt === DROP_VERIFY_ATTEMPTS) {
      throw new Error(
        `Collection '${collectionName}' still present after ${DROP_VERIFY_ATTEMPTS} drop attempts — ` +
          `aborting rather than proceeding into creation with a possibly-stale collection.`,
      );
    }

    const delayMs = Math.min(5000 + (attempt - 1) * 2500, 15000); // 5-15s
    console.warn(
      `Collection '${collectionName}' still listed after drop attempt ${attempt}/${DROP_VERIFY_ATTEMPTS}; ` +
        `retrying in ${delayMs}ms (replica errors are retry-safe)`,
    );
    await sleepMs(delayMs);
  }
};

interface ConfigMismatch {
  field: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Full-config verification: checks dimension, metric, lexical, and rerank —
 * not just dimension. A collection can materialize with partial config
 * (lexical/rerank missing) after a server-side create timeout, which silently
 * breaks every `findAndRerank` `$hybrid` query later.
 */
const findConfigMismatches = (
  definition: CollectionDescriptor["definition"] | undefined,
  expected: { dimension: number; metric: SimilarityMetric },
): ConfigMismatch[] => {
  const mismatches: ConfigMismatch[] = [];
  if (!definition) {
    mismatches.push({ field: "definition", expected: "present", actual: "missing" });
    return mismatches;
  }

  const dimension = definition.vector?.dimension;
  const metric = definition.vector?.metric;
  const lexicalEnabled = definition.lexical?.enabled;
  const rerankEnabled = definition.rerank?.enabled;

  if (dimension !== expected.dimension) {
    mismatches.push({ field: "vector.dimension", expected: expected.dimension, actual: dimension });
  }
  if (metric !== expected.metric) {
    mismatches.push({ field: "vector.metric", expected: expected.metric, actual: metric });
  }
  if (!lexicalEnabled) {
    mismatches.push({ field: "lexical.enabled", expected: true, actual: lexicalEnabled });
  }
  if (!rerankEnabled) {
    mismatches.push({ field: "rerank.enabled", expected: true, actual: rerankEnabled });
  }
  return mismatches;
};

const describeMismatches = (mismatches: ConfigMismatch[]): string =>
  mismatches.map((m) => `${m.field} (expected=${m.expected}, actual=${m.actual})`).join(", ");

const PROBE_RETRY_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 5000;

const isMissingFieldIndexError = (err: unknown): boolean =>
  /CORRUPTED_COLLECTION_SCHEMA|ALLOW FILTERING|schema definition is corrupted/i.test(
    getErrorMessage(err),
  );

/**
 * Canary probe for a partial-materialization failure mode `findConfigMismatches`
 * cannot see: a collection whose DEFINITION (dimension/metric/lexical/rerank)
 * verifies clean but whose FIELD INDEXES never materialized. Unfiltered reads,
 * `_id` lookups, and inserts all succeed on such a collection — only filtered
 * queries fail, with `CORRUPTED_COLLECTION_SCHEMA` ("would require ALLOW
 * FILTERING"). Astra says this state can only be recreated, not repaired, so
 * this must be caught before seeding proceeds.
 *
 * Runs a cheap filtered read that matches nothing. On a healthy collection the
 * query planner accepts it and it resolves (fast) with no results. A missing-
 * index error is reported as a mismatch; any other (transient) error is
 * retried a few times, and re-thrown if it never resolves — an unverifiable
 * collection must not be seeded into.
 */
const probeFieldIndexes = async (
  db: Db,
  collectionName: string,
): Promise<ConfigMismatch[]> => {
  for (let attempt = 1; attempt <= PROBE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await db.collection(collectionName).findOne({ type: "__index_probe__" });
      return [];
    } catch (err) {
      if (isMissingFieldIndexError(err)) {
        return [
          { field: "field-indexes", expected: "queryable", actual: "missing (ALLOW FILTERING)" },
        ];
      }

      const msg = getErrorMessage(err);
      if (attempt === PROBE_RETRY_ATTEMPTS) {
        throw new Error(
          `Field-index probe on '${collectionName}' failed ${PROBE_RETRY_ATTEMPTS} times ` +
            `(unverifiable collection — refusing to seed into it): ${msg}`,
        );
      }
      console.warn(
        `Field-index probe on '${collectionName}' attempt ${attempt}/${PROBE_RETRY_ATTEMPTS} failed ` +
          `(transient, retrying in ${PROBE_RETRY_DELAY_MS}ms): ${msg}`,
      );
      await sleepMs(PROBE_RETRY_DELAY_MS);
    }
  }
  return [];
};

/**
 * Attempt to create the collection, retrying transient/timeout errors with a
 * 10-30s backoff (~4 attempts total). A create that errors client-side after
 * a server-side timeout may still materialize, so each transient failure is
 * followed by a poll (see `pollForCollection`) before deciding to retry.
 * Resolves (without throwing) on: clean create, post-timeout materialization,
 * or a "Collection already exists" response — callers must post-verify the
 * resulting config in all three cases.
 */
const createCollectionWithRetry = async (
  db: Db,
  collectionName: string,
  similarityMetric: SimilarityMetric,
  vectorDimensions: number,
): Promise<void> => {
  const createOptions = {
    vector: {
      dimension: vectorDimensions,
      metric: similarityMetric,
    },
    lexical: { enabled: true, analyzer: "standard" },
    rerank: {
      enabled: true,
      service: { provider: "nvidia", modelName: "nvidia/llama-3.2-nv-rerankqa-1b-v2" },
    },
  };

  for (let attempt = 1; attempt <= CREATE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const res = await db.createCollection(collectionName, createOptions);
      console.log(res);
      return;
    } catch (err) {
      if (isAlreadyExistsError(err)) return;

      const transient = isTransientError(err);
      console.warn(
        `createCollection('${collectionName}') attempt ${attempt}/${CREATE_RETRY_ATTEMPTS} failed` +
          `${transient ? " (transient)" : ""}: ${getErrorMessage(err)}`,
      );

      if (transient) {
        console.log(
          `Polling for server-side materialization of '${collectionName}' (up to ${CREATE_POLL_TIMEOUT_MS / 1000}s)...`,
        );
        const appeared = await pollForCollection(db, collectionName);
        if (appeared) {
          console.log(`Collection '${collectionName}' materialized server-side after timeout`);
          return;
        }
      }

      if (!transient || attempt === CREATE_RETRY_ATTEMPTS) throw err;

      const delayMs = 10_000 + Math.floor(Math.random() * 20_000); // 10-30s
      console.warn(`Retrying createCollection('${collectionName}') in ${delayMs}ms`);
      await sleepMs(delayMs);
    }
  }
};

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
  // If force recreate is enabled, drop existing collection first — verified,
  // so a failed/partial drop never leads to creation atop a stale survivor.
  if (forceRecreate && isEnabled(allowRecreate)) {
    console.log(`Force recreate enabled - dropping existing collection '${collectionName}'...`);
    await dropCollectionVerified(db, collectionName);
    console.log(`Collection '${collectionName}' confirmed absent`);
  }

  await createCollectionWithRetry(db, collectionName, similarityMetric, vectorDimensions);

  const expected = { dimension: vectorDimensions, metric: similarityMetric };
  const verify = async (): Promise<ConfigMismatch[]> => {
    const defs = await listCollectionDefinitions(db);
    const definition = defs.find((c) => c.name === collectionName)?.definition;
    const mismatches = findConfigMismatches(definition, expected);
    if (mismatches.length > 0) return mismatches;
    // Definition looks clean — still probe for the partial-materialization
    // variant (missing field indexes) that `findConfigMismatches` can't see.
    return probeFieldIndexes(db, collectionName);
  };

  let mismatches = await verify();
  if (mismatches.length > 0) {
    const describe = describeMismatches(mismatches);
    if (!isEnabled(allowRecreate)) {
      throw new Error(
        `Collection '${collectionName}' config mismatch: ${describe}. Set ALLOW_COLLECTION_RECREATE=true to recreate the collection.`,
      );
    }
    console.log(
      `Collection '${collectionName}' config mismatch (${describe}) — recreating (ALLOW_COLLECTION_RECREATE enabled)`,
    );
    await dropCollectionVerified(db, collectionName);
    await createCollectionWithRetry(db, collectionName, similarityMetric, vectorDimensions);
    mismatches = await verify();
    if (mismatches.length > 0) {
      throw new Error(
        `Collection '${collectionName}' still has config mismatch after recreate: ${describeMismatches(mismatches)}`,
      );
    }
  }

  console.log(
    `Collection '${collectionName}' verified: dimension=${vectorDimensions}, metric=${similarityMetric}, lexical+rerank enabled`,
  );
  return vectorDimensions;
};
