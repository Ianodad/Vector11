// Standalone, offline validation for the API fetchers module
// (scripts/lib/scrapers/apiFetchers.ts). Runs entirely on embedded fixture
// JSON/HTML — no network, no DB. Style mirrors scripts/validateChunking.ts.
// Run with: npx tsx scripts/validateSources.ts
import {
  currentSeasonStartYear,
  seasonString,
  understatSeasonPath,
  espnStandingsToMarkdown,
  espnScoreboardToMarkdown,
  wikipediaHtmlToMarkdown,
  openfootballToMarkdown,
  footballDataOrgStandingsToMarkdown,
  footballDataOrgScorersToMarkdown,
  apiFootballStandingsToMarkdown,
} from "./lib/scrapers/apiFetchers.js";
import { normalizeLeagueName } from "./lib/utils/promptGenerator.js";

type Failures = string[];

// ── Shared assertions ───────────────────────────────────────────────────────

const assertHouseHeaderLine = (md: string, failures: Failures, label: string): void => {
  const headerLineRe =
    /^>\s*\*\*Type:\*\*\s*(Standings|Fixtures|Results|Mixed)\s*\|\s*\*\*League:\*\*[^|]+\|\s*\*\*Season:\*\*/m;
  if (!headerLineRe.test(md)) {
    failures.push(`${label}: missing house header line (Type/League/Season)`);
  }
};

const assertHasTableRow = (md: string, failures: Failures, label: string): void => {
  const tableRowRe = /^\|.*\|.*\|/m;
  if (!tableRowRe.test(md)) {
    failures.push(`${label}: no markdown table row found`);
  }
};

const assertLeagueNameMaps = (leagueName: string, failures: Failures, label: string): void => {
  const mapped = normalizeLeagueName(leagueName);
  const knownCodes = new Set([
    "EPL",
    "La Liga",
    "Serie A",
    "Bundesliga",
    "Ligue 1",
    "Champions League",
    "Europa League",
    "AFCON",
  ]);
  if (!knownCodes.has(mapped)) {
    failures.push(`${label}: league name "${leagueName}" does not map to a known code (got "${mapped}")`);
  }
};

const assertNoUndefinedOrNull = (md: string, failures: Failures, label: string): void => {
  if (/\bundefined\b/.test(md) || /\bnull\b/.test(md)) {
    failures.push(`${label}: output contains "undefined"/"null" substring`);
  }
};

const runHouseFormatChecks = (md: string | null, leagueName: string, label: string): Failures => {
  const failures: Failures = [];
  if (!md) {
    failures.push(`${label}: converter returned null for a fixture that should produce output`);
    return failures;
  }
  assertHouseHeaderLine(md, failures, label);
  assertHasTableRow(md, failures, label);
  assertLeagueNameMaps(leagueName, failures, label);
  assertNoUndefinedOrNull(md, failures, label);
  return failures;
};

// ── Season helpers ───────────────────────────────────────────────────────────

const runSeasonHelperTests = (): Failures => {
  const failures: Failures = [];

  // Jun 30 -> previous year is the season start year.
  const juneThirty = new Date(Date.UTC(2026, 5, 30)); // month index 5 = June
  const juneStart = currentSeasonStartYear(juneThirty);
  if (juneStart !== 2025) {
    failures.push(`currentSeasonStartYear(Jun 30 2026) expected 2025, got ${juneStart}`);
  }

  // Jul 1 -> current year is the season start year.
  const julyFirst = new Date(Date.UTC(2026, 6, 1)); // month index 6 = July
  const julyStart = currentSeasonStartYear(julyFirst);
  if (julyStart !== 2026) {
    failures.push(`currentSeasonStartYear(Jul 1 2026) expected 2026, got ${julyStart}`);
  }

  // Boundary sanity: a date deep in the season (Jan) still resolves to the
  // year the season started, not the calendar year.
  const januaryMid = new Date(Date.UTC(2026, 0, 15));
  const janStart = currentSeasonStartYear(januaryMid);
  if (janStart !== 2025) {
    failures.push(`currentSeasonStartYear(Jan 15 2026) expected 2025, got ${janStart}`);
  }

  if (seasonString(2025) !== "2025/26") {
    failures.push(`seasonString(2025) expected "2025/26", got "${seasonString(2025)}"`);
  }
  if (seasonString(2009) !== "2009/10") {
    failures.push(`seasonString(2009) expected "2009/10", got "${seasonString(2009)}"`);
  }
  if (understatSeasonPath(2025) !== "2025") {
    failures.push(`understatSeasonPath(2025) expected "2025", got "${understatSeasonPath(2025)}"`);
  }

  return failures;
};

