# Handoff — Opus 5 — vector11 / retrieval + season + chunking fix

**Date:** 2026-07-29, ~20:30 EAT
**Branch:** `fix/retrieval-season-hybrid` (branched from `main`)
**Last commit:** `9b89101` — WIP checkpoint, deliberately amber (see Open Flags)

---

## Current State

The app was failing **every** user query. Root-caused to 5 stacked bugs, not one.
Four are fixed and verified live. The fifth (chunking) is committed but **not green** —
4 validator failures block the re-seed.

| Area | Status |
|---|---|
| API: season / hybrid / cold-start / categories | ✅ Fixed, verified live (0/6 → 4/6) |
| Production `EMBEDDING_DIMENSIONS` 768 → 1536 | ✅ Changed & verified — **NOT redeployed** |
| Seed pipeline: table-aware chunking + `$lexical` | ⚠️ Committed, 4 validator failures |
| Re-seed (~2h, destructive) | ❌ NOT run — blocked on the above |

---

## Completed (all independently verified, not taken from executor reports)

### 1. API fixes — `app/api/chat/route.ts`
Measured on 6 live queries: **0/6 → 4/6 correct**, 2/6 partial.

- **Season semantics.** App computed "current season = 2026-27" while the newest data
  anywhere is 2025-26 (verified: `understat.com/league/EPL/2026` redirects to 2025).
  The prompt rule "say it is unavailable" then fired on every query. Now: 2025-26 is
  the latest COMPLETE season; never refuse just because a not-yet-started season is empty.
  10 boundary dates unit-tested incl. the Aug 1–7 gap.
- **Hybrid retrieval.** Replaced cosine + `gpt-5-mini` reranker with Astra
  `findAndRerank` + `$hybrid` + the collection's NVIDIA reranker.
  Measured discrimination on the correct standings table: **+20.48 vs −0.78**,
  where cosine gave 0.899 vs 0.884 (indistinguishable). Old LLM rerank call deleted.
  Pure-vector path retained as fallback.
- **Cold start.** Astra resumes in TWO stages: ~19s of HTTP 400 "resuming", then reads
  failing with `UNAVAILABLE_DATABASE` / `LOCAL_QUORUM`. Old retry budget was 9s and
  matched stage 1 only. Now covers both and returns an honest **503** instead of
  answering confidently with empty context. `maxDuration = 60` added.
- **Categories.** `playerPerformance` had **0 documents** but was filtered on constantly.
  Aligned to real DB categories; `reference`(1567) / `soccerwayForm`(214) / `rss`(88)
  are no longer unreachable.

### 2. Production dimension fix (highest-value, free)
Verified via Vercel CLI, not assumed:
```
BEFORE: EMBEDDING_DIMENSIONS="768"     ← every prod query broken at the vector level
AFTER:  EMBEDDING_DIMENSIONS="1536"    ← pulled back and confirmed
```
Set on Production, Preview AND Development. Added with `--no-sensitive` so it stays
auditable. **Requires a redeploy to take effect — not done.**

### 3. Tooling
- **Astra CLI v1.1.0** at `~/.astra/cli/astra`, profile `vector11` is default.
  `astra setup` cannot run non-interactively — use `astra config create <name> -t @file`.
  `describe-collection` does NOT expose vector dimension; use the SDK.
- **Vercel CLI 58.3.0**, project linked (`ian-odhaimbos-projects/vector11`).
  ⚠️ `vercel link` writes `.env.local` with secrets into the repo — gitignored by `.env*`,
  but delete it anyway. Pull env to a temp dir OUTSIDE the repo.

### 4. Measured facts about Astra (established by live testing — do not re-derive)
- Collection `vector11gpt`: **1536 dims, dot_product, lexical + rerank ENABLED**.
- **Astra rejects any indexed String field over 8,000 BYTES.** `content` and `$lexical`
  are both indexed → both capped. Worst UTF-8 ratio in this corpus: **1.473 bytes/char**,
  so the ceiling hits at ~5,429 chars.
- Writing `$lexical` activates BM25 (`$bm25Rank` goes from `null` → a real rank).
- New chunking yields **1.73× more documents** (211 → 364 for Understat EPL);
  collection would go ~10,209 → ~17,700. Fine for Astra.
- Cold resume measured at **18.7s** to first success.

---

## Remaining — the ONE blocking task

`npx tsx scripts/validateChunking.ts` → **4 failures**. Spec already written:
**`.planning/task-chunker-final.md`** (precise, with reproductions). All four trace to the
"last-line defence" byte-ceiling loop at the end of `splitMarkdownAware`
(`scripts/lib/utils/markdownChunker.ts`, ~lines 448-472):

1. **Final flush is uncapped (CRITICAL).** Trailing `pendingText` is pushed without
   `utf8SafeCut` → produced a **24,046-byte chunk**, which Astra would reject outright.
   Must loop: one cut = one chunk, so a 24 KB remainder needs 4 chunks.
