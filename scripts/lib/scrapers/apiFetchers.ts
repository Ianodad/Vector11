// API-based fetchers for the seed pipeline — zero-key JSON/REST sources
// (ESPN, Wikipedia MediaWiki, openfootball) plus key-gated sources
// (football-data.org, API-Football) that are wired in once a key exists.
//
// Every fetcher returns Promise<string | null> — a markdown document in the
// corpus house format, or null on no-data. Converters are pure functions
// separated from network I/O so they can be exercised offline on fixtures
// (see scripts/validateSources.ts).
//
// House format:
//   # <Competition> <Season>
//   ## <Section>
//   > **Type:** <Standings|Fixtures|Results|Mixed>  |  **League:** <League>  |  **Season:** <YYYY/YY>
//   <markdown table(s)>
// Each `## ` section repeats its own `> **Type:** …` header line — the
// chunker (scripts/lib/utils/markdownChunker.ts) resolves metadata
// per-section, falling back to an enclosing scope only when a section omits
// a field.

// ── Season helpers ──────────────────────────────────────────────────────────

/**
 * European season boundary: from July 1st onward the season start year is
 * the current year; before that it's the previous year. July (not August)
 * so pre-season summer content (transfers, friendlies) lands in the
 * upcoming season instead of the one that just ended.
 */
export const currentSeasonStartYear = (now: Date = new Date()): number => {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  return month >= 7 ? year : year - 1;
};

/** "2025/26" from a season start year. */
export const seasonString = (startYear: number): string =>
  `${startYear}/${String(startYear + 1).slice(-2)}`;

/** Understat uses the bare start year as its season path segment: "2025". */
export const understatSeasonPath = (startYear: number): string => String(startYear);

// ── Shared plumbing ─────────────────────────────────────────────────────────

/**
 * One shared JSON fetch helper with an AbortController timeout. Never
 * throws — a dead/rate-limited endpoint must not kill a seed run. Callers
 * treat a null return as "no data" and move on.
 */
export const fetchJson = async <T = unknown>(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = 15000,
): Promise<T | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      console.warn(`[apiFetchers] ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.warn(
      `[apiFetchers] ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const HOUSE_TABLE_HEADER =
  "| Pos | Team | MP | W | D | L | GF | GA | GD | Pts |";
const HOUSE_TABLE_SEP =
  "|----:|:-----|--:|--:|--:|--:|---:|---:|---:|----:|";

// ── ESPN JSON API (no key) ──────────────────────────────────────────────────

interface EspnStatEntry {
  name: string;
  displayValue?: string;
}
interface EspnStandingsEntry {
  team?: { displayName?: string };
  stats?: EspnStatEntry[];
}
interface EspnStandingsGroup {
  name?: string;
  standings?: { entries?: EspnStandingsEntry[] };
}
interface EspnStandingsResponse {
  children?: EspnStandingsGroup[];
}

const espnStat = (stats: EspnStatEntry[] | undefined, name: string): string =>
  stats?.find((s) => s.name === name)?.displayValue ?? "-";

/** Pure converter — no network. Exported so tests can run on fixture JSON. */
export const espnStandingsToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as EspnStandingsResponse;
  const groups = data.children ?? [];
  const multiGroup = groups.length > 1;

  const sections: string[] = [];
  for (const group of groups) {
    const entries = group.standings?.entries ?? [];
    if (entries.length === 0) continue;
    const heading = multiGroup ? `## ${group.name ?? "Group"}` : "## Standings";
    const lines = [
      heading,
      "",
      `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${season}`,
      "",
      HOUSE_TABLE_HEADER,
      HOUSE_TABLE_SEP,
    ];
    entries.forEach((entry, idx) => {
      const stats = entry.stats;
      const rank = espnStat(stats, "rank");
      const pos = rank !== "-" ? rank : String(idx + 1);
      lines.push(
        `| ${pos} | ${entry.team?.displayName ?? "Unknown"} | ${espnStat(stats, "gamesPlayed")} | ${espnStat(stats, "wins")} | ${espnStat(stats, "ties")} | ${espnStat(stats, "losses")} | ${espnStat(stats, "pointsFor")} | ${espnStat(stats, "pointsAgainst")} | ${espnStat(stats, "pointDifferential")} | ${espnStat(stats, "points")} |`,
      );
    });
    sections.push(lines.join("\n"));
  }
  if (sections.length === 0) return null;

  return [`# ${leagueName} ${season}`, "", ...sections].join("\n") + "\n";
};

