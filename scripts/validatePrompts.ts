// Standalone validation for the suggested-prompts corpus-facts pipeline.
// Mirrors scripts/validateChunking.ts's standalone style: run assertions,
// print per-test lines, exit non-zero on failure. Touches nothing — no DB,
// no network. Run with: npx tsx scripts/validatePrompts.ts
import {
  generatePrompts,
  normalizeLeagueName,
  captureUnderstatFacts,
  type CorpusFacts,
  type UnderstatSeasonFacts,
} from "./lib/utils/promptGenerator.js";

type Failures = string[];

// --- normalizeLeagueName ----------------------------------------------------
// Regression for the MAJOR review finding: the real corpus tags Champions
// League docs via a slug round-trip that title-cases the acronym into
// "Uefa Champions League", which the old case-sensitive map didn't contain —
// so championsLeaguePrompts never fired.
const runNormalizeLeagueNameTest = (): Failures => {
  const failures: Failures = [];

  const cases: Array<{ input: string; expected: string }> = [
    { input: "Uefa Champions League", expected: "Champions League" },
    { input: "Premier League", expected: "EPL" },
    { input: "premier league", expected: "EPL" },
  ];

  for (const { input, expected } of cases) {
    const actual = normalizeLeagueName(input);
    console.log(`  normalizeLeagueName(${JSON.stringify(input)}) -> ${JSON.stringify(actual)}`);
    if (actual !== expected) {
      failures.push(
        `normalizeLeagueName(${JSON.stringify(input)}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }

  return failures;
};

// --- captureUnderstatFacts ---------------------------------------------------
// Synthetic combined Understat league markdown (Standings + Rankings +
// Fixtures sections), matching the shape scrapeUnderstatPage actually
// produces closely enough to exercise the section-scoped row regexes.
const SEASON = "2025/26";

const buildUnderstatDoc = (remaining: number): string =>
  [
    "> **League:** Premier League | **Season:** 2025/26",
    "",
    "## Standings",
    "",
    "| Pos | Team | Pts |",
    "|---|---|---|",
    "| 1 | Liverpool | 90 |",
    "| 2 | Man City | 85 |",
    "",
    "## Rankings",
    "",
    "| Pos | Player | Team | Shots | KeyPasses | Goals |",
    "|---|---|---|---|---|---|",
    "| 1 | Mohamed Salah | Liverpool | 130 | 40 | 27 |",
    "",
    "## Fixtures",
    "",
    `**Remaining:** ${remaining}`,
    "",
    "| Date | Home | Away |",
    "|---|---|---|",
    "| 2026-08-01 | Liverpool | Arsenal |",
    "",
  ].join("\n");

const UNDERSTAT_URL = "https://understat.com/league/EPL";

const runCaptureUnderstatFactsCompletedTest = (): Failures => {
  const failures: Failures = [];
  const bySeason = new Map<string, UnderstatSeasonFacts>();

  captureUnderstatFacts(buildUnderstatDoc(0), UNDERSTAT_URL, bySeason);

  const bucket = bySeason.get(SEASON);
  console.log(`  captureUnderstatFacts (Remaining: 0) -> ${JSON.stringify(bucket)}`);

  if (!bucket) {
    failures.push("captureUnderstatFacts (Remaining: 0): no facts captured for season 2025/26");
    return failures;
  }
  if (bucket.champions.EPL !== "Liverpool") {
    failures.push(
      `captureUnderstatFacts (Remaining: 0): expected champions.EPL="Liverpool", got ${JSON.stringify(bucket.champions.EPL)}`,
    );
  }
  if (bucket.topScorers.EPL?.player !== "Mohamed Salah") {
    failures.push(
      `captureUnderstatFacts (Remaining: 0): expected topScorers.EPL.player="Mohamed Salah", got ${JSON.stringify(bucket.topScorers.EPL?.player)}`,
    );
  }
  if (bucket.topScorers.EPL?.goals !== 27) {
    failures.push(
      `captureUnderstatFacts (Remaining: 0): expected topScorers.EPL.goals=27, got ${JSON.stringify(bucket.topScorers.EPL?.goals)}`,
    );
  }

  return failures;
};

const runCaptureUnderstatFactsIncompleteTest = (): Failures => {
  const failures: Failures = [];
  const bySeason = new Map<string, UnderstatSeasonFacts>();

  captureUnderstatFacts(buildUnderstatDoc(5), UNDERSTAT_URL, bySeason);

  const bucket = bySeason.get(SEASON);
  console.log(`  captureUnderstatFacts (Remaining: 5) -> ${JSON.stringify(bucket)}`);

  if (bucket?.champions.EPL !== undefined) {
    failures.push(
      `captureUnderstatFacts (Remaining: 5): expected NO champion, got ${JSON.stringify(bucket?.champions.EPL)}`,
    );
  }

  return failures;
};

// --- generatePrompts ---------------------------------------------------------

const FULL_FACTS: CorpusFacts = {
  season: SEASON,
  leagues: ["EPL", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Champions League", "AFCON"],
  champions: { EPL: "Liverpool", "La Liga": "Real Madrid" },
  topScorers: {
    EPL: { player: "Mohamed Salah", goals: 27 },
    "La Liga": { player: "Kylian Mbappe", goals: 24 },
  },
};

const MINIMAL_FACTS: CorpusFacts = {
  season: SEASON,
  leagues: [],
};

const assertNoUndefinedSubstring = (prompts: string[], label: string): Failures => {
  const failures: Failures = [];
  for (const prompt of prompts) {
    if (prompt.includes("undefined")) {
      failures.push(`${label}: prompt contains "undefined" — ${JSON.stringify(prompt)}`);
    }
  }
  return failures;
};

const assertNonEmptyAndDeduped = (prompts: string[], label: string): Failures => {
  const failures: Failures = [];
  if (prompts.length === 0) {
    failures.push(`${label}: generatePrompts returned an empty array`);
  }
  const seen = new Set<string>();
  for (const prompt of prompts) {
    if (seen.has(prompt)) {
      failures.push(`${label}: duplicate prompt in output — ${JSON.stringify(prompt)}`);
    }
    seen.add(prompt);
  }
  return failures;
};

const runGeneratePromptsLeagueGatingTest = (): Failures => {
  const failures: Failures = [];

  const withCl = generatePrompts({ ...MINIMAL_FACTS, leagues: ["Champions League"] });
  const withoutCl = generatePrompts({ ...MINIMAL_FACTS, leagues: ["EPL"] });
  console.log(`  generatePrompts leagues=["Champions League"] -> ${withCl.length} prompts`);
  console.log(`  generatePrompts leagues=["EPL"] -> ${withoutCl.length} prompts`);

  if (!withCl.some((p) => p.toLowerCase().includes("champions league"))) {
    failures.push('league gating: no Champions League prompt found when "Champions League" is present');
  }
  if (withoutCl.some((p) => p.toLowerCase().includes("champions league"))) {
    failures.push('league gating: a Champions League prompt appeared when "Champions League" is NOT present');
  }

  const withAfcon = generatePrompts({ ...MINIMAL_FACTS, leagues: ["AFCON"] });
  const withoutAfcon = generatePrompts({ ...MINIMAL_FACTS, leagues: ["EPL"] });
  console.log(`  generatePrompts leagues=["AFCON"] -> ${withAfcon.length} prompts`);

  if (!withAfcon.some((p) => p.toLowerCase().includes("afcon"))) {
    failures.push('league gating: no AFCON prompt found when "AFCON" is present');
  }
  if (withoutAfcon.some((p) => p.toLowerCase().includes("afcon"))) {
    failures.push('league gating: an AFCON prompt appeared when "AFCON" is NOT present');
  }

  return failures;
};

const runGeneratePromptsShapeTest = (): Failures => {
  const failures: Failures = [];

  const fullPrompts = generatePrompts(FULL_FACTS);
  const minimalPrompts = generatePrompts(MINIMAL_FACTS);

  console.log(`  generatePrompts(full facts) -> ${fullPrompts.length} prompts`);
  console.log(`  generatePrompts(minimal facts) -> ${minimalPrompts.length} prompts`);

  failures.push(...assertNoUndefinedSubstring(fullPrompts, "full-facts"));
  failures.push(...assertNoUndefinedSubstring(minimalPrompts, "minimal-facts"));
  failures.push(...assertNonEmptyAndDeduped(fullPrompts, "full-facts"));
  failures.push(...assertNonEmptyAndDeduped(minimalPrompts, "minimal-facts"));

  return failures;
};

const main = async () => {
  const allFailures: Failures = [];

  console.log("=== normalizeLeagueName ===");
  allFailures.push(...runNormalizeLeagueNameTest().map((f) => `[normalizeLeagueName] ${f}`));

  console.log("\n=== captureUnderstatFacts (Remaining: 0 — completed season) ===");
  allFailures.push(
    ...runCaptureUnderstatFactsCompletedTest().map((f) => `[captureUnderstatFacts-completed] ${f}`),
  );

  console.log("\n=== captureUnderstatFacts (Remaining: 5 — season in progress) ===");
  allFailures.push(
    ...runCaptureUnderstatFactsIncompleteTest().map((f) => `[captureUnderstatFacts-incomplete] ${f}`),
  );

  console.log("\n=== generatePrompts: league gating (Champions League / AFCON) ===");
  allFailures.push(
    ...runGeneratePromptsLeagueGatingTest().map((f) => `[generatePrompts-gating] ${f}`),
  );

  console.log("\n=== generatePrompts: shape (no \"undefined\", non-empty, deduped) ===");
  allFailures.push(...runGeneratePromptsShapeTest().map((f) => `[generatePrompts-shape] ${f}`));

  console.log(`\n=== Assertions ===`);
  if (allFailures.length > 0) {
    console.error(`FAILED (${allFailures.length} issue(s)):`);
    for (const f of allFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("All assertions passed.");
  process.exit(0);
};

main().catch((err: unknown) => {
  console.error("validatePrompts crashed:", err);
  process.exit(1);
});
