# Task: Season labels must come from the API response, not the clock

Repo: /data/Documents/vector11, branch `feat/source-migration` (checked out).

## Hard rules
- No git commands. Files: `scripts/lib/scrapers/apiFetchers.ts` and
  `scripts/validateSources.ts` ONLY. No new deps. Match style.

## Bug (live-reproduced just now)
`fetchFootballDataOrg("PL", ..., key)` returned the CONCLUDED 2025/26 final
standings (Arsenal 85 pts) but the markdown header said `**Season:** 2026/27`
— the converter stamps `seasonString(currentSeasonStartYear())` instead of
reading the season the response actually describes. football-data.org keeps
serving the finished season as "current" until the new one kicks off, so
every summer window would ingest season-mislabeled standings. Same risk
pattern exists in the API-Football converter (we pass the year in, but the
response echoes its own `league.season`).

## Fix
1. `footballDataOrgStandingsToMarkdown` / `footballDataOrgScorersToMarkdown`:
   the v4 response carries a top-level `season` object with `startDate`
   ("2025-08-15"). Derive startYear from `season.startDate`'s year when
   present (defensively — `?.`, invalid date → fallback) and use
   `seasonString(thatYear)` for the header AND the title line. Fallback:
   current behavior.
2. `apiFootballStandingsToMarkdown`: prefer `response[].league.season` (a
   number, e.g. 2025) from the response over the passed-in season, same
   defensive fallback.
3. ESPN converters: check whether the standings/scoreboard responses carry a
   season year field (`season.year` exists on ESPN responses). If present,
   prefer it, same pattern. (ESPN currently returns the NEW season with
   zeroed rows, so this is consistency, not a live bug.)
4. validateSources: update/add fixtures so each of these converters is fed a
   response whose embedded season DIFFERS from the current date's computed
   season, asserting the header shows the RESPONSE's season. Keep all
   existing tests passing (adjust any that asserted the computed-season
   behavior).

## Verification
- `npx tsc --noEmit` clean; `npx eslint scripts/` 0 errors;
  `npx tsx scripts/validateSources.ts` exit 0 (show new test lines);
  `validateChunking.ts` + `validatePrompts.ts` exit 0.
- Live re-check: run fetchFootballDataOrg PL with the key from .env
  (dotenv, like the throwaway pattern in `_keytest.ts` at repo root) and show
  the first 8 lines — header must now say 2025/26 while that's what the API
  serves.

## Report: DONE/BLOCKED · changes per converter · live snippet · gate outputs.