export const fetchEspnStandings = async (
  leagueCode: string,
  leagueName: string,
): Promise<string | null> => {
  const season = seasonString(currentSeasonStartYear());
  const json = await fetchJson(
    `https://site.api.espn.com/apis/v2/sports/soccer/${leagueCode}/standings`,
  );
  if (!json) return null;
  return espnStandingsToMarkdown(json, leagueName, season);
};

interface EspnCompetitor {
  homeAway?: "home" | "away";
  team?: { displayName?: string };
  score?: string;
}
interface EspnCompetitionStatusType {
  completed?: boolean;
  description?: string;
}
interface EspnCompetition {
  competitors?: EspnCompetitor[];
  status?: { type?: EspnCompetitionStatusType };
}
interface EspnEvent {
  date?: string;
  competitions?: EspnCompetition[];
}
interface EspnScoreboardResponse {
  events?: EspnEvent[];
}

/** Pure converter — no network. Exported so tests can run on fixture JSON. */
export const espnScoreboardToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as EspnScoreboardResponse;
  const events = data.events ?? [];
  if (events.length === 0) return null;

  const rows: string[] = [];
  let anyCompleted = false;
  let anyScheduled = false;
  for (const event of events) {
    const comp = event.competitions?.[0];
    const competitors = comp?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const completed = Boolean(comp?.status?.type?.completed);
    if (completed) anyCompleted = true;
    else anyScheduled = true;
    const date = event.date ? event.date.slice(0, 10) : "-";
    const result = completed
      ? `${home.score ?? "-"} - ${away.score ?? "-"}`
      : (comp?.status?.type?.description ?? "Scheduled");
    rows.push(
      `| ${date} | ${home.team?.displayName ?? "Unknown"} | ${away.team?.displayName ?? "Unknown"} | ${result} |`,
    );
  }
  if (rows.length === 0) return null;

  const type = anyCompleted && anyScheduled ? "Mixed" : anyCompleted ? "Results" : "Fixtures";

  const lines = [
    `# ${leagueName} ${season}`,
    "",
    "## Fixtures / Results",
    "",
    `> **Type:** ${type}  |  **League:** ${leagueName}  |  **Season:** ${season}`,
    "",
    "| Date | Home | Away | Result |",
    "|:-----|:-----|:-----|:-------|",
    ...rows,
  ];
  return lines.join("\n") + "\n";
};

export const fetchEspnScoreboard = async (
  leagueCode: string,
  leagueName: string,
): Promise<string | null> => {
  const season = seasonString(currentSeasonStartYear());
  const json = await fetchJson(
    `https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueCode}/scoreboard`,
  );
  if (!json) return null;
  return espnScoreboardToMarkdown(json, leagueName, season);
};

// ── Wikipedia MediaWiki API (no key) ────────────────────────────────────────
//
// htmlScraper.ts does not use cheerio (it is Puppeteer-based) and cheerio is
// not a project dependency, so per the "no new dependencies" rule this is a
// minimal local regex-based HTML→markdown conversion rather than an actual
// cheerio import. Best-effort only: tables → markdown tables, paragraphs →
// text, refs/citations and edit-section links stripped, output capped at
// ~40k chars. Deeply nested markup (e.g. a table nested inside another
// table's cell) is not guaranteed to round-trip perfectly — acceptable for
// RAG corpus ingestion, not a general-purpose HTML parser.

const decodeHtmlEntities = (s: string): string =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));

const stripTags = (html: string): string =>
  decodeHtmlEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Removes style/script blocks, reference citations, and [edit] links. */
const sanitizeWikiHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "");

/** Extracts top-level <table> blocks by depth-counting nested table tags. */
const extractTopLevelTables = (html: string): string[] => {
  const tables: string[] = [];
  const openTagRe = /<table\b[^>]*>/gi;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openTagRe.exec(html)) !== null) {
    const isWikitable = /class\s*=\s*"[^"]*wikitable[^"]*"/i.test(openMatch[0]);
    const contentStart = openTagRe.lastIndex;
    const tagScanRe = /<\/?table\b[^>]*>/gi;
    tagScanRe.lastIndex = contentStart;
    let depth = 1;
    let endIdx = html.length;
    let scanMatch: RegExpExecArray | null;
    while ((scanMatch = tagScanRe.exec(html)) !== null) {
      if (scanMatch[0].startsWith("</")) {
        depth -= 1;
        if (depth === 0) {
          endIdx = scanMatch.index;
          break;
        }
      } else {
        depth += 1;
      }
    }
    if (isWikitable) tables.push(html.slice(contentStart, endIdx));
    openTagRe.lastIndex = endIdx + "</table>".length;
  }
  return tables;
};

