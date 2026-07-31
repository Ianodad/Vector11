# Task: Detect missing field-indexes after collection creation (index canary probe)

Repo: /data/Documents/vector11 (branch fix/retrieval-season-hybrid — work in place)

## Hard rules
- Do NOT run any git commands.
- Touch ONLY `scripts/lib/database/collection.ts`.
- No live Astra DB calls from you (code only; the orchestrator verifies live).
- Match existing code style.

## Context — live incident, just measured (2026-07-30 ~15:00 EAT)
The re-seed created collection `vector11gpt` whose DEFINITION verifies clean
(dimension/metric/lexical/rerank all correct — our `findConfigMismatches`
passed) but whose FIELD INDEXES are missing: every filtered query
(`findOne({type:"parent"})`, filters on `category`/`parentId`) fails with
Data API error `CORRUPTED_COLLECTION_SCHEMA` ("would require ALLOW
FILTERING"). Unfiltered reads, `_id` lookups, and inserts all work. Astra says
such a collection can only be recreated, not repaired. This is a
partial-materialization variant our post-create verification cannot see,
because `listCollections()` definitions do not include index state.

## Required change — canary probe in the verification path

In `collection.ts`:
1. Add `probeFieldIndexes(db, collectionName)`: runs a cheap FILTERED read,
   e.g. `db.collection(name).findOne({ type: "__index_probe__" })` (matches
   nothing; on a healthy collection returns null quickly — the point is that
   the query PLANNER accepts it).
   - Healthy → return (no mismatch).
   - Error whose message matches /CORRUPTED_COLLECTION_SCHEMA|ALLOW FILTERING|schema definition is corrupted/i
     → report a ConfigMismatch-style failure `{ field: "field-indexes", expected: "queryable", actual: "missing (ALLOW FILTERING)" }`.
   - Any OTHER error (transient/timeout/replica per the existing
     `isTransientError`) → retry the probe up to 3 times with ~5s backoff
     (`sleepMs`); if still erroring transiently, THROW (don't silently pass —
     an unverifiable collection must not be seeded into).
2. Wire it into `createCollection`'s verification step: after
   `findConfigMismatches` passes on the definition, run the probe. A probe
   failure counts as a config mismatch → same handling as existing mismatches
   (recreate once if `isEnabled(allowRecreate)`, then re-verify definition AND
   probe; otherwise/still-failing → throw naming the finding).
3. Keep the public signature unchanged.

## Verification (run all; report results)
- `npx tsc --noEmit` → clean.
- `npx eslint scripts/` → 0 errors (4 pre-existing htmlScraper warnings OK).
- `npx tsx scripts/validateChunking.ts` → exit 0 (regression check).

## Report format (short)
DONE/BLOCKED · what changed (3–6 lines) · verification outputs.
