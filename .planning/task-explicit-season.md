# Task: football-data.org — explicit season requests with not-started fallback

Repo: /data/Documents/vector11, branch `feat/source-migration`.

## Hard rules
- No git commands. Files: `scripts/lib/scrapers/apiFetchers.ts` and
  `scripts/validateSources.ts` ONLY. No new deps.

## Context (from the previous round's evidence)
football-data.org's DEFAULT `/v4/competitions/{code}/standings` is internally
inconsistent in summer: `season.startDate` already points at the NEW season
(2026-08-21, currentMatchday 1) while the standings table is still the
COMPLETE previous season (all playedGames 38). No response field reliably
labels the table's true season on the default alias. BUT explicit
`?season=2025` returns a self-consistent response (verified live on the free
tier: correct startDate, matchday 38, same table).

## Fix (deterministic, no heuristics)
In `fetchFootballDataOrg`:
1. Compute `y = currentSeasonStartYear()`. Request standings with explicit
   `?season=${y}`.
2. If the response is missing/empty OR every row's `playedGames` is 0 (season
   not started — zero information), fetch `?season=${y-1}` instead and use
   that response. One log line when falling back.
3. Scorers: request with the SAME explicit season year that standings settled
   on. If the scorers response is empty, omit the scorers section (don't fail).
4. Labeling: keep the previous round's season-from-response derivation
   (startDate) — with explicit requests it is now consistent by construction.
   The title line and section headers must reflect the season actually
   fetched.
5. Free-tier caution: explicit `?season=` for the previous season is
   confirmed working (live-verified last round). If a 403-style "restricted"
   error ever comes back for a season param, treat as null (existing
   never-throw plumbing) — do not retry other years.
- validateSources: add fixtures for (a) requested-season-not-started → fallback
  chosen, previous season's label used; (b) requested season has data → no
  fallback. Factor the "is this standings response empty/not-started" decision
  into a small exported pure helper so it's testable without mocking fetch.

## Verification
- tsc clean, eslint 0 errors, validateSources/validateChunking/validatePrompts exit 0.
- Live: run the `_keytest.ts` pattern with the .env key — expect the returned
  markdown to be the 2025/26 final table labeled **2025/26** (since 2026/27
  hasn't started). Show first 8 lines.

## Report: DONE/BLOCKED · changes · live snippet · gates.