const cleanCellText = (cellHtml: string): string => {
  const text = stripTags(cellHtml).replace(/\|/g, "\\|");
  return text || "-";
};

const MAX_TABLE_ROWS = 60;

const tableInnerToMarkdown = (inner: string): string | null => {
  const rowMatches = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) return null;

  const rows: string[][] = [];
  for (const rowMatch of rowMatches.slice(0, MAX_TABLE_ROWS + 1)) {
    const cellMatches = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    if (cellMatches.length === 0) continue;
    rows.push(cellMatches.map((c) => cleanCellText(c[1])));
  }
  if (rows.length === 0) return null;

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const copy = [...r];
    while (copy.length < width) copy.push("-");
    return copy;
  };

  const header = pad(rows[0]);
  const body = rows.slice(1).map(pad);
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
};

const MAX_TABLES = 6;

const extractWikiTables = (html: string): string[] =>
  extractTopLevelTables(html)
    .slice(0, MAX_TABLES)
    .map(tableInnerToMarkdown)
    .filter((t): t is string => Boolean(t));

const MAX_PARAGRAPHS = 8;
const MIN_PARAGRAPH_CHARS = 40;

const extractWikiParagraphs = (html: string): string => {
  const paraMatches = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  const texts: string[] = [];
  for (const m of paraMatches) {
    const text = stripTags(m[1]);
    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    texts.push(text);
    if (texts.length >= MAX_PARAGRAPHS) break;
  }
  return texts.join("\n\n");
};

const ALLOWED_DOC_TYPES = new Set(["Standings", "Fixtures", "Results", "Mixed"]);

const resolveDocType = (category: string): string => {
  const trimmed = category.trim();
  const titled = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  return ALLOWED_DOC_TYPES.has(titled) ? titled : "Mixed";
};

/**
 * Derives "2025/26" from a title like "2025–26 Premier League" (en-dash or
 * hyphen); falls back to the current season when the title has no year.
 */
const deriveSeasonFromTitle = (title: string): string => {
  const match = title.match(/(\d{4})[–-](\d{2})\b/);
  if (match) return seasonString(Number(match[1]));
  return seasonString(currentSeasonStartYear());
};

const MAX_WIKI_CHARS = 40_000;

/** Pure converter — no network. Exported so tests can run on fixture HTML. */
export const wikipediaHtmlToMarkdown = (
  html: string,
  title: string,
  leagueName: string,
  category: string,
): string | null => {
  const cleaned = sanitizeWikiHtml(html);
  const tables = extractWikiTables(cleaned);
  const paragraphs = extractWikiParagraphs(cleaned);
  if (tables.length === 0 && !paragraphs) return null;

  const season = deriveSeasonFromTitle(title);
  const docType = resolveDocType(category);

  const parts: string[] = [
    `# ${leagueName} ${season}`,
    "",
    `## ${title}`,
    "",
    `> **Type:** ${docType}  |  **League:** ${leagueName}  |  **Season:** ${season}`,
    "",
  ];
  if (paragraphs) parts.push(paragraphs, "");
  for (const table of tables) parts.push(table, "");

  let combined = parts.join("\n").trim() + "\n";
  if (combined.length > MAX_WIKI_CHARS) combined = combined.slice(0, MAX_WIKI_CHARS);
  return combined;
};

interface WikipediaParseResponse {
  parse?: { text?: string; title?: string };
}