// ── ESPN standings ───────────────────────────────────────────────────────────

const espnStandingsFixture = {
  children: [
    {
      name: "Premier League",
      standings: {
        entries: [
          {
            team: { displayName: "Arsenal" },
            stats: [
              { name: "rank", displayValue: "1" },
              { name: "gamesPlayed", displayValue: "10" },
              { name: "wins", displayValue: "7" },
              { name: "ties", displayValue: "2" },
              { name: "losses", displayValue: "1" },
              { name: "pointsFor", displayValue: "20" },
              { name: "pointsAgainst", displayValue: "8" },
              { name: "pointDifferential", displayValue: "12" },
              { name: "points", displayValue: "23" },
            ],
          },
          {
            team: { displayName: "Liverpool" },
            stats: [
              { name: "rank", displayValue: "2" },
              { name: "gamesPlayed", displayValue: "10" },
              { name: "wins", displayValue: "6" },
              { name: "ties", displayValue: "3" },
              { name: "losses", displayValue: "1" },
              { name: "pointsFor", displayValue: "18" },
              { name: "pointsAgainst", displayValue: "9" },
              { name: "pointDifferential", displayValue: "9" },
              { name: "points", displayValue: "21" },
            ],
          },
        ],
      },
    },
  ],
};

const runEspnStandingsTest = (): Failures => {
  const md = espnStandingsToMarkdown(espnStandingsFixture, "Premier League", "2025/26");
  const failures = runHouseFormatChecks(md, "Premier League", "espn-standings");
  if (md && !md.startsWith("# Premier League 2025/26")) {
    failures.push(`espn-standings: title line missing/incorrect — got ${JSON.stringify(md.slice(0, 40))}`);
  }
  if (md && !md.includes("Arsenal")) {
    failures.push("espn-standings: expected team row missing");
  }
  // Empty-groups input must return null, not an empty document.
  if (espnStandingsToMarkdown({ children: [] }, "Premier League", "2025/26") !== null) {
    failures.push("espn-standings: expected null for empty children array");
  }
  return failures;
};

// ── ESPN scoreboard ──────────────────────────────────────────────────────────

const espnScoreboardFixture = {
  events: [
    {
      date: "2026-08-21T19:00Z",
      competitions: [
        {
          status: { type: { completed: true, description: "Final" } },
          competitors: [
            { homeAway: "home", team: { displayName: "Arsenal" }, score: "3" },
            { homeAway: "away", team: { displayName: "Coventry City" }, score: "0" },
          ],
        },
      ],
    },
    {
      date: "2026-08-22T15:00Z",
      competitions: [
        {
          status: { type: { completed: false, description: "Scheduled" } },
          competitors: [
            { homeAway: "home", team: { displayName: "Chelsea" }, score: "0" },
            { homeAway: "away", team: { displayName: "Man United" }, score: "0" },
          ],
        },
      ],
    },
  ],
};

const runEspnScoreboardTest = (): Failures => {
  const md = espnScoreboardToMarkdown(espnScoreboardFixture, "Premier League", "2025/26");
  const failures = runHouseFormatChecks(md, "Premier League", "espn-scoreboard");
  if (md && !md.includes("**Type:** Mixed")) {
    failures.push("espn-scoreboard: expected Type: Mixed (one completed + one scheduled event)");
  }
  if (espnScoreboardToMarkdown({ events: [] }, "Premier League", "2025/26") !== null) {
    failures.push("espn-scoreboard: expected null for empty events array");
  }
  return failures;
};

// ── Wikipedia ────────────────────────────────────────────────────────────────

const wikipediaFixtureHtml = `
<div class="mw-parser-output">
<style data-mw-deduplicate="TemplateStyles:r1">.mw-parser-output{color:red}</style>
<p>The 2025–26 Premier League is the 34th season of the Premier League, the top English football league, running from August 2025 to May 2026.<sup class="reference">[1]</sup></p>
<h2><span class="mw-headline">League table</span><span class="mw-editsection">[edit]</span></h2>
<table class="wikitable sortable">
<tr><th>Pos</th><th>Team</th><th>Pld</th><th>Pts</th></tr>
<tr><td>1</td><td>Arsenal</td><td>10</td><td>23</td></tr>
<tr><td>2</td><td>Liverpool</td><td>10</td><td>21</td></tr>
</table>
</div>
`;

