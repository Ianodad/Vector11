// Corpus-driven suggested prompts — deterministic template instantiation, NO
// LLM calls. Regenerated on every weekly seed from what the corpus actually
// contains (season, leagues present, and a few concrete facts), so the UI's
// suggested questions follow the corpus instead of being hardcoded to a
// season that eventually goes stale.

export interface CorpusFacts {
  season: string; // e.g. "2025/26" — as it appears in corpus metadata
  leagues: string[]; // e.g. ["EPL", "La Liga", "Serie A", ...]
  champions?: Record<string, string>; // league -> team, when known
  topScorers?: Record<string, { player: string; goals?: number }>; // league -> scorer
}

// The "Big Five" leagues get the full per-league template set (standings,
// players, fixtures, form/analysis). Champions League and AFCON get their
// own smaller, competition-shaped template sets instead (group stages /
// knockouts rather than a single continuous table).
const BIG_FIVE_LEAGUES = ["EPL", "La Liga", "Serie A", "Bundesliga", "Ligue 1"];

const bigFiveLeaguePrompts = (season: string, league: string): string[] => [
  `What were the final ${season} ${league} standings?`,
  `Which ${league} teams finished in the top four for ${season}?`,
  `Which ${league} teams finished in the relegation zone in ${season}?`,
  `Who were the top scorers in the ${season} ${league}?`,
  `Which ${league} players had the most assists in ${season}?`,
  `What were the biggest results of the ${season} ${league} season?`,
  `Which ${league} teams overperformed their xPTS in ${season}?`,
  `Which ${league} teams had the best defensive record in ${season}?`,
];

const championsLeaguePrompts = (season: string): string[] => [
  `What were the ${season} UEFA Champions League standings and results?`,
  `Who were the top scorers in the ${season} Champions League?`,
  `Which teams reached the knockout stages of the ${season} Champions League?`,
  `What were the biggest results in the ${season} Champions League?`,
];

const afconPrompts = (season: string): string[] => [
  `What were the ${season} AFCON group standings?`,
  `Who were the top scorers at the ${season} AFCON?`,
  `Which African national teams performed best at the ${season} AFCON?`,
  `What were the key results from the ${season} AFCON?`,
];

const factBasedPrompts = (
  season: string,
  leagues: string[],
  champions?: Record<string, string>,
  topScorers?: Record<string, { player: string; goals?: number }>,
): string[] => {
  const prompts: string[] = [];
  for (const league of leagues) {
    const champion = champions?.[league];
    if (champion) {
      prompts.push(`How many points did ${champion} win the ${season} ${league} with?`);
      prompts.push(`How did ${champion} win the ${season} ${league} title?`);
    }
    const scorer = topScorers?.[league];
    if (scorer?.player) {
      prompts.push(`How many goals did ${scorer.player} score in the ${season} ${league} season?`);
    }
  }
  return prompts;
};

// One comparison template per league pair actually present. Capped so a
// corpus with many leagues doesn't blow the ~50–70 prompt budget on
// combinatorics alone.
const MAX_CROSS_LEAGUE_PAIRS = 8;

const crossLeaguePrompts = (season: string, leagues: string[]): string[] => {
  const present = BIG_FIVE_LEAGUES.filter((league) => leagues.includes(league));
  const prompts: string[] = [];
  outer: for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      if (prompts.length >= MAX_CROSS_LEAGUE_PAIRS) break outer;
      prompts.push(`How do the ${season} ${present[i]} and ${present[j]} title races compare?`);
    }
  }
  return prompts;
};

const evergreenPrompts = (season: string): string[] => [
  `Which teams are overperforming their xG in ${season}?`,
  `Which teams are underperforming their xG in ${season}?`,
  `Which teams are overperforming their xPTS in ${season}?`,
  `Which teams have the best clean sheet record in ${season}?`,
  `How do the ${season} standings compare to expected points (xPTS) across the leagues in this database?`,
];

/**
 * Deterministic template instantiation from corpus facts. No LLM calls.
 * Only generates league-specific prompts for leagues present in
 * `facts.leagues`. De-duplicates and returns a stable order — any
 * randomness (rotation) stays client-side.
 */
export const generatePrompts = (facts: CorpusFacts): string[] => {
  const { season, leagues, champions, topScorers } = facts;
  const collected: string[] = [];

  for (const league of BIG_FIVE_LEAGUES) {
    if (leagues.includes(league)) {
      collected.push(...bigFiveLeaguePrompts(season, league));
    }
  }

  if (leagues.includes("Champions League")) {
    collected.push(...championsLeaguePrompts(season));
  }

  if (leagues.includes("AFCON")) {
    collected.push(...afconPrompts(season));
  }

  collected.push(...factBasedPrompts(season, leagues, champions, topScorers));
  collected.push(...crossLeaguePrompts(season, leagues));
  collected.push(...evergreenPrompts(season));

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const prompt of collected) {
    if (!seen.has(prompt)) {
      seen.add(prompt);
      deduped.push(prompt);
    }
  }
  return deduped;
};

