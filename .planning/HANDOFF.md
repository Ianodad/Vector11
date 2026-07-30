# Handoff — Fable 5 — vector11 / retrieval + season + chunking fix

**Date:** 2026-07-30, ~12:15 EAT (LIVE — updated mid-session at each checkpoint)
**Branch:** `fix/retrieval-season-hybrid` (branched from `main`, never merged, no push)
**Last code commit:** `f7f5966` — lifecycle safety (blockers 3-5); `257f589` — chunker (blockers 1-2)
**Verdict of record:** Codex NO-GO of 2026-07-29 being remediated; re-review pending after round 2

## SESSION UPDATE 2026-07-30 (this session, decision: user approved "A then B")

- **OPTION A DONE + VERIFIED.** Local network has a Fortinet firewall BLOCKING
  all of *.vercel.com and *.vercel.app (403 block page, cert MITM) — `vercel --prod`
  impossible from this machine. Shipped instead via empty commit to `main`
  (679a722 — zero code change; main HEAD was exactly the last deployed sha
  a7a00cc) → Vercel Git integration rebuilt prod with EMBEDDING_DIMENSIONS=1536.
  Verified from a GitHub runner via new workflow `.github/workflows/prod-smoke.yml`
  (commit 9178e91 on main, `gh workflow run prod-smoke.yml`): live /api/chat
  returns full standings table (Liverpool 84 pts …). Prod vector search UNBROKEN.
- **Blockers 1–2 fixed** (commit 257f589): table raw-cut loop now provably
  terminating (MIN_ROW_CONTENT_BUDGET_BYTES=64 + forward-progress guard);
  chunking.ts split-not-truncate (`splitOversizedText` + `capPrefix`, ≥1024-byte
  chunk budget; `enforceDocByteLimit` now THROWS as backstop, never discards).
  Verified: repro hang cases terminate in ms, marker survives, ≤8000 bytes.
- **Blockers 3–4 fixed + 5 mitigated** (commit f7f5966): `dropCollectionVerified`
  (listCollections-verified, 5 retries, throws on survivor);
  `createCollectionWithRetry` (4 attempts, 60s materialization poll, full-config
  post-verify dimension+metric+lexical+rerank, one recreate cycle max);
  loadDb summary now returns failedUrls/skippedUrls/attemptedRecords, exitCode 1
  on failures or count mismatch, final exit respects exitCode.
- Gates re-run by orchestrator on combined tree: validator exit 0, tsc clean,
  eslint 0 errors. Two commits made by orchestrator (agents forbidden from git).
- **IN FLIGHT (round 2, two parallel sonnet executors):**
  (a) validator strengthening per finding 9 — spec `.planning/task-validator-strengthen.md`;
  (b) follow-ups — duplicate-aware count assertion (operations.ts InsertResult
  gains recordsDuplicated; expectation = attempted − skipped − duplicated) and
  pollForCollection tolerating throwing listCollections — spec
  `.planning/task-lifecycle-followups.md`.
- **Round 2 COMPLETE + committed** (7a36871 validator, e9bf686 follow-ups).
  Gates green. **Accuracy gate re-run: 4/4 PASS** (temp collection seeded
  through the NEW lifecycle+chunker code — live smoke of the fixed paths;
  200 parents/596 children, max chunk 1,583 bytes, temp dropped clean).
- **Codex round-2 re-review: NO-GO again, but narrow** (full text
  `scratchpad/codex-round2.log`): blockers 1–4 confirmed substantially fixed,
  MAJORs 6–7 ruled accepted risks. 3 actionable: (1) BLOCKER — workflow never
  guaranteed FORCE_COLLECTION_RECREATE; (2) MAJOR — capped/uncapped prefix
  disagreement in splitOversizedText vs enforceDocByteLimit → reproducible
  throw aborts seed; (3) MINOR — giant-header timeout can't catch sync hang.
- **All 3 fixed + committed**: 363c256 (cap-first fit check, warn dedup;
  subprocess-isolated giant-header probe `__giantHeaderProbe.ts`, spawnSync
  30s SIGKILL) and 7e07953 (update-db.yml workflow_dispatch boolean input
  `force_recreate`; scheduled runs stay additive). Gates re-run green;
  executor's live repro of the old finding-2 scenario now passes.
- **Codex round-3: VERDICT GO** (`scratchpad/codex-round3.log`). All 3
  round-2 findings resolved; 1 new non-blocking MAJOR (expression fallback to
  repo var) fixed immediately per Codex's exact suggestion (dc38f1a).
