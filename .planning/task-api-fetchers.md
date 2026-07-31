# Task A: API fetchers module (zero-key + key-gated) for the seed pipeline

Repo: /data/Documents/vector11, branch `feat/source-migration` (checked out — work in place).
Background research: `.planning/research-sources.md` (read it first).

## Hard rules
- Do NOT run any git commands.
- Files: create `scripts/lib/scrapers/apiFetchers.ts` and
  `scripts/validateSources.ts`; you may READ any file; do not modify any
  existing file (the wiring into loadDb/dataSources is a separate task).
- Live network calls ARE allowed here ONLY for your own spot verification of
  endpoint shapes (curl/fetch a sample response once, keep it as a fixture);
  the committed tests must run OFFLINE on embedded fixtures.
- No new dependencies. Match existing code style.

## Output format contract (critical)
Every fetcher returns `Promise<string | null>` — a markdown document in the
corpus house format, or null on no-data. House format (see
`scripts/lib/scrapers/htmlScraper.ts` Understat builders for reference):
- Title line: `# <Competition> <Season>`
- Header line: `> **Type:** <Standings|Fixtures|Results|Mixed>  |  **League:** <League>  |  **Season:** <YYYY/YY>`
- Tables as markdown tables; sections split by `## ` headings, each section
  repeating its own `> **Type:** …` header line (the chunker resolves
  metadata per-SECTION — this matters).
- League names must be ones `normalizeLeagueName` in
  `scripts/lib/utils/promptGenerator.ts` maps (e.g. "Premier League",
  "La Liga", "Champions League", "AFCON").

## Deliverables in `apiFetchers.ts`

1. **Season helpers** (exported, pure):
   - `currentSeasonStartYear(now?: Date): number` — European season boundary:
     from July 1st onward the season start year is the current year, before
     that it's the previous year. (July, not August, so pre-season summer
     content lands in the upcoming season.)
   - `seasonString(startYear: number): string` → `"2025/26"`.
   - `understatSeasonPath(startYear: number): string` → `"2025"` (Understat
     uses bare start year).

2. **ESPN JSON API** (no key):
   - `fetchEspnStandings(leagueCode: string, leagueName: string): Promise<string | null>`
     via `https://site.api.espn.com/apis/v2/sports/soccer/{code}/standings`
     and `fetchEspnScoreboard(...)` via
     `https://site.api.espn.com/apis/site/v2/sports/soccer/{code}/scoreboard`.
   - League codes: eng.1, esp.1, ita.1, ger.1, fra.1, uefa.champions,
     caf.nations (verify each code you ship actually responds — drop any that
     404 and note it in the report).
   - Separate the pure converter (`espnStandingsToMarkdown(json, leagueName, season)`)
     from the fetch so tests run on fixtures.

3. **Wikipedia MediaWiki API** (no key):
   - `fetchWikipediaArticle(title: string, leagueName: string, category: string): Promise<string | null>`
     using `action=parse&page={title}&prop=text&format=json&formatversion=2`.
   - Convert the returned HTML fragment: reuse the existing cheerio-based
     table/paragraph conversion from `htmlScraper.ts` IF its functions are
     exported; if they are not exported, implement a minimal local
     cheerio conversion (tables → markdown tables, paragraphs → text,
     strip refs/citations `[1]`-style, cap at ~40k chars) — do NOT modify
     htmlScraper.ts.
   - Derive Season for the header from the title when it contains one
     (e.g. "2025–26 Premier League" → "2025/26"), else use current season.

4. **openfootball JSON** (no key):
   - `fetchOpenfootball(leaguePath: string, leagueName: string, startYear: number)`
     via `https://raw.githubusercontent.com/openfootball/football.json/master/{season-folder}/{league}.json`
     (season folder format `2025-26` — verify against the repo layout and
     adjust; if a file is absent return null quietly).
   - Converter: matchday fixtures/results → `## Matchday N` sections with
     result tables.

5. **football-data.org** (KEY-GATED):
   - `fetchFootballDataOrg(competitionCode: string, leagueName: string, apiKey: string)`
     — standings + scorers via `https://api.football-data.org/v4/competitions/{code}/standings`
     and `/scorers`, header `X-Auth-Token`. Competition codes: PL, PD, SA,
     BL1, FL1, CL.
   - Do NOT call it live (no key exists yet). Build converters from the
     documented response shape (see their docs; fixture JSON hand-built from
     the documented schema is fine — mark it as such).
6. **API-Football (api-sports.io)** (KEY-GATED):
   - `fetchApiFootball(leagueId: number, leagueName: string, season: number, apiKey: string)`
     — standings via `https://v3.football.api-sports.io/standings?league={id}&season={year}`,
     header `x-apisports-key`. League ids: 39 EPL, 140 La Liga, 135 Serie A,
     78 Bundesliga, 61 Ligue 1, 2 UCL, 6 AFCON, 12 CAF Champions League.
   - Same fixture-based converter approach; no live calls.

7. **Shared plumbing**: one `fetchJson(url, headers?, timeoutMs = 15000)`
   helper with AbortController timeout; on non-200 log a one-line warn and
   return null (callers treat null as no-data). NEVER throw out of a fetcher —
   a dead endpoint must not kill a seed run.

## `scripts/validateSources.ts` (offline, fixture-based; style of validateChunking.ts)
- Season helpers: boundary tests (Jun 30 → previous year, Jul 1 → current).
- Each converter: embedded fixture JSON → assert markdown contains the house
  header line (Type/League/Season), at least one table row, league name that
  `normalizeLeagueName` (import it) maps to a known code, and no "undefined"/
  "null" substrings.
- Exit non-zero on failure; per-test output lines.

## Verification (run all; report outputs)
- `npx tsc --noEmit` → clean. `npx eslint scripts/` → 0 errors.
- `npx tsx scripts/validateSources.ts` → exit 0 (show output).
- ONE live spot check per zero-key source (ESPN standings eng.1, one
  Wikipedia title "2025–26 Premier League", one openfootball file): print
  first 15 lines of each produced markdown in the report. If a fetch fails
  from this network, say so explicitly (do not fake it).
- `npx tsx scripts/validateChunking.ts` → exit 0 (regression).

## Report format (short)
DONE/BLOCKED · exported functions list · fixture sources used · live spot-check
snippets (or explicit network-failure note) · gate outputs.