2. **Per-chunk cut is single-pass** — make it a `while` loop.
3. **Content loss at `overlap=0`** — reproduce:
   `splitMarkdownAware("a".repeat(399) + "😀" + " tail text", 400, 0)`
   → stripped input 409 chars, output 401; `" tail text"` vanishes.
   Cause: the trailing branch is guarded by `processedChunks.length > 0` and `.trim()`.
4. **Byte-cut table pieces lose their header** — the ceiling pass is generic text surgery
   and header-unaware. Must re-use `packTableRows`/`buildPiece` so continuation pieces
   repeat the header.

---

## Open Flags

- **DO NOT RE-SEED** until the validator exits 0. A re-seed drops ~10,000 docs and rebuilds
  over ~2 hours; bug #1 alone would cause insert rejections mid-run.
- **Production not redeployed.** The 768→1536 fix is inert until `vercel --prod`.
- **`_accuracy.ts`** (repo root, untracked) is the retrieval-accuracy harness.
  `npx tsx _accuracy.ts baseline` → live collection. `npx tsx _accuracy.ts new` → builds a
  temp collection with the new chunking, measures, drops it. **Baseline was 3/4; new chunking
  measured 4/4** — but that was measured BEFORE the rewrite. **Must be re-run after the
  chunker is green.**
- **Executor lanes:** second account quota reset at 8pm EAT. Last Sonnet dispatch failed with
  `API Error: ENOTFOUND` (network, not quota) — simply retry.
- **GLM-4.7 made the chunker WORSE** (4 failures → 7). Reverted via
  `git checkout -- scripts/lib/utils/markdownChunker.ts`. Prefer Sonnet for this work.
- **`package-lock.json` deletion and `pnpm-lock.yaml`** were pre-existing at session start —
  deliberately NOT staged, so this branch doesn't absorb unrelated changes.
- Codex review found and I confirmed: 3 rounds of chunker review found 11 → 5 → 4 defects.
  If the next round finds genuinely NEW classes of defect, consider abandoning the custom
  chunker and shipping only the API fixes (already proven).

---

## Critical Context / gotchas

- **Do not trust executor self-reports.** Every round, verification caught something the
  report claimed was done. Two of my own test harnesses also produced FALSE GREENS:
  a ground-truth regex that read Arsenal's points as `"7"` (so everything "passed"), and
  GLM writing `c.text.includes("")` — an empty string, which every string contains.
- **Astra hibernates.** Run `astra db resume Vector11` BEFORE seeding rather than relying on
  retry logic.
- Understat concatenates standings + player stats + fixtures into ONE document with three
  `> **Type:**` headers — this is why metadata must be per-SECTION, not per-document.
- Scraper decay (unaddressed): of 105 source URLs, **82 OK / 11 blocked (403: fbref,
  worldfootball, soccerstats) / 3 dead / 4 timeouts**. Season URLs are hardcoded to
  `/2024`, `/2025` — nothing rolls forward.

---

## Git State

```
branch : fix/retrieval-season-hybrid
commit : 9b89101  "WIP: hybrid retrieval, season semantics, cold-start handling,
                   table-aware chunking"   (26 files, +3709/-305)
clean  : yes, except intentionally-unstaged pre-existing changes:
           D package-lock.json     (pre-existing, not ours)
           ?? pnpm-lock.yaml       (pre-existing, not ours)
           ?? _accuracy.ts         (our test harness, keep untracked or commit separately)
           ?? .planning/*.err      (executor stderr logs, noise)
```
Never merged to `main`. No push.

---

## Resume instruction

```bash
cd /data/Documents/vector11
git log --oneline -1                      # expect 9b89101
npx tsx scripts/validateChunking.ts       # expect 4 failures

# 1. Fix the chunker — spec is already written and precise:
~/.claude/scripts/dispatch-second.sh \
  -o .planning/executor-out9.md \
  -f .planning/task-chunker-final.md \
  -C /data/Documents/vector11

# 2. Verify (must ALL pass before anything else)
npx tsc --noEmit
npx eslint scripts/
npx tsx scripts/validateChunking.ts       # MUST exit 0
npx tsx _accuracy.ts new                  # MUST still be 4/4

# 3. Commit the green checkpoint immediately (an earlier good state was lost
#    to an overwrite because it was never committed)

# 4. Codex review before the destructive step
codex exec -c model_reasoning_effort=xhigh --sandbox read-only \
  "Final pre-re-seed review of scripts/ ... GO or NO-GO"

# 5. Only on GO:
astra db resume Vector11                  # avoid the 19s cold start
npm run seed                              # ~2 HOURS, drops+rebuilds ~10k docs
vercel --prod                             # ships the 768->1536 dimension fix too
```

**Next single action:** re-dispatch `.planning/task-chunker-final.md` to Sonnet
(the last attempt died on a network error, not a logic problem).
