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

/**
 * Best-effort season resolution from a response's own embedded season year
 * — preferred over a caller-supplied/clock-derived guess, because upstream
 * APIs (football-data.org, API-Football, ESPN) keep serving a just-concluded
 * season as "current" until the new one kicks off. Defensive: a non-number
 * or non-finite value falls back to `fallbackSeason` untouched.
 */
const seasonFromYear = (year: unknown, fallbackSeason: string): string =>
  typeof year === "number" && Number.isFinite(year) ? seasonString(year) : fallbackSeason;

/**
 * Same idea as `seasonFromYear` but for an ISO date string (football-data.org
 * ships `season.startDate`, e.g. "2025-08-15") instead of a bare year.
 * Invalid/missing input falls back to `fallbackSeason`.
 */
const seasonFromStartDate = (startDate: unknown, fallbackSeason: string): string => {
  if (typeof startDate !== "string") return fallbackSeason;
  const parsed = new Date(startDate);
  return Number.isNaN(parsed.getTime()) ? fallbackSeason : seasonString(parsed.getUTCFullYear());
};

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

/**
 * Wraps a pure converter's call in try/catch — mechanically enforces every
 * exported fetch* function's "never throws" contract even if a converter
 * has a gap in its own defensive coding against a malformed upstream
 * response shape. Warns and returns null rather than letting the error
 * propagate and kill a seed run.
 */
