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
  openfootballCandidateYears,
  footballDataOrgStandingsToMarkdown,
  footballDataOrgScorersToMarkdown,
  isStandingsNotStarted,
  apiFootballStandingsToMarkdown,
  paceFootballData,
} from "./lib/scrapers/apiFetchers.js";
import { normalizeLeagueName } from "./lib/utils/promptGenerator.js";
import { isStatsSite } from "./lib/scrapers/evaluators/statsEvaluator.js";
import { isLowValueContent } from "./lib/scrapers/contentFilter.js";

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

/** Calls `fn`, recording a failure (instead of crashing the whole run) if it
 * throws — used to prove the "never throws on malformed input" contract. */
const assertNoThrow = <T>(label: string, fn: () => T, failures: Failures): T | undefined => {
  try {
    return fn();
  } catch (error) {
    failures.push(`${label}: threw unexpectedly — ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

/** Splits a markdown table row line into its trimmed cell values, e.g.
 * "| A | B |" -> ["A", "B"] — used to assert a specific cell at a specific
 * column index rather than just checking column counts. */
const parseMdRowCells = (line: string): string[] =>
  line.split("|").slice(1, -1).map((c) => c.trim());

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

  // openfootball season-rollover fallback: the requested year first, then
  // exactly one fallback to the previous season (for the July 1st window
  // where the new season's GitHub file may not exist yet).
  const candidates = openfootballCandidateYears(2026);
  if (candidates.length !== 2 || candidates[0] !== 2026 || candidates[1] !== 2025) {
    failures.push(`openfootballCandidateYears(2026) expected [2026, 2025], got ${JSON.stringify(candidates)}`);
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

  // Regression: the response's own embedded `season.year` must win over the
  // caller-supplied season — ESPN (like football-data.org) keeps serving a
  // concluded season as "current" until the new one starts.
  const embeddedSeasonFixture = { ...espnStandingsFixture, season: { year: 2019 } };
  const embeddedMd = espnStandingsToMarkdown(embeddedSeasonFixture, "Premier League", "2025/26");
  if (!embeddedMd || !embeddedMd.includes("2019/20")) {
    failures.push(
      `espn-standings-embedded-season: expected response season "2019/20" to win over caller-supplied "2025/26", got ${JSON.stringify(embeddedMd?.slice(0, 40))}`,
    );
  }
  if (embeddedMd && embeddedMd.includes("2025/26")) {
    failures.push("espn-standings-embedded-season: caller-supplied season leaked into output instead of the response's own season");
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

  // Regression: embedded `season.year` must win over the caller-supplied
  // season, same as espn-standings above.
  const embeddedSeasonFixture = { ...espnScoreboardFixture, season: { year: 2019 } };
  const embeddedMd = espnScoreboardToMarkdown(embeddedSeasonFixture, "Premier League", "2025/26");
  if (!embeddedMd || !embeddedMd.includes("2019/20")) {
    failures.push(
      `espn-scoreboard-embedded-season: expected response season "2019/20" to win over caller-supplied "2025/26", got ${JSON.stringify(embeddedMd?.slice(0, 40))}`,
    );
  }
  if (embeddedMd && embeddedMd.includes("2025/26")) {
    failures.push("espn-scoreboard-embedded-season: caller-supplied season leaked into output instead of the response's own season");
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

// A standalone 4-digit year (no range) in the title — regression for the
// MAJOR review finding: "2025 Africa Cup of Nations" was falling through to
// the CURRENT season instead of resolving via the year in its own title.
// AFCON 2025 ran Dec 2025–Jan 2026, so it must read "2025/26" regardless of
// which season happens to be current when the article is fetched.
const runWikipediaSingleYearTitleTest = (): Failures => {
  const failures: Failures = [];
  const html = `<div><p>${"The 2025 Africa Cup of Nations was the 35th edition of the biennial continental championship of Africa.".padEnd(60, ".")}</p><table class="wikitable"><tr><th>Team</th><th>Result</th></tr><tr><td>Nigeria</td><td>Won</td></tr></table></div>`;
  const md = wikipediaHtmlToMarkdown(html, "2025 Africa Cup of Nations", "AFCON", "results");
  failures.push(...runHouseFormatChecks(md, "AFCON", "wikipedia-single-year-title"));
  if (md && !md.includes("2025/26")) {
    failures.push(
      `wikipedia-single-year-title: expected season "2025/26" derived from the standalone year "2025", got ${JSON.stringify(md.slice(0, 60))}`,
    );
  }

  // Range pattern takes precedence over an embedded standalone year.
  const precedenceHtml = `<div><p>${"This article covers the modern competition, successor to the old 1999 edition.".padEnd(60, ".")}</p><table class="wikitable"><tr><th>Team</th><th>Result</th></tr><tr><td>Arsenal</td><td>Won</td></tr></table></div>`;
  const precedenceMd = wikipediaHtmlToMarkdown(precedenceHtml, "2025–26 Premier League", "Premier League", "mixed");
  failures.push(...runHouseFormatChecks(precedenceMd, "Premier League", "wikipedia-range-precedence"));
  if (precedenceMd && !precedenceMd.includes("2025/26")) {
    failures.push("wikipedia-range-precedence: expected range-derived season 2025/26");
  }
  if (precedenceMd && precedenceMd.includes("1999/00")) {
    failures.push(
      "wikipedia-range-precedence: standalone year 1999 (embedded in body text) incorrectly won over the range in the title",
    );
  }

  return failures;
};

// ── Wikipedia table rowspan/colspan grid expansion (BLOCKER finding) ────────
//
// Regression fixture for the live-verified UEFA_Champions_League bug: the
// old per-<tr> extraction ignored rowspan/colspan, so a rowspanned label
// cell vanished and every subsequent cell on that row shifted left, padded
// with a trailing "-". This fixture uses BOTH a colspanned header cell and a
// rowspanned label cell, matching the qualifying-round access-list shape on
// the real article (round name spans two rows, "Fixture" spans two columns).
const rowspanColspanFixtureHtml = `
<div class="mw-parser-output">
<table class="wikitable">
<tr><th>Round</th><th>Teams</th><th colspan="2">Fixture</th></tr>
<tr><td rowspan="2">First qualifying round</td><td>Team A</td><td>1–0</td><td>Team B</td></tr>
<tr><td>Team C</td><td>2–2</td><td>Team D</td></tr>
</table>
</div>
`;

const runWikipediaRowspanColspanTest = (): Failures => {
  const failures: Failures = [];
  const md = wikipediaHtmlToMarkdown(
    rowspanColspanFixtureHtml,
    "2025–26 UEFA Champions League",
    "Champions League",
    "standings",
  );
  if (!md) {
    failures.push("wikipedia-rowspan-colspan: converter returned null");
    return failures;
  }

  const lines = md.split("\n");
  const headerLine = lines.find((l) => l.startsWith("| Round |"));
  const row1Line = lines.find((l) => l.includes("Team A"));
  const row2Line = lines.find((l) => l.includes("Team C"));

  if (!headerLine) {
    failures.push("wikipedia-rowspan-colspan: expected header row starting '| Round |' not found");
  } else {
    const cells = parseMdRowCells(headerLine);
    if (cells[2] !== "Fixture" || cells[3] !== "Fixture") {
      failures.push(
        `wikipedia-rowspan-colspan: colspan header expected "Fixture" at cols 2 and 3, got ${JSON.stringify(cells.slice(2))}`,
      );
    }
  }

  if (!row1Line) {
    failures.push("wikipedia-rowspan-colspan: expected data row containing 'Team A' not found");
  } else {
    const cells = parseMdRowCells(row1Line);
    if (cells[0] !== "First qualifying round") {
      failures.push(
        `wikipedia-rowspan-colspan: row 1 col 0 expected "First qualifying round", got ${JSON.stringify(cells[0])}`,
      );
    }
    if (cells[1] !== "Team A") {
      failures.push(`wikipedia-rowspan-colspan: row 1 col 1 expected "Team A", got ${JSON.stringify(cells[1])}`);
    }
  }

  if (!row2Line) {
    failures.push("wikipedia-rowspan-colspan: expected data row containing 'Team C' not found");
  } else {
    const cells = parseMdRowCells(row2Line);
    // The critical regression assertion: the rowspanned label must be
    // REPEATED into row 2's column 0 — not vanished, with row 2's real
    // cells shifted left and padded with a trailing "-" (the old bug).
    if (cells[0] !== "First qualifying round") {
      failures.push(
        `wikipedia-rowspan-colspan: row 2 col 0 expected rowspan label "First qualifying round" repeated, got ${JSON.stringify(cells[0])} — indicates the vanish-and-shift bug`,
      );
    }
    if (cells[1] !== "Team C") {
      failures.push(`wikipedia-rowspan-colspan: row 2 col 1 expected "Team C" (not shifted), got ${JSON.stringify(cells[1])}`);
    }
    if (cells[3] !== "Team D") {
      failures.push(`wikipedia-rowspan-colspan: row 2 col 3 expected "Team D", got ${JSON.stringify(cells[3])}`);
    }
  }

  return failures;
};

// A table whose rowspan/colspan layout can't be reconciled into an
// equal-width grid (here: a rowspan cell plus a later colspan cell that
// together produce mismatched row widths) must be SKIPPED with the
// omitted-table note rather than shipping positionally-shifted data.
const malformedTableFixtureHtml = `
<div class="mw-parser-output">
<table class="wikitable">
<tr><td rowspan="2">A</td><td>B</td></tr>
<tr><td colspan="2">C</td></tr>
</table>
</div>
`;

const runWikipediaMalformedTableTest = (): Failures => {
  const failures: Failures = [];
  const md = wikipediaHtmlToMarkdown(malformedTableFixtureHtml, "Malformed Table Title", "EPL", "mixed");
  if (!md) {
    failures.push("wikipedia-malformed-table: expected non-null output (the omitted-table note is itself content)");
    return failures;
  }
  if (!md.includes("[table omitted: complex layout]")) {
    failures.push("wikipedia-malformed-table: expected the table to be omitted with a one-line note, it was not skipped");
  }
  if (/\|\s*A\s*\|/.test(md) || /\|\s*C\s*\|/.test(md)) {
    failures.push("wikipedia-malformed-table: malformed table's shifted cell data leaked into output instead of being omitted");
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

// ── openfootball en.1 (EPL) — live-reproduced BLOCKER: zero chunks survived
// (MAJOR finding, seed run 30625125601) ─────────────────────────────────────
//
// Root cause (reproduced locally with the real Matchday 1 fixture data):
// scripts/loadDb.ts's chunker gives each round's table its own chunk — just
// the "| Date | Home | Away | ... |" header/separator/rows, no heading, no
// **Type:** line. isLowValueContent's lenient stats-content branch needs a
// keyword hit (goal|assist|match|team|player|score|stat|table|league|
// position|points|win|draw|loss) to short-circuit; the old "Result" header
// carried none, so a ~650-char table fell through to the boilerplate-count
// path. There it hit >=3 BOILERPLATE_PATTERNS entries by accident: "home"
// (the literal, guaranteed-present "Home" column header), plus "live"
// (inside "Liverpool") and "ht" (inside "Brighton") — both incidental
// substring collisions with that day's specific team names. That same day's
// La Liga table (different team names) only ever hit "home" — 1 match, safe
// — which is why the four sibling leagues inserted fine and only en.1 was
// dropped. The fix renamed the header column to "Score" (a listed stats
// keyword, repeated on every chunk since packTableRows re-emits the header)
// so the lenient branch applies unconditionally, independent of which teams
// happen to be playing.
const openfootballEplMatchday1Fixture = {
  matches: [
    { round: "Matchday 1", date: "2025-08-15", team1: "Liverpool FC", team2: "AFC Bournemouth", score: { ft: [4, 2] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-16", team1: "Aston Villa FC", team2: "Newcastle United FC", score: { ft: [0, 0] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-16", team1: "Brighton & Hove Albion FC", team2: "Fulham FC", score: { ft: [1, 1] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-16", team1: "Sunderland AFC", team2: "West Ham United FC", score: { ft: [3, 0] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-16", team1: "Tottenham Hotspur FC", team2: "Burnley FC", score: { ft: [3, 0] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-16", team1: "Wolverhampton Wanderers FC", team2: "Manchester City FC", score: { ft: [0, 4] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-17", team1: "Nottingham Forest FC", team2: "Brentford FC", score: { ft: [3, 1] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-17", team1: "Chelsea FC", team2: "Crystal Palace FC", score: { ft: [0, 0] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-17", team1: "Manchester United FC", team2: "Arsenal FC", score: { ft: [0, 1] as [number, number] } },
    { round: "Matchday 1", date: "2025-08-18", team1: "Leeds United FC", team2: "Everton FC", score: { ft: [1, 0] as [number, number] } },
  ],
};

const runOpenfootballEplRegressionTest = (): Failures => {
  const failures: Failures = [];
  const md = openfootballToMarkdown(openfootballEplMatchday1Fixture, "Premier League", "2025/26");
  if (!md) {
    failures.push("openfootball-epl-regression: converter returned null");
    return failures;
  }

  // Mirror what the chunker actually isolates into its own chunk: just the
  // table lines, no heading/type-line prefix.
  const tableOnly = md
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .join("\n");

  if (isLowValueContent(tableOnly)) {
    failures.push(
      "openfootball-epl-regression: EPL matchday table incorrectly classified as low-value content by isLowValueContent — the live-reproduced false positive is back",
    );
  }
  if (!/\bscore\b/i.test(md)) {
    failures.push(
      "openfootball-epl-regression: expected the table header to carry a stats keyword (e.g. 'Score') so the isLowValueContent lenient branch applies unconditionally, not by team-name luck",
    );
  }

  return failures;
};

// ── football-data.org pacing gate (paceFootballData) ────────────────────────
// Free tier is 10 req/min; six competitions fetched back-to-back blew
// through it. Asserts consecutive calls are spaced by at least the
// (injectable, kept short here) interval — never the real 6.5s default, so
// this suite stays fast.
const runPaceFootballDataTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const intervalMs = 40;

  const start = Date.now();
  await paceFootballData(intervalMs);
  const afterFirst = Date.now();
  await paceFootballData(intervalMs);
  const afterSecond = Date.now();

  const elapsed = afterSecond - afterFirst;
  // Small negative tolerance for setTimeout/scheduler jitter.
  if (elapsed < intervalMs - 5) {
    failures.push(
      `paceFootballData: expected >= ~${intervalMs}ms between consecutive calls, got ${elapsed}ms`,
    );
  }
  if (afterFirst - start > intervalMs * 5) {
    failures.push(
      `paceFootballData: first call took unexpectedly long (${afterFirst - start}ms) — pacing state may not be starting from zero`,
    );
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

// Malformed-row fixtures (null team / missing player) — regression for the
// MAJOR review finding: these converters used to dereference nested fields
// (row.team.name, s.player.name) without optional chaining and would throw
// on a shape like this, killing a seed run.
const fdoMalformedStandingsFixture = {
  standings: [
    {
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
          team: null,
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

const fdoMalformedScorersFixture = {
  scorers: [
    { player: { name: "Erling Haaland" }, team: { name: "Manchester City FC" }, goals: 12, assists: 3 },
    { player: null, team: { name: "Liverpool FC" }, goals: 10, assists: 5 },
  ],
};

// Multi-group fixture — regression for the MAJOR review finding: the
// converter used to render only the first TOTAL group; a competition like
// Champions League has multiple groups, all of which must appear.
const fdoMultiGroupStandingsFixture = {
  standings: [
    {
      group: "Group A",
      table: [
        {
          position: 1,
          team: { name: "Team Alpha" },
          playedGames: 6,
          won: 4,
          draw: 1,
          lost: 1,
          points: 13,
          goalsFor: 10,
          goalsAgainst: 5,
          goalDifference: 5,
        },
      ],
    },
    {
      group: "Group B",
      table: [
        {
          position: 1,
          team: { name: "Team Beta" },
          playedGames: 6,
          won: 5,
          draw: 0,
          lost: 1,
          points: 15,
          goalsFor: 12,
          goalsAgainst: 4,
          goalDifference: 8,
        },
      ],
    },
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

  const malformedStandingsMd = assertNoThrow(
    "football-data-org-standings-malformed",
    () => footballDataOrgStandingsToMarkdown(fdoMalformedStandingsFixture, "Premier League", "2025/26"),
    failures,
  );
  if (malformedStandingsMd) {
    if (!malformedStandingsMd.includes("Arsenal FC")) {
      failures.push("football-data-org-standings-malformed: valid row (Arsenal FC) was dropped");
    }
    if (/\bnull\b/.test(malformedStandingsMd)) {
      failures.push("football-data-org-standings-malformed: malformed row's null team leaked into output instead of being skipped");
    }
  }

  const malformedScorersMd = assertNoThrow(
    "football-data-org-scorers-malformed",
    () => footballDataOrgScorersToMarkdown(fdoMalformedScorersFixture, "Premier League", "2025/26"),
    failures,
  );
  if (malformedScorersMd) {
    if (!malformedScorersMd.includes("Erling Haaland")) {
      failures.push("football-data-org-scorers-malformed: valid row (Erling Haaland) was dropped");
    }
    if (/\bnull\b/.test(malformedScorersMd)) {
      failures.push("football-data-org-scorers-malformed: malformed row's null player leaked into output instead of being skipped");
    }
  }

  const multiGroupMd = assertNoThrow(
    "football-data-org-standings-multigroup",
    () => footballDataOrgStandingsToMarkdown(fdoMultiGroupStandingsFixture, "Champions League", "2025/26"),
    failures,
  );
  if (multiGroupMd) {
    if (!multiGroupMd.includes("## Group A") || !multiGroupMd.includes("## Group B")) {
      failures.push(
        "football-data-org-standings-multigroup: expected both '## Group A' and '## Group B' sections (all groups, not just TOTAL)",
      );
    }
    if (!multiGroupMd.includes("Team Alpha") || !multiGroupMd.includes("Team Beta")) {
      failures.push("football-data-org-standings-multigroup: expected teams from both groups present");
    }
  } else {
    failures.push("football-data-org-standings-multigroup: expected non-null output");
  }

  // Regression (BLOCKER finding, live-reproduced): the response's own
  // embedded `season.startDate` must win over the caller-supplied season —
  // football-data.org keeps serving a just-concluded season as "current"
  // until the new one kicks off, so the passed-in season alone silently
  // mislabels a summer-window fetch.
  const embeddedStandingsFixture = { ...fdoStandingsFixture, season: { startDate: "2019-08-09" } };
  const embeddedStandingsMd = footballDataOrgStandingsToMarkdown(
    embeddedStandingsFixture,
    "Premier League",
    "2025/26",
  );
  if (!embeddedStandingsMd || !embeddedStandingsMd.includes("2019/20")) {
    failures.push(
      `football-data-org-standings-embedded-season: expected response season "2019/20" to win over caller-supplied "2025/26", got ${JSON.stringify(embeddedStandingsMd?.slice(0, 80))}`,
    );
  }
  if (embeddedStandingsMd && embeddedStandingsMd.includes("2025/26")) {
    failures.push(
      "football-data-org-standings-embedded-season: caller-supplied season leaked into output instead of the response's own season",
    );
  }

  const embeddedScorersFixture = { ...fdoScorersFixture, season: { startDate: "2019-08-09" } };
  const embeddedScorersMd = footballDataOrgScorersToMarkdown(
    embeddedScorersFixture,
    "Premier League",
    "2025/26",
  );
  if (!embeddedScorersMd || !embeddedScorersMd.includes("2019/20")) {
    failures.push(
      `football-data-org-scorers-embedded-season: expected response season "2019/20" to win over caller-supplied "2025/26", got ${JSON.stringify(embeddedScorersMd?.slice(0, 80))}`,
    );
  }
  if (embeddedScorersMd && embeddedScorersMd.includes("2025/26")) {
    failures.push(
      "football-data-org-scorers-embedded-season: caller-supplied season leaked into output instead of the response's own season",
    );
  }

  // Invalid startDate must fall back to the caller-supplied season rather
  // than throwing or emitting garbage.
  const invalidStartDateFixture = { ...fdoStandingsFixture, season: { startDate: "not-a-date" } };
  const invalidStartDateMd = assertNoThrow(
    "football-data-org-standings-invalid-season-date",
    () => footballDataOrgStandingsToMarkdown(invalidStartDateFixture, "Premier League", "2025/26"),
    failures,
  );
  if (invalidStartDateMd && !invalidStartDateMd.includes("2025/26")) {
    failures.push(
      "football-data-org-standings-invalid-season-date: expected fallback to caller-supplied season 2025/26 on an invalid startDate",
    );
  }

  return failures;
};

// ── explicit-season not-started fallback decision (isStandingsNotStarted) ──
// Regression for the season-boundary bug: football-data.org's DEFAULT
// (no `?season=`) standings alias mixes a NEW season's `season.startDate`
// with the previous, COMPLETE season's table. fetchFootballDataOrg now
// always requests an explicit `?season=` year and uses this pure helper —
// testable without mocking fetch — to decide whether that response is a
// genuine "season not started yet" (zero information) response that should
// trigger a one-time fallback to the previous season instead.

// (a) requested season not started — every row's playedGames is 0.
const fdoNotStartedFixture = {
  season: { startDate: "2026-08-21" },
  standings: [
    {
      type: "TOTAL",
      table: [
        {
          position: 1,
          team: { name: "Arsenal FC" },
          playedGames: 0,
          won: 0,
          draw: 0,
          lost: 0,
          points: 0,
          goalsFor: 0,
          goalsAgainst: 0,
          goalDifference: 0,
        },
        {
          position: 2,
          team: { name: "Liverpool FC" },
          playedGames: 0,
          won: 0,
          draw: 0,
          lost: 0,
          points: 0,
          goalsFor: 0,
          goalsAgainst: 0,
          goalDifference: 0,
        },
      ],
    },
  ],
};

// The fallback response fetchFootballDataOrg would substitute in once (a)
// triggers — a complete previous season, self-consistent by construction.
const fdoPreviousSeasonFixture = {
  season: { startDate: "2025-08-15" },
  standings: [
    {
      type: "TOTAL",
      table: [
        {
          position: 1,
          team: { name: "Arsenal FC" },
          playedGames: 38,
          won: 28,
          draw: 6,
          lost: 4,
          points: 90,
          goalsFor: 80,
          goalsAgainst: 30,
          goalDifference: 50,
        },
      ],
    },
  ],
};

const runIsStandingsNotStartedTest = (): Failures => {
  const failures: Failures = [];

  // (a) requested-season-not-started → fallback chosen. The helper flags
  // the zero-games response, and once the caller substitutes in the
  // previous season's response, THAT response's own label ("2025/26") is
  // what the document ends up carrying — not the requested season.
  if (!isStandingsNotStarted(fdoNotStartedFixture)) {
    failures.push(
      "isStandingsNotStarted: expected true for a response where every row has playedGames 0",
    );
  }
  const fallbackMd = footballDataOrgStandingsToMarkdown(
    fdoPreviousSeasonFixture,
    "Premier League",
    "2026/27",
  );
  if (!fallbackMd || !fallbackMd.includes("2025/26")) {
    failures.push(
      `isStandingsNotStarted-fallback-label: expected the fallback response's own label "2025/26" once the previous-season response is used, got ${JSON.stringify(fallbackMd?.slice(0, 40))}`,
    );
  }

  // (b) requested season has data → no fallback. The helper must say false
  // so fetchFootballDataOrg keeps the first (requested-season) response
  // as-is, and its own label ("2025/26" per fdoStandingsFixture's season) is
  // what's used — never overridden by a fallback that never happens.
  if (isStandingsNotStarted(fdoStandingsFixture)) {
    failures.push("isStandingsNotStarted: expected false for a response with played games > 0");
  }
  const noFallbackFixture = { ...fdoStandingsFixture, season: { startDate: "2025-08-15" } };
  const noFallbackMd = footballDataOrgStandingsToMarkdown(noFallbackFixture, "Premier League", "2025/26");
  if (!noFallbackMd || !noFallbackMd.includes("2025/26")) {
    failures.push(
      `isStandingsNotStarted-no-fallback-label: expected requested season's own label "2025/26" when no fallback is needed, got ${JSON.stringify(noFallbackMd?.slice(0, 40))}`,
    );
  }

  // Missing/empty response (no standings at all, or an empty table) counts
  // as "not started" — zero information either way.
  if (!isStandingsNotStarted(null)) {
    failures.push("isStandingsNotStarted: expected true for a null response");
  }
  if (!isStandingsNotStarted({ standings: [] })) {
    failures.push("isStandingsNotStarted: expected true for an empty standings array");
  }
  if (!isStandingsNotStarted({ standings: [{ type: "TOTAL", table: [] }] })) {
    failures.push("isStandingsNotStarted: expected true for a group with an empty table");
  }

  // A partially-started season (some rows played, some not) is NOT
  // "not started" — only an ALL-zero table counts as zero information.
  const mixedFixture = {
    standings: [
      {
        type: "TOTAL",
        table: [
          {
            position: 1,
            team: { name: "Arsenal FC" },
            playedGames: 1,
            won: 1,
            draw: 0,
            lost: 0,
            points: 3,
            goalsFor: 2,
            goalsAgainst: 0,
            goalDifference: 2,
          },
          {
            position: 2,
            team: { name: "Liverpool FC" },
            playedGames: 0,
            won: 0,
            draw: 0,
            lost: 0,
            points: 0,
            goalsFor: 0,
            goalsAgainst: 0,
            goalDifference: 0,
          },
        ],
      },
    ],
  };
  if (isStandingsNotStarted(mixedFixture)) {
    failures.push(
      "isStandingsNotStarted: expected false when at least one row has played games (partial season start)",
    );
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

// Malformed-row fixture (null team) — regression for the MAJOR review
// finding: dereferencing row.team.name without optional chaining threw on
// a shape like this.
const apiFootballMalformedFixture = {
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
              team: null,
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

  const malformedMd = assertNoThrow(
    "api-football-standings-malformed",
    () => apiFootballStandingsToMarkdown(apiFootballMalformedFixture, "Premier League", "2025/26"),
    failures,
  );
  if (malformedMd) {
    if (!malformedMd.includes("Manchester City")) {
      failures.push("api-football-standings-malformed: valid row (Manchester City) was dropped");
    }
    if (/\bnull\b/.test(malformedMd)) {
      failures.push("api-football-standings-malformed: malformed row's null team leaked into output instead of being skipped");
    }
  }

  // Regression: the response's own embedded `league.season` (a number) must
  // win over the caller-supplied season, same risk pattern as
  // football-data.org — we pass a season year in, but the response echoes
  // its own.
  const embeddedSeasonFixture = {
    response: [
      { league: { ...apiFootballFixture.response[0].league, season: 2019 } },
    ],
  };
  const embeddedMd = apiFootballStandingsToMarkdown(embeddedSeasonFixture, "Premier League", "2025/26");
  if (!embeddedMd || !embeddedMd.includes("2019/20")) {
    failures.push(
      `api-football-standings-embedded-season: expected response season "2019/20" to win over caller-supplied "2025/26", got ${JSON.stringify(embeddedMd?.slice(0, 40))}`,
    );
  }
  if (embeddedMd && embeddedMd.includes("2025/26")) {
    failures.push(
      "api-football-standings-embedded-season: caller-supplied season leaked into output instead of the response's own season",
    );
  }

  return failures;
};

// ── normalizeLeagueName: CAF Champions League (MINOR finding) ──────────────

const runNormalizeLeagueNameCafTest = (): Failures => {
  const failures: Failures = [];
  // Regression: dataSources.ts's api-football CAF entry sets
  // leagueName: "CAF Champions League" — it must map to itself (a known
  // code) rather than falling through unmapped.
  const mapped = normalizeLeagueName("CAF Champions League");
  if (mapped !== "CAF Champions League") {
    failures.push(`normalizeLeagueName("CAF Champions League") expected "CAF Champions League", got ${JSON.stringify(mapped)}`);
  }
  const mappedLower = normalizeLeagueName("caf champions league");
  if (mappedLower !== "CAF Champions League") {
    failures.push(`normalizeLeagueName("caf champions league") expected "CAF Champions League", got ${JSON.stringify(mappedLower)}`);
  }
  return failures;
};

// ── isStatsSite: API stats sources get STATS_CHUNK_SIZE (MINOR finding) ────
//
// loadDb.ts calls isStatsSite(url) with the SourceItem.url straight from
// dataSources.ts (see scripts/lib/scrapers/evaluators/statsEvaluator.ts for
// the verified call-path note) — so matching these hosts is what actually
// routes the espn-api/football-data-api/api-football standings entries onto
// STATS_CHUNK_SIZE like Understat.
const runIsStatsSiteTest = (): Failures => {
  const failures: Failures = [];
  const cases: Array<[string, boolean]> = [
    ["https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings", true],
    ["https://api.football-data.org/v4/competitions/PL/standings", true],
    ["https://v3.football.api-sports.io/standings?league=6", true],
    ["https://understat.com/league/EPL", true],
    ["https://www.bbc.com/sport/football", false],
  ];
  for (const [url, expected] of cases) {
    const actual = isStatsSite(url);
    if (actual !== expected) {
      failures.push(`isStatsSite(${JSON.stringify(url)}) expected ${expected}, got ${actual}`);
    }
  }
  return failures;
};

// ── Main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const allFailures: Failures = [];

  const suites: Array<[string, () => Failures | Promise<Failures>]> = [
    ["season-helpers", runSeasonHelperTests],
    ["espn-standings", runEspnStandingsTest],
    ["espn-scoreboard", runEspnScoreboardTest],
    ["wikipedia", runWikipediaTest],
    ["wikipedia-single-year-title", runWikipediaSingleYearTitleTest],
    ["wikipedia-rowspan-colspan", runWikipediaRowspanColspanTest],
    ["wikipedia-malformed-table", runWikipediaMalformedTableTest],
    ["openfootball", runOpenfootballTest],
    ["openfootball-epl-regression", runOpenfootballEplRegressionTest],
    ["football-data-org", runFootballDataOrgTest],
    ["football-data-org-not-started-fallback", runIsStandingsNotStartedTest],
    ["football-data-org-pacing", runPaceFootballDataTest],
    ["api-football", runApiFootballTest],
    ["normalize-league-name-caf", runNormalizeLeagueNameCafTest],
    ["is-stats-site", runIsStatsSiteTest],
  ];

  for (const [name, run] of suites) {
    const failures = await run();
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
