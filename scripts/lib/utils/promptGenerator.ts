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