// --- Corpus facts capture (moved from scripts/loadDb.ts) -------------------
//
// This is prompt-domain logic (it feeds the `CorpusFacts` this file
// consumes), so it lives here rather than in the seed entrypoint. loadDb.ts
// imports these back in; scripts/validatePrompts.ts imports them directly so
// the regression tests don't have to go through the seed entrypoint.

// Normalizes doc-header league names (e.g. "Premier League") and Understat's
// own display names into the short codes CorpusFacts/generatePrompts expect.
// Case-insensitive: the real corpus tags Champions League docs via a slug
// round-trip that title-cases the acronym (e.g. "Uefa Champions League"), so
// the lookup key is lowercased on both sides.
export const LEAGUE_DISPLAY_TO_CODE: Record<string, string> = {
  "premier league": "EPL",
  epl: "EPL",
  "la liga": "La Liga",
  "serie a": "Serie A",
  bundesliga: "Bundesliga",
  "ligue 1": "Ligue 1",
  "champions league": "Champions League",
  "uefa champions league": "Champions League",
  "europa league": "Europa League",
  "uefa europa league": "Europa League",
  afcon: "AFCON",
};

export const normalizeLeagueName = (raw: string): string => {
  const trimmed = raw.trim();
  return LEAGUE_DISPLAY_TO_CODE[trimmed.toLowerCase()] ?? trimmed;
};

// Generic/unusable league labels that occasionally leak through the header
// parser (e.g. a stray "Football" tag) — not real league identifiers, so
// they'd only add noise to the suggested-prompts leagues list without gating
// anything useful. Filtered out at capture time; unknown-but-specific names
// are left as-is.
const GENERIC_LEAGUE_NAMES = new Set(["football"]);

export const isGenericLeagueName = (name: string): boolean =>
  GENERIC_LEAGUE_NAMES.has(name.trim().toLowerCase());

// Only these two leagues are cheaply and reliably derivable from the
// combined Understat markdown (league-page URL slug -> canonical code).
// Scoped deliberately per the task spec rather than attempting every league.
const UNDERSTAT_FACT_LEAGUES: Record<string, string> = {
  EPL: "EPL",
  La_liga: "La Liga",
};

export interface UnderstatSeasonFacts {
  champions: Record<string, string>;
  topScorers: Record<string, { player: string; goals?: number }>;
}

// Returns the text between `heading` (exclusive) and the next "## " heading
// (or end of string) — used to scope a row-position regex to one specific
// table section instead of matching the first "| 1 | ... |" anywhere.
const extractSection = (content: string, heading: string): string => {
  const idx = content.indexOf(heading);
  if (idx === -1) return "";
  const rest = content.slice(idx + heading.length);
  const nextHeadingIdx = rest.search(/\n##\s/);
  return nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
};

// Pulls the cells of the first data row (rank "1") out of a markdown table
// section, e.g. "| 1 | Liverpool | 38 | ... |" -> ["", "1", "Liverpool", ...].
const firstDataRowCells = (section: string): string[] | null => {
  const match = section.match(/\n(\|\s*1\s*\|[^\n]*)/);
  if (!match) return null;
  return match[1].split("|").map((cell) => cell.trim());
};

// Captures the completed-season champion (standings leader, only once the
// fixture list shows zero matches remaining) and the current top scorer from
// a combined Understat league markdown document, for EPL/La Liga only.
export const captureUnderstatFacts = (
  content: string,
  url: string,
  bySeason: Map<string, UnderstatSeasonFacts>,
): void => {
  const leagueSlugMatch = url.match(/understat\.com\/league\/([^/?#]+)/);
  const leagueCode = leagueSlugMatch ? UNDERSTAT_FACT_LEAGUES[leagueSlugMatch[1]] : undefined;
  if (!leagueCode) return;

  const seasonMatch = content.match(/\*\*Season:\*\*\s*([^|\n]+)/);
  const season = seasonMatch?.[1]?.trim();
  if (!season) return;

  const bucket = bySeason.get(season) ?? { champions: {}, topScorers: {} };

  const standingsCells = firstDataRowCells(extractSection(content, "## Standings"));
  const remainingMatch = content.match(/\*\*Remaining:\*\*\s*(\d+)/);
  const isCompletedSeason = remainingMatch ? Number(remainingMatch[1]) === 0 : false;
  if (standingsCells?.[2] && isCompletedSeason) {
    bucket.champions[leagueCode] = standingsCells[2];
  }

  const rankingCells = firstDataRowCells(extractSection(content, "## Rankings"));
  if (rankingCells?.[2]) {
    const goals = Number(rankingCells[6]);
    bucket.topScorers[leagueCode] = {
      player: rankingCells[2],
      ...(Number.isFinite(goals) ? { goals } : {}),
    };
  }

  bySeason.set(season, bucket);
};