- **RE-SEED DISPATCHED AND RUNNING**: branch pushed to origin; run
  30529868065 (`update-db.yml` on fix/retrieval-season-hybrid,
  force_recreate=true), started ~12:47 EAT, ETA ~2h. Empirically confirmed
  destructive path engaged: live collection vector11gpt at 0 docs with fresh
  VERIFIED config (dim 1536, dot_product, lexical+rerank enabled). Prod
  retrieval degraded during rebuild (accepted).
- **INCIDENT (~15:00 EAT): first re-seed produced a BROKEN collection.**
  Run 30529868065's createCollection hit the PT30S transient failure,
  collection materialized server-side with definition intact but FIELD
  INDEXES missing — invisible to our definition verification. All filtered
  queries (type/category/parentId) failed CORRUPTED_COLLECTION_SCHEMA →
  BOTH app retrieval paths (hybrid + vector fallback filter on type:"child")
  broken → prod smoke FAILED ("no retrieved context"). Astra: unrepairable,
  recreate only. Cancelled the run (collection unusable, data disposable).
- **Fix shipped (b4db0e3, pushed): `probeFieldIndexes` canary** — after
  definition verify passes, findOne({type:"__index_probe__"}); missing-index
  error shapes → config mismatch → existing recreate-once flow; other errors
  retry 3×5s then THROW (never seed into unverifiable collection).
  **Live-verified against the actual broken collection: correctly rejected**
  (by then replicas were failing LOCAL_QUORUM reads — even deeper breakage).
- **SEED ATTEMPT 2 RUNNING: run 30540848893** (branch, force_recreate=true,
  dispatched ~15:35 EAT, ETA ~17:45). Codex delta review of b4db0e3 running
  in parallel (`scratchpad/codex-round4.log`) — if it finds a material
  defect, cancel the run and remediate.
- **REMAINING after run completes:** run conclusion + logs (expect verified
  drop, clean create, PROBE PASS, failedUrls/duplicated counts, exit 0) →
  filtered-query probe on live collection (`_idxprobe.mts`) → prod smoke
  re-run → synthesis + Fable completion decision → prod redeploy of BRANCH
  code stays a user decision. Helpers (untracked): `_checkdb.mts` (count/
  config), `_idxprobe.mts` (filter health), `_probetest.ts` (createCollection
  guard), `_insertprobe.mts`.
- Design decision logged: blocker 5 gets the cheap rails, NOT the staging-
  collection atomic redesign. MAJORs 6–7 + finding 8 remain open (out of B's
  scope per handoff; disclose to Codex re-review).

---

## Current State

All code gates from the previous handoff went GREEN today, but the final Codex
review returned **NO-GO on the destructive re-seed**. The re-seed was NOT run.
Production was NOT redeployed. Nothing destructive happened this session.

| Area | Status |
|---|---|
| API: season / hybrid / cold-start / categories | ✅ Fixed, verified live (previous session, 0/6 → 4/6) |
| Production `EMBEDDING_DIMENSIONS` 768 → 1536 | ✅ Set in Vercel — **still NOT redeployed, still inert** |
| Chunker: 4 validator failures | ✅ Fixed (`dd86c73`), validator exit 0, independently verified |
| Seed inserts: transient-error retry | ✅ Added (`8f05ab1`), tsc/eslint/validator all green |
| Accuracy gate | ✅ **4/4 vs baseline 3/4** — measured AFTER the rewrite, config-verified temp collection |
| Codex pre-re-seed review | ❌ **NO-GO** — findings below |
| Re-seed (~2h, destructive) | ❌ NOT run — blocked by NO-GO |
| Source research (user request) | ✅ Done → `.planning/research-sources.md` |

---

## Completed this session (all independently verified, not taken from executor reports)

1. **Chunker fixed** (`dd86c73`). All 4 validator failures resolved by a Sonnet
   executor subagent. Root cause beyond the 4 spec bugs: `utf8SafeCut` used
   `chars.indexOf(ch)` to find the cut index — always 0 on repeated characters —
   which caused the cascading 24 KB remainder. Verified myself: `validateChunking`
   exit 0, `tsc --noEmit` clean, `eslint scripts/` 0 errors (4 pre-existing
   htmlScraper warnings only).
2. **Accuracy gate passed: 4/4 vs baseline 3/4** (`_accuracy.ts new`, ~10:30 EAT).
   The previously-failing probe (Arsenal 85-pt standings row intact on one line)
   passes with the new chunking. Max real-corpus chunk: 1,583 bytes (cap 8,000).
   Baseline mode re-confirmed 3/4 against live `vector11gpt` the same morning.
3. **Seed insert retry** (`8f05ab1`): `operations.ts` insertMany batches now retry
   transient Astra errors (max 6, linear backoff 10s–50s); duplicate + size-limit
   handling unchanged; idempotent because duplicate `_id`s are tolerated.
