# Task: Two bounded follow-up fixes to the lifecycle blocker work

Repo: /data/Documents/vector11 (branch fix/retrieval-season-hybrid — work in place)

## Hard rules
- Do NOT run any git commands.
- Touch ONLY: `scripts/lib/database/operations.ts`, `scripts/loadDb.ts`,
  `scripts/lib/database/collection.ts`.
- No live Astra DB calls.
- Match existing code style.

## Fix 1 — duplicate-aware count assertion (operations.ts + loadDb.ts)

Context: `loadDb.ts` now asserts `recordsAdded === attemptedRecords - recordsSkipped`
at end of run and sets exitCode 1 on mismatch. Flaw: duplicate `_id`s are a
NORMAL occurrence (chunk `_id` is a content hash; identical text → same id,
tolerated by design in `batchInsertParents`/`batchInsertChildren`'s
"already exists / duplicate" branch, where `inserted` < batch size). Duplicates
are counted neither in `recordsAdded` nor `recordsSkipped`, so a healthy seed
with any duplicate would fire the mismatch warning and fail CI spuriously.

Change:
- `InsertResult` gains `recordsDuplicated: number`.
- In BOTH insert functions' duplicate branch: `recordsDuplicated += batch.length - inserted`
  (batch = the docs array actually sent). In the size-limit branch, the docs
  not inserted and not oversized may also be duplicates reported behind the
  aggregate error — count those as `batchSize - inserted - oversized.length`
  into `recordsDuplicated` as well (never negative; clamp at 0). Everywhere
  else it stays 0.
- `loadDb.ts`: accumulate `recordsDuplicated` from both parent and child
  results (add to the summary print), and change the assertion to
  `recordsAdded === attemptedRecords - recordsSkipped - recordsDuplicated`.
  Update the mismatch message to include the duplicated count.

## Fix 2 — poll robustness (collection.ts)

`pollForCollection` calls `listCollectionDefinitions(db)` in a loop; it runs
in exactly the windows where the DB is flaky (right after a create timeout).
If that list call throws, the error propagates and aborts the whole
create-retry loop. Change: wrap the list call in try/catch; on error, log a
one-line warn and treat it as "collection not visible yet" (continue polling
until the deadline).

## Verification (run all; report results)
- `npx tsc --noEmit` → clean.
- `npx eslint scripts/` → 0 errors (4 pre-existing htmlScraper warnings OK).
- `npx tsx scripts/validateChunking.ts` → exit 0.

## Report format (short)
DONE/BLOCKED · what changed per fix (2–4 lines each) · verification outputs.
