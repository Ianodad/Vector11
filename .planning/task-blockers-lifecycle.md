# Task: Fix Codex BLOCKERs 3–4 (+5 mitigation) — collection lifecycle safety

Repo: /data/Documents/vector11 (branch fix/retrieval-season-hybrid — already checked out; work in place)

## Hard rules
- Do NOT run any git commands. No commits, no staging. Leave edits in the working tree.
- Touch ONLY: `scripts/lib/database/collection.ts` and `scripts/loadDb.ts`.
  Another agent is editing `scripts/lib/utils/markdownChunker.ts` and
  `scripts/lib/utils/chunking.ts` concurrently — do not open/edit those.
- Do NOT touch the Astra database. No live DB calls, no seeding. Code + types only.
- Match existing code style/comment density.

## Context: live-measured Astra serverless failure modes (2026-07-30, proven)
- `createCollection` can time out SERVER-side (PT30S, not client-tunable) and
  then MATERIALIZE WITH PARTIAL CONFIG: collection exists but lexical/rerank
  missing → every `findAndRerank` `$hybrid` query fails. Config must be
  verified via `db.listCollections()` definitions after create.
- Drop/truncate can fail with "Truncate failed on replica /10.x.x.x" — Astra
  says safe to retry. Retries within 10–30s succeeded in live testing.

## BLOCKER 3 — failed drops are swallowed (`collection.ts` ~line 55)

Current: `forceRecreate` drop wraps `db.dropCollection` in try/catch that
warn+continues on ANY error except rethrowing nothing. A failed drop (replica
error) → creation path finds the SURVIVING collection, checks only dimension →
seeds into old/wrong-config data. This matches the live failure mode above.

Required fix:
- After the drop attempt, VERIFY the collection is actually gone via
  `db.listCollections({ nameOnly: true })`.
- If the drop threw or the collection is still listed: retry the drop with
  backoff (reuse `sleepMs`; ~5 attempts, 5–15s delays — replica errors are
  retry-safe).
- If it is STILL present after retries: THROW (abort the run loudly). Never
  proceed into creation with a possibly-stale collection when a drop was
  requested.
- "does not exist" remains a clean no-op.

## BLOCKER 4 — creation neither retried nor post-verified (`collection.ts` ~lines 68–124)

Required fix:
- Wrap `db.createCollection` in a retry (~4 attempts, backoff 10–30s) for
  transient/timeout errors.
- After a create ATTEMPT that times out, do NOT immediately retry blind: the
  collection may still materialize server-side. Poll `db.listCollections()`
  (full definitions, not nameOnly) for up to ~60s to see if it appeared.
- POST-VERIFY after any create (clean success, post-timeout materialization,
  or the "Collection already exists" path): fetch this collection's definition
  from `db.listCollections()` and verify ALL of:
  - `vector.dimension` === requested
  - `vector.metric` === requested
  - lexical enabled
  - rerank enabled
  (Inspect the actual definition shape returned by astra-db-ts v2 —
  `listCollections()` returns `{ name, definition }` entries; adapt field
  access to the real types, `npx tsc --noEmit` must pass.)
- On config mismatch: if `isEnabled(allowRecreate)` → drop (using the VERIFIED
  drop from Blocker 3) and re-create, then re-verify (one recreate cycle max);
  otherwise THROW with a message naming exactly which fields mismatched.
- The existing "already exists → dimension-only check" logic must be subsumed
  by this full-config verification (metric/lexical/rerank checked too).
- Keep the function signature compatible with existing callers (`loadDb.ts`,
  and check other call sites with grep) or update the callers accordingly.

## BLOCKER 5 mitigation (bounded, NOT the full redesign) — `loadDb.ts`

The in-place, non-atomic rebuild stays (documented orchestrator decision).
Add the cheap safety rails:
- The per-URL processing loop tracks `failedUrls` / `skippedUrls` but the
  returned summary object (~line 320) omits them — ADD both to the return and
  to the final printed summary.
- At the end of `seed()`: if `failedUrls > 0`, print a clear warning listing
  the count and set `process.exitCode = 1` (do not throw mid-cleanup) so CI
  marks the run failed instead of silently reporting success.
- Sanity assertion: after the loop, compare records actually added
  (`recordsAdded`) against a computed expectation (sum of attempted
  parents+children minus `recordsSkipped`) — on mismatch, log the discrepancy
  loudly and set `process.exitCode = 1`. Track the attempted totals in the
  loop (cheap counters); do not restructure the flow.

## Verification (run all; report results)
- `npx tsc --noEmit` → clean.
- `npx eslint scripts/` → 0 errors (4 pre-existing htmlScraper warnings OK).
- `npx tsx scripts/validateChunking.ts` → still exit 0 (you didn't touch
  chunking, this is a regression check; if it fails on chunker-related items
  it may be the sibling agent mid-edit — re-run once after a 60s wait before
  reporting a failure).
- Grep for all callers of `createCollection` and confirm they still compile.

## Report format (short)
DONE/BLOCKED · files changed · what you changed per blocker (3–5 lines each) ·
verification outputs. No file dumps.