const safeConvert = <T>(label: string, convert: () => T | null): T | null => {
  try {
    return convert();
  } catch (error) {
    console.warn(
      `[apiFetchers] ${label} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
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
  season?: { year?: number };
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
  const resolvedSeason = seasonFromYear(data.season?.year, season);
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
      `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${resolvedSeason}`,
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

  return [`# ${leagueName} ${resolvedSeason}`, "", ...sections].join("\n") + "\n";
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
  return safeConvert("espnStandingsToMarkdown", () => espnStandingsToMarkdown(json, leagueName, season));
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
  season?: { year?: number };
  events?: EspnEvent[];
}

/** Pure converter — no network. Exported so tests can run on fixture JSON. */
export const espnScoreboardToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as EspnScoreboardResponse;
  const resolvedSeason = seasonFromYear(data.season?.year, season);
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
    `# ${leagueName} ${resolvedSeason}`,
    "",
    "## Fixtures / Results",
    "",
    `> **Type:** ${type}  |  **League:** ${leagueName}  |  **Season:** ${resolvedSeason}`,
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
  return safeConvert("espnScoreboardToMarkdown", () => espnScoreboardToMarkdown(json, leagueName, season));
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

// One-line placeholder emitted instead of a table whose rowspan/colspan
// layout the grid model below can't expand safely — shipping a table with
// positionally-shifted cells is worse than omitting it.
const TABLE_OMITTED_NOTE = "*[table omitted: complex layout]*";

// Cap on any single rowspan/colspan value — defends against pathological or
// malformed markup (e.g. rowspan="999") turning into a huge/slow grid.
const MAX_SPAN = 100;

interface WikiCell {
  text: string;
  rowspan: number;
  colspan: number;
}

const parseSpanAttr = (attrs: string, name: "rowspan" | "colspan"): number => {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"));
  const n = match ? Number(match[1]) : 1;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_SPAN);
};

/** Extracts a <tr>'s cells with their rowspan/colspan, in document order. */
const parseRowCells = (rowInnerHtml: string): WikiCell[] =>
  [...rowInnerHtml.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((m) => ({
    text: cleanCellText(m[2]),
    rowspan: parseSpanAttr(m[1], "rowspan"),
    colspan: parseSpanAttr(m[1], "colspan"),
  }));

/**
 * Expands raw <tr> cell lists into a full grid, resolving rowspan/colspan so
 * a rowspanned cell's text is REPEATED into the same column of every
 * following row it spans, and a colspanned cell is repeated across the
 * columns it covers — instead of the naive per-<tr> extraction where a
 * rowspanned label cell vanishes and every subsequent cell on that row
 * silently shifts left.
 *
 * Walks each row column-by-column: at each column, an active carry-over
 * (from an earlier row's rowspan) is placed first; otherwise the next actual
 * cell in the row is placed (repeated across its colspan). Returns null when
 * the resulting rows don't all end up the same width — a layout this model
 * can't represent without risking a positional shift — so the caller can
 * skip the table entirely rather than ship shifted data.
 */
const expandTableGrid = (rows: WikiCell[][]): string[][] | null => {
  const carry = new Map<number, { text: string; remaining: number }>();
  const grid: string[][] = [];

  for (const rowCells of rows) {
    const rowArr: string[] = [];
    let col = 0;
    let cellIdx = 0;
    while (cellIdx < rowCells.length || carry.has(col)) {
      const active = carry.get(col);
      if (active) {
        rowArr[col] = active.text;
        active.remaining -= 1;
        if (active.remaining <= 0) carry.delete(col);
        col += 1;
        continue;
      }
      const cell = rowCells[cellIdx];
      // A colspanned cell must not overwrite a column an earlier rowspan is
      // still carrying into — that's a layout this model can't reconcile.
      for (let k = 0; k < cell.colspan; k += 1) {
        if (carry.has(col + k)) return null;
      }
      for (let k = 0; k < cell.colspan; k += 1) {
        rowArr[col + k] = cell.text;
        if (cell.rowspan > 1) {
          carry.set(col + k, { text: cell.text, remaining: cell.rowspan - 1 });
        }
      }
      col += cell.colspan;
      cellIdx += 1;
    }
    grid.push(rowArr);
  }

  const width = grid.length > 0 ? Math.max(...grid.map((r) => r.length)) : 0;
  if (width === 0 || grid.some((r) => r.length !== width)) return null;
  return grid;
};

const tableInnerToMarkdown = (inner: string): string | null => {
  const rowMatches = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) return null;

  const rawRows = rowMatches
    .slice(0, MAX_TABLE_ROWS + 1)
    .map((m) => parseRowCells(m[1]))
    .filter((cells) => cells.length > 0);
  if (rawRows.length === 0) return null;

  const grid = expandTableGrid(rawRows);
  if (grid === null) return TABLE_OMITTED_NOTE;

  const header = grid[0];
  const body = grid.slice(1);
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
 * Derives "2025/26" from a title. Two patterns, range takes precedence:
 *   1. A range title like "2025–26 Premier League" (en-dash or hyphen) ->
 *      seasonString of the range's start year.
 *   2. A standalone 4-digit year (1900–2100) like "2025 Africa Cup of
 *      Nations" -> seasonString(year). Single-edition tournaments named for
 *      the calendar year they start in (AFCON, World Cup) often run into the
 *      following year, so treating the bare year as a season-start year
 *      (not the current season) avoids mislabeling e.g. AFCON 2025
 *      (Dec 2025–Jan 2026) as the season that happens to be current when the
 *      article is fetched.
 * Falls back to the current season when the title has no year at all.
 */
const deriveSeasonFromTitle = (title: string): string => {
  const rangeMatch = title.match(/(\d{4})[–-](\d{2})\b/);
  if (rangeMatch) return seasonString(Number(rangeMatch[1]));

  const yearMatch = title.match(/\b(\d{4})\b/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (year >= 1900 && year <= 2100) return seasonString(year);
  }

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
  if (combined.length > MAX_WIKI_CHARS) {
    // Truncate at the last newline at/before the cap instead of a raw slice,
    // so the cut lands on a line boundary rather than mid markdown-table-row.
    const lastNewline = combined.lastIndexOf("\n", MAX_WIKI_CHARS);
    combined = combined.slice(0, lastNewline > 0 ? lastNewline : MAX_WIKI_CHARS);
  }
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
  return safeConvert("wikipediaHtmlToMarkdown", () =>
    wikipediaHtmlToMarkdown(text, json?.parse?.title ?? title, leagueName, category),
  );
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
 * Candidate season start years to try, in order — the requested startYear
 * first, then a one-time fallback to the previous season. Factored out as a
 * pure helper (no fetch) so the rollover decision is directly testable:
 * right after the July 1st season boundary (see currentSeasonStartYear),
 * the new season's openfootball file may not exist on GitHub yet, so a 404
 * for startYear should fall back to startYear - 1 rather than yielding zero
 * fixture content.
 */
export const openfootballCandidateYears = (startYear: number): number[] => [
  startYear,
  startYear - 1,
];

/**
 * Season folder format is "2025-26" (verified against the repo layout —
 * e.g. openfootball/football.json/2025-26/en.1.json). If the file is
 * absent for a given league/season, fetchJson's non-200 handling makes
 * this return null quietly — tried in turn via openfootballCandidateYears,
 * so a startYear 404 (season rollover window) retries startYear - 1 once.
 * The returned markdown carries whichever season's data it actually is.
 */
export const fetchOpenfootball = async (
  leaguePath: string,
  leagueName: string,
  startYear: number,
): Promise<string | null> => {
  const candidates = openfootballCandidateYears(startYear);
  for (let i = 0; i < candidates.length; i += 1) {
    const year = candidates[i];
    const seasonFolder = `${year}-${String(year + 1).slice(-2)}`;
    const url = `https://raw.githubusercontent.com/openfootball/football.json/master/${seasonFolder}/${leaguePath}.json`;
    const json = await fetchJson(url);
    if (!json) {
      if (i < candidates.length - 1) {
        console.warn(
          `[apiFetchers] openfootball ${leaguePath} ${seasonFolder} not found — falling back to previous season`,
        );
      }
      continue;
    }
    const season = seasonString(year);
    return safeConvert("openfootballToMarkdown", () => openfootballToMarkdown(json, leagueName, season));
  }
  return null;
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
  group?: string; // set for group-stage competitions, e.g. Champions League
  table?: FdoTableRow[];
}
interface FdoSeasonInfo {
  startDate?: string;
}
interface FdoStandingsResponse {
  season?: FdoSeasonInfo;
  standings?: FdoStanding[];
}

/**
 * True when a standings response carries zero usable information — either no
 * standings groups/rows at all, or every row's `playedGames` is 0 (the
 * season exists on football-data.org but hasn't kicked off yet). Pure and
 * exported so the season-fallback decision in `fetchFootballDataOrg` is
 * directly testable without mocking fetch.
 */
export const isStandingsNotStarted = (json: unknown): boolean => {
  const data = json as FdoStandingsResponse | null;
  const rows = (data?.standings ?? []).flatMap((group) => group?.table ?? []);
  if (rows.length === 0) return true;
  return rows.every((row) => (row?.playedGames ?? 0) === 0);
};

/**
 * Pure converter — no network. Exported so tests can run on fixture JSON.
 * Loops ALL standings groups (like the ESPN/API-Football converters do),
 * emitting one `## <group>` section each, instead of only the first TOTAL
 * group — a competition like Champions League has multiple groups, all of
 * which belong in the corpus. Defensive against malformed rows (missing
 * `team.name`): skip with a warn rather than throwing/emitting "undefined".
 */
export const footballDataOrgStandingsToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as FdoStandingsResponse;
  const resolvedSeason = seasonFromStartDate(data?.season?.startDate, season);
  const standings = data?.standings ?? [];
  const multiGroup = standings.length > 1;

  const sections: string[] = [];
  for (const group of standings) {
    const rows = group?.table ?? [];
    if (rows.length === 0) continue;
    const heading = multiGroup ? `## ${group?.group ?? group?.type ?? "Standings"}` : "## Standings";
    const lines = [
      heading,
      "",
      `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${resolvedSeason}`,
      "",
      HOUSE_TABLE_HEADER,
      HOUSE_TABLE_SEP,
    ];
    let rowCount = 0;
    for (const row of rows) {
      const teamName = row?.team?.name;
      if (!teamName) {
        console.warn("[apiFetchers] football-data.org standings row missing team.name — row skipped");
        continue;
      }
      rowCount += 1;
      lines.push(
        `| ${row.position ?? "-"} | ${teamName} | ${row.playedGames ?? "-"} | ${row.won ?? "-"} | ${row.draw ?? "-"} | ${row.lost ?? "-"} | ${row.goalsFor ?? "-"} | ${row.goalsAgainst ?? "-"} | ${row.goalDifference ?? "-"} | ${row.points ?? "-"} |`,
      );
    }
    if (rowCount > 0) sections.push(lines.join("\n"));
  }
  if (sections.length === 0) return null;

  return sections.join("\n\n");
};

interface FdoPlayer {
  name?: string;
}
interface FdoScorer {
  player?: FdoPlayer;
  team?: FdoTeam;
  goals?: number;
  assists?: number | null;
}
interface FdoScorersResponse {
  season?: FdoSeasonInfo;
  scorers?: FdoScorer[];
}

/**
 * Pure converter — no network. Exported so tests can run on fixture JSON.
 * Defensive against malformed rows (missing `player.name`/`team.name`): skip
 * with a warn rather than throwing/emitting "undefined".
 */
export const footballDataOrgScorersToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as FdoScorersResponse;
  const resolvedSeason = seasonFromStartDate(data?.season?.startDate, season);
  const scorers = data?.scorers ?? [];
  if (scorers.length === 0) return null;

  const lines = [
    "## Top Scorers",
    "",
    `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${resolvedSeason}`,
    "",
    "| # | Player | Team | Goals | Assists |",
    "|--:|:-------|:-----|------:|--------:|",
  ];
  let rank = 0;
  for (const s of scorers) {
    const playerName = s?.player?.name;
    const teamName = s?.team?.name;
    if (!playerName || !teamName) {
      console.warn("[apiFetchers] football-data.org scorer row missing player/team name — row skipped");
      continue;
    }
    rank += 1;
    lines.push(`| ${rank} | ${playerName} | ${teamName} | ${s.goals ?? "-"} | ${s.assists ?? 0} |`);
  }
  if (rank === 0) return null;
  return lines.join("\n");
};

/**
 * Standings + top scorers via football-data.org v4. KEY-GATED — do not call
 * until FOOTBALL_DATA_ORG_KEY (or equivalent) exists; there is no key today.
 * Competition codes: PL, PD, SA, BL1, FL1, CL.
 *
 * football-data.org's DEFAULT (no `?season=`) standings alias is internally
 * inconsistent right around the summer rollover: `season.startDate` already
 * points at the new season while the table itself is still the complete
 * previous one. Explicit `?season=` requests are self-consistent, so both
 * standings and scorers are always requested with an explicit season year:
 * try the current season-start year first, and if that standings response
 * is missing/empty or every row shows zero played games (season not started
 * — zero information), fall back to the previous season once. Scorers are
 * then requested with whichever year standings settled on, so the two
 * sections always describe the same season. Never retries beyond that one
 * fallback — a 403-style "restricted" error on either request already comes
 * back as `null` via the shared fetchJson plumbing and is left as null.
 */
export const fetchFootballDataOrg = async (
  competitionCode: string,
  leagueName: string,
  apiKey: string,
): Promise<string | null> => {
  const headers = { "X-Auth-Token": apiKey };
  const requestedYear = currentSeasonStartYear();

  let standingsJson = await fetchJson(
    `https://api.football-data.org/v4/competitions/${competitionCode}/standings?season=${requestedYear}`,
    headers,
  );
  let settledYear = requestedYear;
  if (isStandingsNotStarted(standingsJson)) {
    settledYear = requestedYear - 1;
    console.warn(
      `[apiFetchers] football-data.org ${competitionCode} season=${requestedYear} not started — falling back to season=${settledYear}`,
    );
    standingsJson = await fetchJson(
      `https://api.football-data.org/v4/competitions/${competitionCode}/standings?season=${settledYear}`,
      headers,
    );
  }

  const scorersJson = await fetchJson(
    `https://api.football-data.org/v4/competitions/${competitionCode}/scorers?season=${settledYear}`,
    headers,
  );

  // The response's own embedded season (its startDate year) is what the
  // document title must reflect. With explicit `?season=` requests this is
  // now consistent by construction — prefer the standings response's season,
  // falling back to the scorers response's, and finally to the settled
  // request year itself.
  const embeddedStartDate =
    (standingsJson as { season?: { startDate?: string } } | null)?.season?.startDate ??
    (scorersJson as { season?: { startDate?: string } } | null)?.season?.startDate;
  const season = seasonFromStartDate(embeddedStartDate, seasonString(settledYear));

  const sections: string[] = [];
  if (standingsJson) {
    const md = safeConvert("footballDataOrgStandingsToMarkdown", () =>
      footballDataOrgStandingsToMarkdown(standingsJson, leagueName, season),
    );
    if (md) sections.push(md);
  }
  if (scorersJson) {
    const md = safeConvert("footballDataOrgScorersToMarkdown", () =>
      footballDataOrgScorersToMarkdown(scorersJson, leagueName, season),
    );
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
  name?: string;
}
interface ApiFootballGoals {
  for?: number;
  against?: number;
}
interface ApiFootballStandingEntry {
  rank?: number;
  team?: ApiFootballTeam;
  points?: number;
  goalsDiff?: number;
  all?: { played?: number; win?: number; draw?: number; lose?: number; goals?: ApiFootballGoals };
}
interface ApiFootballLeagueBlock {
  league?: { season?: number; standings?: ApiFootballStandingEntry[][] };
}
interface ApiFootballStandingsResponse {
  response?: ApiFootballLeagueBlock[];
}

/**
 * Pure converter — no network. Exported so tests can run on fixture JSON.
 * Defensive against malformed rows (missing `team.name`): skip with a warn
 * rather than throwing/emitting "undefined".
 */
export const apiFootballStandingsToMarkdown = (
  json: unknown,
  leagueName: string,
  season: string,
): string | null => {
  const data = json as ApiFootballStandingsResponse;
  const resolvedSeason = seasonFromYear(data?.response?.[0]?.league?.season, season);
  const groups = data?.response?.[0]?.league?.standings ?? [];
  const multiGroup = groups.length > 1;

  const sections: string[] = [];
  groups.forEach((group, idx) => {
    if (!group || group.length === 0) return;
    const heading = multiGroup ? `## Group ${idx + 1}` : "## Standings";
    const lines = [
      heading,
      "",
      `> **Type:** Standings  |  **League:** ${leagueName}  |  **Season:** ${resolvedSeason}`,
      "",
      HOUSE_TABLE_HEADER,
      HOUSE_TABLE_SEP,
    ];
    let rowCount = 0;
    for (const row of group) {
      const teamName = row?.team?.name;
      if (!teamName) {
        console.warn("[apiFetchers] api-football standings row missing team.name — row skipped");
        continue;
      }
      rowCount += 1;
      const all = row.all;
      lines.push(
        `| ${row.rank ?? "-"} | ${teamName} | ${all?.played ?? "-"} | ${all?.win ?? "-"} | ${all?.draw ?? "-"} | ${all?.lose ?? "-"} | ${all?.goals?.for ?? "-"} | ${all?.goals?.against ?? "-"} | ${row.goalsDiff ?? "-"} | ${row.points ?? "-"} |`,
      );
    }
    if (rowCount > 0) sections.push(lines.join("\n"));
  });
  if (sections.length === 0) return null;

  return [`# ${leagueName} ${resolvedSeason}`, "", ...sections].join("\n") + "\n";
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
  return safeConvert("apiFootballStandingsToMarkdown", () =>
    apiFootballStandingsToMarkdown(json, leagueName, seasonLabel),
  );
};