4. **`_accuracy.ts` hardened** (untracked by design): verifies temp-collection
   lexical+rerank config before seeding (drops/recreates if partial), retries
   transient inserts, polls for materialization after server-side create timeouts.
5. **Source research** → `.planning/research-sources.md`. Top picks:
   football-data.org (replaces all 31 soccerway + 3 worldfootball URLs),
   ESPN public JSON API (verified alive today, no key), Wikipedia MediaWiki API
   (replaces 18 HTML scrapes), API-Football free tier (covers the 12 blocked
   URLs + CAF/African gap), openfootball JSON. FotMob & Sofascore ToS PROHIBIT
   scraping — excluded.

---

## Astra serverless failure modes (measured live 2026-07-30 morning — do not re-derive)

- `createCollection` can time out **SERVER-side** (`PT30S`, NOT tunable from the
  client — client `timeout: 180000` did not help) and then **materialize with
  PARTIAL config**: collection exists, but lexical/rerank missing → every
  `findAndRerank` `$hybrid` query fails with "syntactically correct…" errors.
  Always **verify config via `listCollections()` definitions** after create.
- Truncate (`deleteMany({})`) needs ALL replicas: fails with "Truncate failed on
  replica /10.x.x.x"; Astra says safe to retry.
- CAS write timeouts in bursts: `LOCAL_SERIAL 3 replica were required but only 0
  acknowledged`, plus composite `java.lang.NullPointerException`. Every batch
  failed at least once in the flaky window; all succeeded on retry within 10–30s.
- DB stabilized by ~10:15 EAT (clean provisioning round, baseline queries fine).

---

## The NO-GO: Codex findings (full text in `.planning/executor-out*` era ends; verdict reproduced here)

**BLOCKERs**
1. **Table byte-ceiling loop can make ZERO progress → hang/OOM**
   (`markdownChunker.ts:529`): a ~6,999-byte header prefix leaves no room for a
   multibyte code point; re-prepending the header recreates the same remainder
   forever. Codex reproduced a timeout in isolation. (Not triggered by the real
   corpus — max real chunk 1,583 bytes — but a hang mid-seed is catastrophic.)
2. **8,000-byte invariant still breakable via unbounded prefix**
   (`chunking.ts:76`): oversized prefix → oversized `content`/`$lexical`
   (8,074-byte records reproduced); `enforceDocByteLimit` can also DISCARD the
   remainder (adversarial marker vanished from all parents/children).
3. **Failed collection drops are swallowed** (`collection.ts:55`): warn+continue
   on replica/truncate failure → creation finds the surviving collection, checks
   ONLY dimension → seeds into old/wrong-config data. **Matches the live truncate
   failure mode we measured.**
4. **Collection creation neither retried nor post-verified** (`collection.ts:68`,
   `:87`): PT30S partial materialization can leave a broken collection that a
   later run accepts (dimension-only check; metric/lexical/rerank unverified).
   **Matches the live partial-config failure we proved with the temp collection.**
5. **Rebuild is in-place and non-atomic** (`loadDb.ts:273`): orphan parents /
   partial children on mid-run death; no staging collection, rollback, completion
   marker, or expected-count assertion; summary omits `failedUrls`. (Pre-existing
   architecture, not introduced by this branch.)

**MAJORs**
6. Retry triage classifies only the AGGREGATE error message
   (`operations.ts:43`): `CollectionInsertManyError` exposes only the FIRST
   cause — a duplicate-first batch containing a size error records zero skips;
   `recordsAdded` undercounts writes committed by a timed-out attempt (20 stored
   reported as 19).
7. Parent IDs hash unprefixed text (`chunking.ts:127`) while stored content is
   prefixed → same text from two sources collides; second source's children point
   at first source's parent. (Pre-existing.)
8. Destructive mode + 1536 dims are not fail-fast invariants (`env.ts:122`):
   local env has recreate flags UNSET → plain `npm run seed` would seed INTO the
   existing collection, not drop it. (The GitHub workflow sets
   `ALLOW_COLLECTION_RECREATE=true`; local does not.)

**MINOR**
9. The validator passes while missing all of the above (permits truncation at
   `validateChunking.ts:376`; presence-only checks). Also: trailing whitespace at
   `validateChunking.ts:395` and `:589` (`git diff --check` fails).

---

## Decision framework (pre-committed last session, now TRIGGERED)

Last handoff said: review rounds found 11 → 5 → 4 defects; *"if the next round
finds genuinely NEW classes of defect, consider abandoning the custom chunker and
shipping only the API fixes (already proven)."* This round found new CLASSES
(liveness hang, lifecycle atomicity). The rule has triggered — but note the split:

- **Chunker-specific blockers (1, 2)**: adversarial-input bugs; the REAL corpus
  measured clean (1,583-byte max) and accuracy is 4/4. Bounded fix.