const runWikipediaTest = (): Failures => {
  const md = wikipediaHtmlToMarkdown(
    wikipediaFixtureHtml,
    "2025–26 Premier League",
    "Premier League",
    "standings",
  );
  const failures = runHouseFormatChecks(md, "Premier League", "wikipedia-article");
  if (md && !md.includes("2025/26")) {
    failures.push("wikipedia-article: season not derived from title (expected 2025/26)");
  }
  if (md && !md.includes("**Type:** Standings")) {
    failures.push('wikipedia-article: category "standings" expected to resolve to Type: Standings');
  }
  if (md && /color:red/.test(md)) {
    failures.push("wikipedia-article: <style> block content leaked into output");
  }
  if (md && md.includes("[edit]")) {
    failures.push("wikipedia-article: [edit] section link leaked into output");
  }
  if (md && md.includes("[1]")) {
    failures.push("wikipedia-article: reference citation [1] not stripped");
  }

  // Title without a season year falls back to the current season.
  const noYearHtml = `<div><p>${"AFCON is the Africa Cup of Nations, the biennial continental championship of Africa.".padEnd(60, ".")}</p><table class="wikitable"><tr><th>Team</th><th>Result</th></tr><tr><td>Nigeria</td><td>Won</td></tr></table></div>`;
  const noYearMd = wikipediaHtmlToMarkdown(noYearHtml, "Africa Cup of Nations", "AFCON", "results");
  const noYearFailures = runHouseFormatChecks(noYearMd, "AFCON", "wikipedia-article-no-year");
  failures.push(...noYearFailures);
  const expectedFallbackSeason = seasonString(currentSeasonStartYear());
  if (noYearMd && !noYearMd.includes(expectedFallbackSeason)) {
    failures.push(
      `wikipedia-article-no-year: expected fallback season "${expectedFallbackSeason}" not found`,
    );
  }
  if (noYearMd && !noYearMd.includes("**Type:** Results")) {
    failures.push('wikipedia-article-no-year: category "results" expected to resolve to Type: Results');
  }

  // No tables, no substantial paragraphs -> null (no-data case).
  const emptyMd = wikipediaHtmlToMarkdown("<div><p>Too short.</p></div>", "Some Title", "EPL", "mixed");
  if (emptyMd !== null) {
    failures.push("wikipedia-article-empty: expected null when no tables/paragraphs are present");
  }

  return failures;
};

// ── openfootball ─────────────────────────────────────────────────────────────

const openfootballFixture = {
  matches: [
    {
      round: "Matchday 1",
      date: "2025-08-15",
      time: "20:00",
      team1: "Liverpool FC",
      team2: "AFC Bournemouth",
      score: { ft: [4, 2] as [number, number], ht: [1, 0] as [number, number] },
    },
    {
      round: "Matchday 1",
      date: "2025-08-16",
      time: "12:30",
      team1: "Aston Villa FC",
      team2: "Newcastle United FC",
      score: [0, 0] as [number, number],
    },
    {
      round: "Matchday 2",
      date: "2025-08-23",
      time: "15:00",
      team1: "Arsenal FC",
      team2: "Chelsea FC",
    },
  ],
};

const runOpenfootballTest = (): Failures => {
  const md = openfootballToMarkdown(openfootballFixture, "Premier League", "2025/26");
  const failures = runHouseFormatChecks(md, "Premier League", "openfootball");
  if (md && !md.includes("## Matchday 1")) {
    failures.push("openfootball: expected '## Matchday 1' section heading");
  }
  if (md && !md.includes("**Type:** Results")) {
    failures.push("openfootball: Matchday 1 (all played) expected Type: Results");
  }
  if (md && !md.includes("**Type:** Fixtures")) {
    failures.push("openfootball: Matchday 2 (unplayed) expected Type: Fixtures");
  }
  if (md && !md.includes("4 - 2")) {
    failures.push("openfootball: expected 'ft' score object to render as '4 - 2'");
  }
  if (md && !md.includes("0 - 0")) {
    failures.push("openfootball: expected plain-array score to render as '0 - 0'");
  }
  if (openfootballToMarkdown({ matches: [] }, "Premier League", "2025/26") !== null) {
    failures.push("openfootball: expected null for empty matches array");
  }
  return failures;
};

// ── football-data.org (KEY-GATED — hand-built from the documented v4 schema;
// no key exists, so this is never called live) ──────────────────────────────