export const fetchWikipediaArticle = async (
  title: string,
  leagueName: string,
  category: string,
): Promise<string | null> => {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&formatversion=2`;
  const json = await fetchJson<WikipediaParseResponse>(url);
  const text = json?.parse?.text;
  if (!text) return null;
  return wikipediaHtmlToMarkdown(text, json?.parse?.title ?? title, leagueName, category);
};

// ── openfootball JSON (no key) ──────────────────────────────────────────────

type OpenfootballScore = { ft?: [number, number]; ht?: [number, number] } | [number, number];

interface OpenfootballMatch {
  round?: string;
  date?: string;
  time?: string;
  team1: string;
  team2: string;
  score?: OpenfootballScore;
}
interface OpenfootballResponse {
  matches?: OpenfootballMatch[];
}

const extractOpenfootballScore = (
  score: OpenfootballScore | undefined,
): [number, number] | null => {
  if (!score) return null;
  if (Array.isArray(score)) {
    return score.length >= 2 && typeof score[0] === "number" && typeof score[1] === "number"
      ? [score[0], score[1]]
      : null;
  }
  if (score.ft && score.ft.length >= 2) return [score.ft[0], score.ft[1]];
  return null;
};

/** Pure converter — no network. Exported so tests can run on fixture JSON. */
export const openfootballToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as OpenfootballResponse;
  const matches = data.matches ?? [];
  if (matches.length === 0) return null;

  const byRound = new Map<string, OpenfootballMatch[]>();
  for (const m of matches) {
    const round = m.round ?? "Fixtures";
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round)!.push(m);
  }

  const sections: string[] = [];
  for (const [round, roundMatches] of byRound) {
    const playedCount = roundMatches.filter((m) => extractOpenfootballScore(m.score) !== null).length;
    const type =
      playedCount === roundMatches.length ? "Results" : playedCount === 0 ? "Fixtures" : "Mixed";
    const lines = [
      `## ${round}`,
      "",
      `> **Type:** ${type}  |  **League:** ${leagueName}  |  **Season:** ${season}`,
      "",
      "| Date | Home | Away | Result |",
      "|:-----|:-----|:-----|:-------|",
    ];
    for (const m of roundMatches) {
      const sc = extractOpenfootballScore(m.score);
      const result = sc ? `${sc[0]} - ${sc[1]}` : (m.time ?? "TBC");
      lines.push(`| ${m.date ?? "-"} | ${m.team1} | ${m.team2} | ${result} |`);
    }
    sections.push(lines.join("\n"));
  }
  if (sections.length === 0) return null;

  return [`# ${leagueName} ${season}`, "", ...sections].join("\n") + "\n";
};

/**
 * Season folder format is "2025-26" (verified against the repo layout —
 * e.g. openfootball/football.json/2025-26/en.1.json). If the file is
 * absent for a given league/season, fetchJson's non-200 handling makes
 * this return null quietly.
 */
export const fetchOpenfootball = async (
  leaguePath: string,
  leagueName: string,
  startYear: number,
): Promise<string | null> => {
  const seasonFolder = `${startYear}-${String(startYear + 1).slice(-2)}`;
  const season = seasonString(startYear);
  const url = `https://raw.githubusercontent.com/openfootball/football.json/master/${seasonFolder}/${leaguePath}.json`;
  const json = await fetchJson(url);
  if (!json) return null;
  return openfootballToMarkdown(json, leagueName, season);
};

// ── football-data.org (KEY-GATED) ───────────────────────────────────────────
// Not called live — no key exists yet. Converters are built from the
// documented v4 response schema (fixture JSON hand-built to match those
// docs; see scripts/validateSources.ts, marked as hand-built there).

interface FdoTeam {
  name: string;
}
interface FdoTableRow {
  position: number;
  team: FdoTeam;
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
}
interface FdoStanding {
  type?: string;
  table: FdoTableRow[];
}
interface FdoStandingsResponse {
  standings?: FdoStanding[];
}

/** Pure converter — no network. Exported so tests can run on fixture JSON. */
export const footballDataOrgStandingsToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as FdoStandingsResponse;
  const standings = data.standings ?? [];
  const total = standings.find((s) => s.type === "TOTAL") ?? standings[0];
  if (!total || total.table.length === 0) return null;

  const lines = [
    "## Standings",
    "",
    `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${season}`,
    "",
    HOUSE_TABLE_HEADER,
    HOUSE_TABLE_SEP,
  ];
  for (const row of total.table) {
    lines.push(
      `| ${row.position} | ${row.team.name} | ${row.playedGames} | ${row.won} | ${row.draw} | ${row.lost} | ${row.goalsFor} | ${row.goalsAgainst} | ${row.goalDifference} | ${row.points} |`,
    );
  }
  return lines.join("\n");
};

interface FdoPlayer {
  name: string;
}
interface FdoScorer {
  player: FdoPlayer;
  team: FdoTeam;
  goals: number;
  assists?: number | null;
}
interface FdoScorersResponse {
  scorers?: FdoScorer[];
}

