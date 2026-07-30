# Task: transient-error retry for seed insert batches

## Context
`scripts/lib/database/operations.ts` — `batchInsertParents` and `batchInsertChildren`
insert in batches of 20. Current error handling per batch:
- duplicate/already-exists → tolerated (counts inserted, continues)
- Astra size-limit violation → skips the oversized docs
- ANYTHING ELSE → `throw insertErr` → caller (`scripts/loadDb.ts` per-URL catch)
  marks the whole URL failed and moves on.

Live incident 2026-07-30 morning proved Astra serverless throws TRANSIENT errors
under warm-up/degraded conditions, e.g.:
- `WriteTimeoutException: Cassandra timeout during CAS write query at consistency
  LOCAL_SERIAL (3 replica were required but only 0 acknowledged the write)`
- `Truncate failed on replica /10.x.x.x`
- `java.lang.NullPointerException` (composite with the above)
- `DriverTimeoutException: Query timed out after PT30S`

During that window EVERY batch failed at least once, then succeeded on retry
within ~10–30s. Under the current code, a destructive 2-hour re-seed in such a
window would "complete" while silently losing most URLs (per-URL catch swallows).

## Requirement
In `scripts/lib/database/operations.ts` ONLY:

1. Add a shared helper (module-level) that wraps a single `insertMany` batch call
   with retry-on-transient:
   - Transient detector (case-insensitive regex on the error message):
     `/timeout|timed out|replica|unavailable|NullPointer|server error/i`
   - BUT: duplicate/already-exists and the existing `SIZE_LIMIT_RE` cases are NOT
     transient — they must keep flowing to the existing handling unchanged.
     (Order: try insert → on error, first check duplicate & size-limit handling
     exactly as today; only if it is none of those AND matches transient → retry.)
   - Max 6 attempts per batch, linear backoff `attempt * 10_000` ms (10s, 20s … 50s).
   - Retrying a partially-inserted batch is SAFE here: duplicate errors are
     already tolerated, so re-inserting succeeded docs degrades to the duplicate
     path. Preserve correct `recordsAdded` accounting: on a retried batch that
     ultimately lands via the duplicate path, use `insertedIds().length` as today
     — do NOT double-count docs inserted on an earlier failed attempt.
     Simplest correct approach: count via `insertedCountOf`/`insertedCount`
     accumulated ONLY from the final (successful or duplicate-resolved) attempt,
     accepting slight undercount in logs rather than overcount.
   - Log each retry: batch index, attempt number, delay, first 120 chars of error.
   - If all 6 attempts fail → throw (existing per-URL catch handles it).
2. Apply the helper to BOTH `batchInsertParents` and `batchInsertChildren`
   without changing their signatures, return types, or the duplicate/size-limit
   semantics.
3. Do NOT touch any other file. Do NOT touch `scripts/loadDb.ts`.

## Verification (run all, include real output in your report)
1. `npx tsc --noEmit` → clean
2. `npx eslint scripts/` → 0 errors (4 pre-existing warnings in htmlScraper.ts are OK)
3. `npx tsx scripts/validateChunking.ts` → still exit 0 (must not regress)

There is no unit test for operations.ts; do not invent a live-DB test. Reason
about idempotency in your report instead.

## Report format
- What changed (function level)
- Real output of the 3 verification commands
- One paragraph: why retrying a partial batch cannot double-count or lose docs