- **Lifecycle blockers (3, 4)**: NOT chunker bugs; they exist on `main` too and
  match failure modes we PROVED live. These must be fixed before ANY re-seed,
  custom chunker or not.
- **Blocker 5**: pre-existing architecture; mitigation (staging collection or
  count assertions) is a design choice for the orchestrator.

### Options for next session (orchestrator decision, in rec order)
- **A (recommended): ship the free win first.** `vercel --prod` redeploys with
  `EMBEDDING_DIMENSIONS=1536` → fixes production's vector-level breakage against
  the EXISTING collection with zero re-seed risk. (Deploys current prod codebase;
  the branch's API fixes ship when the branch merges — user's call.)
- **B: fix blockers 1–4 (+ trailing whitespace), strengthen the validator per
  finding 9, re-run validator + accuracy, re-review with Codex, THEN re-seed.**
  Realistic: one focused executor round each for chunker (1–2) and lifecycle (3–4).
- **C: abandon the custom chunker** per the pre-committed rule and re-seed with
  the old chunking once lifecycle blockers 3–4 are fixed. Loses the measured
  4/4-vs-3/4 accuracy gain; keeps the proven API fixes.

---

## Open Flags

- **DO NOT RE-SEED** — NO-GO stands until blockers are resolved and Codex re-reviews.
- **Production still broken** at the vector level until a redeploy ships the
  1536 dimension env var (Option A is free and safe).
- Plain local `npm run seed` would NOT drop the collection anyway (recreate flags
  unset locally — finding 8). The destructive path is the GitHub workflow.
- `_accuracy.ts` stays deliberately untracked; it now contains the hardened
  provisioning logic — don't overwrite it casually.
- `package-lock.json` deletion + `pnpm-lock.yaml` remain pre-existing/unstaged.
- Executor lane note: `dispatch-second.sh` FAILS from this session (already on
  second account) — use a `sonnet-executor` subagent instead (same quota pool).
- Trailing whitespace in `validateChunking.ts` (395, 589) fails `git diff --check`.

---

## Critical Context / gotchas (carried forward + new)

- **Do not trust executor self-reports** — every round this has caught something.
  (This session both executor reports survived independent verification.)
- Astra hibernates; `astra db resume Vector11` before any DB work. DB was flaky
  for ~90 min after resume this morning — build in warm-up tolerance.
- Understat concatenates standings+players+fixtures into ONE doc with three
  `> **Type:**` headers → metadata must stay per-SECTION.
- Scraper decay: 82/105 URLs OK; 11 blocked (403), 3 dead, 4 timeouts; season
  URLs hardcoded `/2024`, `/2025`. Fix path researched →
  `.planning/research-sources.md` (football-data.org, ESPN JSON, MediaWiki API,
  API-Football, openfootball; FotMob/Sofascore prohibited).

---

## Git State

```
branch : fix/retrieval-season-hybrid   (never merged, no push)
commits this session:
  8f05ab1  fix: retry transient Astra errors in seed insert batches
  dd86c73  fix: chunker byte-ceiling loop — cap final flush, header-aware
           table cuts, no content loss
prior:
  b92ad2c  docs: session handoff (2026-07-29)
  9b89101  WIP: hybrid retrieval, season semantics, cold-start, chunking
unstaged (pre-existing, deliberate): D package-lock.json, ?? pnpm-lock.yaml
untracked (ours, deliberate): _accuracy.ts, .planning/*.err noise
```

---

## Resume instruction

```bash
cd /data/Documents/vector11
git log --oneline -2        # expect 8f05ab1, dd86c73
npx tsx scripts/validateChunking.ts   # expect exit 0

# FIRST DECISION (orchestrator): pick Option A / B / C above.
# A is free: vercel --prod   (ships 1536 dims against existing collection)
# B work order:
#   1. spec + dispatch: chunker blockers 1-2  (markdownChunker.ts:529, chunking.ts:76)
#   2. spec + dispatch: lifecycle blockers 3-4 (collection.ts:55/68/87 — verify
#      drop succeeded via listCollections; post-verify created config:
#      dimension+metric+lexical+rerank; retry create)
#   3. strengthen validateChunking per finding 9 (order/count, no truncation carve-out)
#   4. re-run: validator, tsc, eslint, _accuracy.ts new (expect 4/4)
#   5. Codex xhigh re-review → only on GO: astra db resume Vector11 && re-seed
#      via the WORKFLOW path (it sets ALLOW_COLLECTION_RECREATE=true), then vercel --prod
```

**Next single action:** decide A/B/C. Recommendation: A immediately (free,
unbreaks prod), then B (the accuracy gain is real and the blocker fixes are
bounded).
