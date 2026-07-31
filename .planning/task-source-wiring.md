# Task B: Wire API sources into the seed pipeline; retire dead scrapes; dynamic seasons

Repo: /data/Documents/vector11, branch `feat/source-migration` (checked out — work in place).
Prereq: Task A landed `scripts/lib/scrapers/apiFetchers.ts` (read it first for
the actual exports) and `scripts/validateSources.ts`. Research context:
`.planning/research-sources.md`.

## Hard rules
- Do NOT run any git commands.
- Files you may modify: `scripts/lib/config/dataSources.ts`,
  `scripts/loadDb.ts`, `scripts/lib/config/env.ts`,
  `scripts/lib/config/dataSources.ts`. You may NOT modify
  `apiFetchers.ts` (escalate in your report if its interface doesn't fit),
  `htmlScraper.ts`, chunking, or database modules.
- Live network calls allowed only for final verification (a bounded seed
  dry-run — see Verification). No destructive DB flags.
- No new dependencies. Match existing code style.

## Changes

### 1. `SourceItem` type + dispatch (`dataSources.ts` + `loadDb.ts`)
- Extend the `SourceItem` type with the new `type` values:
  `"espn-api" | "wikipedia-api" | "openfootball" | "football-data-api" | "api-football"`,
  plus optional fields the fetchers need (e.g. `leagueName`, `leagueCode`,
  `wikiTitle`, `leaguePath`, `competitionCode`, `apiLeagueId` — mirror
  apiFetchers' actual signatures; keep it minimal).
- In `loadDb.ts`'s per-URL loop: the guard
  `if (isBlocked(url) || !isLikelyHtml(url))` MUST NOT skip the new API
  types — API URLs end in .json or contain /api/ and would be skipped today.
  Route the new types to their fetchers in the same `withRetry` block where
  understat/soccerway types dispatch. A fetcher returning null → count as
  skipped (existing skip path), not failed.
- KEY-GATED types (`football-data-api`, `api-football`): read the key from
  config/env (see §3); if the key is absent, log ONE line per run (not per
  URL) like `[sources] FOOTBALL_DATA_API_KEY not set — skipping N
  football-data.org sources` and count those as skipped.

### 2. Source list changes (`dataSources.ts`)
- REMOVE the 12 permanently-403 entries: all fbref.com (6), worldfootball.net
  (3), soccerstats.com (3). Leave a short comment noting why + the
  replacement source.
- REPLACE the 5 espn.com HTML entries with `espn-api` entries (standings +
  scoreboard per the fetchers' supported league codes).
- REPLACE the 18 Wikipedia HTML entries with `wikipedia-api` entries carrying
  the same article titles (`wikiTitle`). Titles containing a season year
  (e.g. "2024–25_Premier_League") must be made DYNAMIC: compute from
  `currentSeasonStartYear()`/`seasonString()` (Task A helpers) so they roll
  automatically — e.g. title template `${startYear}–${(startYear+1)%100}_Premier_League`
  (note the en-dash Wikipedia uses).
- ADD `openfootball` entries for the big-5 leagues, current season.
- ADD key-gated `football-data-api` entries (PL, PD, SA, BL1, FL1, CL) and
  `api-football` entries (AFCON league 6, CAF Champions League league 12 —
  the African coverage gap; big-5 only if request budget allows: free tier is
  100 req/day, each entry = 1-2 requests, stay well under).
- UNDERSTAT dynamic seasons: replace each league's hardcoded `/2024` and
  `/2025` entries with entries computed from
  `understatSeasonPath(currentSeasonStartYear())` (current) and
  `understatSeasonPath(currentSeasonStartYear() - 1)` (previous). The bare
  no-year URL entries stay as-is. Source labels follow the computed year.
- Soccerway entries: LEAVE AS-IS this round (deliberate — they still partly
  work; removal happens once football-data.org key is active).

### 3. `env.ts`
- Add OPTIONAL env vars `FOOTBALL_DATA_API_KEY` and `API_FOOTBALL_KEY`
  (string | undefined; no validation failure when absent) following the
  existing optional-var pattern in that file.

### 4. GitHub workflow (`.github/workflows/update-db.yml`) — yes you may edit
  this one file too: pass the two new secrets through as env
  (`${{ secrets.FOOTBALL_DATA_API_KEY }}` etc.) so they activate once Ian
  adds them in repo settings. Missing secrets = empty string = key absent
  path (verify empty string is treated as absent in your env.ts handling).

## Verification (run all; report outputs)
- `npx tsc --noEmit` → clean. `npx eslint scripts/` → 0 errors.
- `npx tsx scripts/validateSources.ts` and `validateChunking.ts` → exit 0.
- `npx tsx scripts/validatePrompts.ts` → exit 0.
- Bounded LIVE dry-run of the pipeline WITHOUT touching the real collection:
  `MAX_SCRAPE_URLS=6 ASTRA_DB_COLLECTION=source_migration_smoke npx tsx scripts/loadDb.ts`
  is NOT acceptable (it would create a collection). Instead add NOTHING to
  the codebase: write a THROWAWAY script in
  /tmp/claude-1000/-data-Documents-vector11/4b2b3f24-e0b1-498b-8293-7f8b5fd7c105/scratchpad/
  that imports the wired dispatch pieces OR directly calls each new fetcher
  with the exact args now carried by dataSources entries (one per source
  type: espn-api, wikipedia-api, openfootball) and prints: URL/args, first 10
  lines of markdown, byte length. Include that output in the report. If the
  local network blocks a host, note it explicitly.
- Confirm with grep that no fbref/worldfootball/soccerstats entries remain,
  and no hardcoded `/2024`/`/2025` Understat URLs remain.

## Report format (short)
DONE/BLOCKED · summary of dataSources delta (counts: removed/replaced/added) ·
dispatch changes · dry-run snippets · gate outputs.