/** Pure converter — no network. Exported so tests can run on fixture JSON. */
export const footballDataOrgScorersToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as FdoScorersResponse;
  const scorers = data.scorers ?? [];
  if (scorers.length === 0) return null;

  const lines = [
    "## Top Scorers",
    "",
    `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${season}`,
    "",
    "| # | Player | Team | Goals | Assists |",
    "|--:|:-------|:-----|------:|--------:|",
  ];
  scorers.forEach((s, i) => {
    lines.push(`| ${i + 1} | ${s.player.name} | ${s.team.name} | ${s.goals} | ${s.assists ?? 0} |`);
  });
  return lines.join("\n");
};

/**
 * Standings + top scorers via football-data.org v4. KEY-GATED — do not call
 * until FOOTBALL_DATA_ORG_KEY (or equivalent) exists; there is no key today.
 * Competition codes: PL, PD, SA, BL1, FL1, CL.
 */
export const fetchFootballDataOrg = async (
  competitionCode: string,
  leagueName: string,
  apiKey: string,
): Promise<string | null> => {
  const season = seasonString(currentSeasonStartYear());
  const headers = { "X-Auth-Token": apiKey };

  const [standingsJson, scorersJson] = await Promise.all([
    fetchJson(`https://api.football-data.org/v4/competitions/${competitionCode}/standings`, headers),
    fetchJson(`https://api.football-data.org/v4/competitions/${competitionCode}/scorers`, headers),
  ]);

  const sections: string[] = [];
  if (standingsJson) {
    const md = footballDataOrgStandingsToMarkdown(standingsJson, leagueName, season);
    if (md) sections.push(md);
  }
  if (scorersJson) {
    const md = footballDataOrgScorersToMarkdown(scorersJson, leagueName, season);
    if (md) sections.push(md);
  }
  if (sections.length === 0) return null;

  return [`# ${leagueName} ${season}`, "", ...sections].join("\n") + "\n";
};

// ── API-Football (api-sports.io) (KEY-GATED) ────────────────────────────────
// Not called live — no key exists yet. Converter built from the documented
// v3 `/standings` response schema (fixture JSON hand-built to match those
// docs; see scripts/validateSources.ts, marked as hand-built there).

interface ApiFootballTeam {
  name: string;
}
interface ApiFootballGoals {
  for: number;
  against: number;
}
interface ApiFootballStandingEntry {
  rank: number;
  team: ApiFootballTeam;
  points: number;
  goalsDiff: number;
  all: { played: number; win: number; draw: number; lose: number; goals: ApiFootballGoals };
}
interface ApiFootballLeagueBlock {
  league?: { standings?: ApiFootballStandingEntry[][] };
}
interface ApiFootballStandingsResponse {
  response?: ApiFootballLeagueBlock[];
}

/** Pure converter — no network. Exported so tests can run on fixture JSON. */
export const apiFootballStandingsToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as ApiFootballStandingsResponse;
  const groups = data.response?.[0]?.league?.standings ?? [];
  const multiGroup = groups.length > 1;

  const sections: string[] = [];
  groups.forEach((group, idx) => {
    if (group.length === 0) return;
    const heading = multiGroup ? `## Group ${idx + 1}` : "## Standings";
    const lines = [
      heading,
      "",
      `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${season}`,
      "",
      HOUSE_TABLE_HEADER,
      HOUSE_TABLE_SEP,
    ];
    for (const row of group) {
      lines.push(
        `| ${row.rank} | ${row.team.name} | ${row.all.played} | ${row.all.win} | ${row.all.draw} | ${row.all.lose} | ${row.all.goals.for} | ${row.all.goals.against} | ${row.goalsDiff} | ${row.points} |`,
      );
    }
    sections.push(lines.join("\n"));
  });
  if (sections.length === 0) return null;

  return [`# ${leagueName} ${season}`, "", ...sections].join("\n") + "\n";
};

/**
 * Standings via api-sports.io v3. KEY-GATED — do not call until an
 * API-Football key exists; there is no key today. League ids: 39 EPL,
 * 140 La Liga, 135 Serie A, 78 Bundesliga, 61 Ligue 1, 2 UCL, 6 AFCON,
 * 12 CAF Champions League.
 */
export const fetchApiFootball = async (
  leagueId: number,
  leagueName: string,
  season: number,
  apiKey: string,
): Promise<string | null> => {
  const seasonLabel = seasonString(season);
  const url = `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`;
  const json = await fetchJson(url, { "x-apisports-key": apiKey });
  if (!json) return null;
  return apiFootballStandingsToMarkdown(json, leagueName, seasonLabel);
};