const fdoStandingsFixture = {
  standings: [
    {
      stage: "REGULAR_SEASON",
      type: "TOTAL",
      table: [
        {
          position: 1,
          team: { name: "Arsenal FC" },
          playedGames: 10,
          won: 7,
          draw: 2,
          lost: 1,
          points: 23,
          goalsFor: 20,
          goalsAgainst: 8,
          goalDifference: 12,
        },
        {
          position: 2,
          team: { name: "Liverpool FC" },
          playedGames: 10,
          won: 6,
          draw: 3,
          lost: 1,
          points: 21,
          goalsFor: 18,
          goalsAgainst: 9,
          goalDifference: 9,
        },
      ],
    },
  ],
};

const fdoScorersFixture = {
  scorers: [
    { player: { name: "Erling Haaland" }, team: { name: "Manchester City FC" }, goals: 12, assists: 3 },
    { player: { name: "Mohamed Salah" }, team: { name: "Liverpool FC" }, goals: 10, assists: 5 },
  ],
};

const runFootballDataOrgTest = (): Failures => {
  const standingsMd = footballDataOrgStandingsToMarkdown(fdoStandingsFixture, "Premier League", "2025/26");
  const scorersMd = footballDataOrgScorersToMarkdown(fdoScorersFixture, "Premier League", "2025/26");
  const failures: Failures = [
    ...runHouseFormatChecks(standingsMd, "Premier League", "football-data-org-standings"),
    ...runHouseFormatChecks(scorersMd, "Premier League", "football-data-org-scorers"),
  ];
  if (standingsMd && !standingsMd.includes("Arsenal FC")) {
    failures.push("football-data-org-standings: expected team row missing");
  }
  if (scorersMd && !scorersMd.includes("Erling Haaland")) {
    failures.push("football-data-org-scorers: expected scorer row missing");
  }
  if (footballDataOrgStandingsToMarkdown({ standings: [] }, "Premier League", "2025/26") !== null) {
    failures.push("football-data-org-standings: expected null for empty standings array");
  }
  if (footballDataOrgScorersToMarkdown({ scorers: [] }, "Premier League", "2025/26") !== null) {
    failures.push("football-data-org-scorers: expected null for empty scorers array");
  }
  return failures;
};

// ── API-Football (KEY-GATED — hand-built from the documented v3 /standings
// schema; no key exists, so this is never called live) ──────────────────────

const apiFootballFixture = {
  response: [
    {
      league: {
        id: 39,
        name: "Premier League",
        standings: [
          [
            {
              rank: 1,
              team: { name: "Manchester City" },
              points: 23,
              goalsDiff: 12,
              all: { played: 10, win: 7, draw: 2, lose: 1, goals: { for: 20, against: 8 } },
            },
            {
              rank: 2,
              team: { name: "Arsenal" },
              points: 21,
              goalsDiff: 9,
              all: { played: 10, win: 6, draw: 3, lose: 1, goals: { for: 18, against: 9 } },
            },
          ],
        ],
      },
    },
  ],
};

const runApiFootballTest = (): Failures => {
  const md = apiFootballStandingsToMarkdown(apiFootballFixture, "Premier League", "2025/26");
  const failures = runHouseFormatChecks(md, "Premier League", "api-football-standings");
  if (md && !md.includes("Manchester City")) {
    failures.push("api-football-standings: expected team row missing");
  }
  if (apiFootballStandingsToMarkdown({ response: [] }, "Premier League", "2025/26") !== null) {
    failures.push("api-football-standings: expected null for empty response array");
  }
  return failures;
};

// ── Main ─────────────────────────────────────────────────────────────────────

const main = (): void => {
  const allFailures: Failures = [];

  const suites: Array<[string, () => Failures]> = [
    ["season-helpers", runSeasonHelperTests],
    ["espn-standings", runEspnStandingsTest],
    ["espn-scoreboard", runEspnScoreboardTest],
    ["wikipedia", runWikipediaTest],
    ["openfootball", runOpenfootballTest],
    ["football-data-org", runFootballDataOrgTest],
    ["api-football", runApiFootballTest],
  ];

  for (const [name, run] of suites) {
    const failures = run();
    if (failures.length === 0) {
      console.log(`[PASS] ${name}`);
    } else {
      console.log(`[FAIL] ${name} (${failures.length} issue(s))`);
      for (const f of failures) console.log(`  - ${f}`);
    }
    allFailures.push(...failures);
  }

  console.log(`\n=== Assertions ===`);
  if (allFailures.length > 0) {
    console.error(`FAILED (${allFailures.length} issue(s)).`);
    process.exit(1);
  }

  console.log("All assertions passed.");
  process.exit(0);
};

main();
