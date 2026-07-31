# Task: Corpus-driven suggested prompts, refreshed by the weekly seed

Repo: /data/Documents/vector11, branch `feat/weekly-prompt-refresh` (already checked out — work in place).

## Goal
The UI's suggested questions (`CONTEXT_PROMPTS` in `app/lib/constants.ts`,
rotated by `app/lib/hooks/usePromptRotation.ts`) are static and say "this
season". They must instead be REGENERATED on every weekly seed from what the
corpus actually contains (concrete season like "2025/26", the leagues present,
and a few real facts like champions/top scorers), stored in Astra, and served
to the UI — so when the corpus rolls to a new season, the questions follow
automatically.

## Hard rules
- Do NOT run any git commands.
- No live Astra DB calls (code only; orchestrator verifies live later).
- Files you may create/edit ONLY:
  - `scripts/lib/utils/promptGenerator.ts` (new)
  - `scripts/loadDb.ts` (integration)
  - `app/api/prompts/route.ts` (new)
  - `app/lib/hooks/usePromptRotation.ts` (fetch + fallback)
  - `app/lib/constants.ts` (only if you need to export types/helpers; keep the
    static list as the fallback — do not delete it)
- Match existing code style. No new dependencies.

## Design (follow this; escalate in your report if something doesn't fit)

### 1. `scripts/lib/utils/promptGenerator.ts` (new, pure, deterministic)
```ts
export interface CorpusFacts {
  season: string;            // e.g. "2025/26" — as it appears in corpus metadata
  leagues: string[];         // e.g. ["EPL", "La Liga", "Serie A", ...]
  champions?: Record<string, string>;   // league -> team, when known
  topScorers?: Record<string, { player: string; goals?: number }>; // league -> scorer
}
export const generatePrompts = (facts: CorpusFacts): string[]
```
- Deterministic template instantiation, NO LLM calls. Produce ~50–70 prompts.
- Mix: (a) season-named variants of the existing static themes ("What were the
  final {season} EPL standings…", "Who were the top scorers in the {season}
  EPL?"), (b) fact-based ones when facts are present ("How many points did
  {champion} win the {season} Premier League with?", "How many goals did
  {topScorer} score in {season}?"), (c) cross-league comparisons for league
  pairs actually present, (d) a few evergreen data-shape questions (xG, xPTS,
  clean sheets) tagged with the season.
- Only generate league-specific prompts for leagues in `facts.leagues`.
- De-duplicate; stable order (rotation randomness stays client-side).

### 2. Seed integration — `scripts/loadDb.ts`
- During the existing Understat processing, season strings and league names
  are already extracted into doc metadata (the `> **Type:** … **League:** …
  **Season:** …` headers built by the scrapers). Capture, with MINIMAL
  restructuring: the set of league names seeded and the most common season
  string. If champions/top scorers are cheaply derivable from the Understat
  parsed structures already in memory (standings arrays exist — first row =
  champion for a completed season; players arrays sorted by goals), populate
  `champions`/`topScorers` for EPL + La Liga; if that requires invasive
  refactoring, skip facts (they're optional) and note it.
- AFTER the seed summary + count assertion (so counters/assertions are
  untouched), on the success path only: build prompts via `generatePrompts`
  and upsert ONE doc into the same collection:
  `{ _id: "meta:suggested-prompts", type: "meta", season, leagues, prompts,
  generatedAt: new Date().toISOString() }` using `replaceOne(..., { upsert:
  true })`. Wrap in try/catch — a prompt-upsert failure must WARN, not fail
  the seed (do not touch process.exitCode there).
- Retrieval safety: chat retrieval filters on `type: "child"` (and parent
  lookups by `_id`), so a `type: "meta"` doc is invisible to it. State in a
  short comment. The doc has no `$vector`/`$lexical` — verify inserting
  without them is fine (it is for Astra collections).

### 3. `app/api/prompts/route.ts` (new)
- GET handler, follows the DB client patterns used in `app/api/chat/route.ts`
  (same env vars / DataAPIClient usage).
- Reads `findOne({ _id: "meta:suggested-prompts" })`. Success → JSON
  `{ prompts, season, generatedAt, fallback: false }` with
  `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`.
- ANY error or missing doc → static `CONTEXT_PROMPTS` with `fallback: true`,
  same caching. Never 500 — prompts are cosmetic; do not retry/resume the DB
  here (a cold DB just serves the fallback).

### 4. `app/lib/hooks/usePromptRotation.ts`
- On mount, fetch `/api/prompts` (AbortController, ignore errors). If it
  returns a non-empty prompts array, use it as the rotation pool; otherwise
  keep `CONTEXT_PROMPTS`. Rotation/refresh behavior otherwise unchanged.

## Verification (run all; report outputs)
- `npx tsc --noEmit` → clean.
- `npx eslint scripts/ app/` → 0 errors (pre-existing warnings OK).
- `npx tsx scripts/validateChunking.ts` → exit 0 (regression).
- Generator dry-run: THROWAWAY script in
  `/tmp/claude-1000/-data-Documents-vector11/4b2b3f24-e0b1-498b-8293-7f8b5fd7c105/scratchpad/`
  calling `generatePrompts` with representative facts (season "2025/26",
  leagues incl. EPL/La Liga, champion + scorer facts) AND with a minimal
  facts object (no champions/topScorers, 1 league) — print counts + first 10
  prompts of each; confirm no "undefined" leakage and league filtering works.
- `npx next build` → succeeds (proves the new route + hook compile in Next).

## Report format (short)
DONE/BLOCKED · files changed · how season/league/facts capture works in
loadDb (3–5 lines) · dry-run sample (10 prompts) · verification outputs.
