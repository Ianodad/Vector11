// app/lib/retrieval.ts
// Retrieval pipeline extracted from app/api/chat/route.ts (pure move, no behaviour change).
// Importable from tsx scripts: relative imports only, no Next-only APIs.
import OpenAI from "openai";
import { Collection, DataAPIClient, SomeDoc } from "@datastax/astra-db-ts";
import { RETRIEVAL_PLANS } from "./retrievalPlans";
import { isDbResumingError, withDbResumeRetry } from "./astraResume";
import type { ChatSource } from "../types/chat";

const requiredEnv = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const ASTRA_DB_NAMESPACE = requiredEnv(
  process.env.ASTRA_DB_NAMESPACE,
  "ASTRA_DB_NAMESPACE",
);
const ASTRA_DB_COLLECTION = requiredEnv(
  process.env.ASTRA_DB_COLLECTION,
  "ASTRA_DB_COLLECTION",
);
const ASTRA_DB_API_ENDPOINT = requiredEnv(
  process.env.ASTRA_DB_API_ENDPOINT,
  "ASTRA_DB_API_ENDPOINT",
);
const ASTRA_DB_APPLICATION_TOKEN = requiredEnv(
  process.env.ASTRA_DB_APPLICATION_TOKEN,
  "ASTRA_DB_APPLICATION_TOKEN",
);
const OPEN_API_KEY = requiredEnv(process.env.OPEN_API_KEY, "OPEN_API_KEY");
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 1536;

const openai = new OpenAI({
  apiKey: OPEN_API_KEY,
});

const VALID_CATEGORIES = new Set([
  "news",
  "stats",
  "fixtures",
  "analysis",
  "teams",
  "reference",
  "soccerwayForm",
  "rss",
]);

const CATEGORY_FALLBACKS: Record<string, string[]> = {
  analysis: ["stats", "reference"],
  teams: ["stats", "analysis"],
  fixtures: ["stats", "soccerwayForm"],
  news: ["rss", "analysis"],
  stats: ["reference", "analysis"],
  reference: ["stats"],
  soccerwayForm: ["fixtures", "stats"],
  rss: ["news"],
};

const normalizeCategory = (c: string | null): string | null =>
  c === "playerPerformance" ? "stats" : c;

const TEAM_ALIASES = [
  "arsenal",
  "aston villa",
  "atlético madrid",
  "atletico madrid",
  "barcelona",
  "bayer leverkusen",
  "bayern munich",
  "borussia dortmund",
  "brighton",
  "chelsea",
  "inter milan",
  "juventus",
  "liverpool",
  "manchester city",
  "man city",
  "manchester united",
  "man united",
  "newcastle",
  "psg",
  "paris saint-germain",
  "real madrid",
  "roma",
  "tottenham",
];

const LEAGUE_HINTS: Array<{ name: string; aliases: string[]; tag: string }> = [
  { name: "Premier League", aliases: ["premier league", "epl"], tag: "premier-league" },
  { name: "La Liga", aliases: ["la liga", "laliga", "primera division"], tag: "la-liga" },
  { name: "Serie A", aliases: ["serie a"], tag: "serie-a" },
  { name: "Bundesliga", aliases: ["bundesliga"], tag: "bundesliga" },
  { name: "Ligue 1", aliases: ["ligue 1"], tag: "ligue-1" },
  { name: "Champions League", aliases: ["champions league", "ucl"], tag: "uefa-champions-league" },
];

const normalizeSlug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

const tokenizeQuery = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);

const lexicalOverlapScore = (queryTokens: string[], docText: string): number => {
  if (queryTokens.length === 0 || !docText) return 0;
  const normalized = docText.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (normalized.includes(token)) hits += 1;
  }
  return hits / queryTokens.length;
};

const isLikelyTickerNoise = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
  const signals = [
    "all live full-time scheduled today",
    "europa league - play offs",
    "conference league - play offs",
  ];
  const hits = signals.reduce(
    (count, signal) => (normalized.includes(signal) ? count + 1 : count),
    0,
  );
  return hits >= 2;
};

const inferRetrievalCategories = (
  text: string,
  plannedCategory: string | null,
): string[] => {
  const normalized = text.toLowerCase();
  const categories: string[] = [];

  const pushCategory = (category: string) => {
    if (VALID_CATEGORIES.has(category) && !categories.includes(category)) {
      categories.push(category);
    }
  };

  if (plannedCategory && VALID_CATEGORIES.has(plannedCategory)) {
    pushCategory(plannedCategory);
    for (const fallback of CATEGORY_FALLBACKS[plannedCategory] ?? []) {
      pushCategory(fallback);
    }
  }

  if (
    /standing|table|rank|position|points|xg|xga|xpts|compare|comparison|versus|\bvs\b|form/i.test(
      normalized,
    )
  ) {
    pushCategory("stats");
  }
  if (/fixture|fixtures|result|results|schedule|upcoming|kick-?off/i.test(normalized)) {
    pushCategory("fixtures");
  }
  if (/scorer|assists?|player|goals?|xg90|xa90/i.test(normalized)) {
    pushCategory("stats");
  }
  if (/news|story|stories|latest/i.test(normalized)) {
    pushCategory("news");
  }
  if (/analysis|run-?in|difficulty|form/i.test(normalized)) {
    pushCategory("analysis");
  }

  return categories.slice(0, 3);
};

interface RetrievalHints {
  leagues: string[];
  leagueTags: string[];
  teams: string[];
  teamTags: string[];
  seasonVariants: string[];
}

const buildRetrievalHints = (text: string, latestSeason: string): RetrievalHints => {
  const normalized = text.toLowerCase();
  const leagues = LEAGUE_HINTS.filter((league) =>
    league.aliases.some((alias) => normalized.includes(alias)),
  );
  const teams = TEAM_ALIASES.filter((team) => normalized.includes(team));
  const [startYear, endYearShort] = latestSeason.split("-");
  const fullEndYear = startYear
    ? String(Number(startYear) + 1)
    : "";

  return {
    leagues: leagues.map((league) => league.name.toLowerCase()),
    leagueTags: leagues.map((league) => league.tag),
    teams,
    teamTags: teams.map((team) => normalizeSlug(team)),
    seasonVariants: [
      latestSeason.toLowerCase(),
      `${startYear}/${endYearShort}`.toLowerCase(),
      `${startYear}/${fullEndYear}`.toLowerCase(),
      String(startYear),
    ].filter(Boolean),
  };
};

const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN, {
  timeoutDefaults: {
    requestTimeoutMs: 20000,
    generalMethodTimeoutMs: 60000,
  },
});
const db = client.db(ASTRA_DB_API_ENDPOINT, {
  keyspace: ASTRA_DB_NAMESPACE,
});

interface HybridHit {
  parentId: string;
  doc: Record<string, unknown>;
  rerank: number;
  similarity: number;
}

const hybridSearch = async (
  collection: Collection<SomeDoc>,
  filter: Record<string, unknown>,
  vec: number[],
  lexicalQuery: string,
  rerankQuery: string,
  counter: { searchCalls: number },
): Promise<HybridHit[]> => {
  counter.searchCalls += 1;
  const rows = await collection
    .findAndRerank(filter, {
      sort: { $hybrid: { $vector: vec, $lexical: lexicalQuery } },
      limit: 12,
      hybridLimits: 80,
      rerankOn: "content",
      rerankQuery,
      includeScores: true,
      projection: {
        parentId: 1, content: 1, source: 1, url: 1, category: 1, scrapedAt: 1,
      },
    })
    .toArray();

  return rows
    .map((r) => ({
      parentId: String(r.document?.parentId ?? ""),
      doc: r.document ?? {},
      rerank: Number(r.scores?.$rerank ?? 0),
      similarity: Number(r.scores?.$vector ?? 0),
    }))
    .filter((h) => h.parentId);
};

// Top retrieved pages in rank order: de-duplicated by URL, http(s) only, max 5.
const buildSources = (
  ranked: Array<[string, { doc: Record<string, unknown> }]>,
): ChatSource[] => {
  const seen = new Set<string>();
  const sources: ChatSource[] = [];
  for (const [, { doc }] of ranked) {
    const url = typeof doc.url === "string" ? doc.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    const scrapedAt = toIso(doc.scrapedAt);
    sources.push({
      url,
      source: typeof doc.source === "string" && doc.source ? doc.source : host,
      ...(scrapedAt ? { scrapedAt } : {}),
    });
    if (sources.length >= 5) break;
  }
  return sources;
};

/** Thrown when the database is waking from hibernation; the route maps it to 503 + Retry-After. */
export class DbResumingError extends Error {
  constructor(public readonly cause: unknown) {
    super("The stats database is waking up from sleep.");
    this.name = "DbResumingError";
  }
}

export interface RetrievedParent {
  source: string;
  url: string;
  content: string;
  scrapedAt?: string;
  rerank?: number;
  rank?: number;
  lexical?: number;
  similarity: number;
}

export interface RetrievalResult {
  parents: RetrievedParent[];
  sources: ChatSource[];
  plan: { queries: string[]; category: string | null; precomputed: boolean };
  stats: { searchCalls: number; ms: number };
}

export interface RetrieveInput {
  chatMessages: Array<{ role: string; content: string }>;
  lastMessage: string;
  season: { latestSeason: string };
}

// Total: invalid or missing dates become undefined, never throw.
const toIso = (value: unknown): string | undefined => {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

export async function retrieveContext({
  chatMessages,
  lastMessage,
  season,
}: RetrieveInput): Promise<RetrievalResult> {
  const startedAt = Date.now();
  const counter = { searchCalls: 0 };
  let retrievedParents: RetrievedParent[] = [];
  let sources: ChatSource[] = [];

  // Plan retrieval: generate 3 query variants + detect category in one LLM call
  const conversationContext = chatMessages
    .slice(-4)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  interface RetrievalPlan {
    queries: string[];
    category: string | null;
  }

  const precomputed = RETRIEVAL_PLANS.get(lastMessage);
  let plan: RetrievalPlan = { queries: [lastMessage], category: null };

  if (precomputed) {
    // Skip LLM planning call — use pre-computed queries and category
    plan = { queries: precomputed.queries, category: precomputed.category };
    plan.category = normalizeCategory(plan.category);
    console.log("[chat] using precomputed plan", {
      queries: plan.queries.map((q) => q.slice(0, 60)),
      category: plan.category,
    });
  } else {
    try {
      const planResult = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [
          {
            role: "system",
              content: `You are a search query planner for a football stats assistant. Given the conversation, output a JSON object with exactly two keys:

- "queries": array of exactly 3 diverse standalone search queries tailored to the question type:

  For STANDINGS / LEAGUE TABLES (stats questions):
  1. Natural language: e.g. "Premier League 2025-26 standings top teams points"
  2. Format-matching: "№ Team M W D L G GA PTS xG xGA xPTS [top expected teams for that league]"
  3. Entity-focused: list the top teams expected in that competition

  For FIXTURES / UPCOMING MATCHES / FIXTURE DIFFICULTY / RUN-IN:
  1. Natural language: e.g. "Premier League upcoming fixtures schedule 2025-26 tough run-in"
  2. Format-matching: "Date Home Away fixture [team names] upcoming matches opponent schedule"
  3. Entity-focused: list the teams and their likely upcoming opponents

  For PLAYER STATS / SCORERS / ASSISTS / xG:
  1. Natural language: e.g. "Premier League top scorers goals 2025-26"
  2. Format-matching: "Player Team Apps Goals Assists xG xA [expected player names]"
  3. Entity-focused: list the expected player names and their teams

  For ANALYSIS / DIFFICULTY / FORM / PREVIEWS:
  1. Natural language: e.g. "Premier League fixture difficulty run-in tough games analysis"
  2. Format-matching: use terms like "tough fixture run home away big six [team names]"
  3. Entity-focused: list the teams and competitions involved

  Stats data stored format reference (use only when relevant to the question type):
  - League tables: "№ Team M W D L G GA PTS xG xGA xPTS\n1 [Team] [nums]..."
  - Player stats: "Player Team Apps Goals Assists xG xA"
  - Fixtures: "Date Home Away Score" or team name + opponent + date

  Always include the specific competition name from the user's question and season ${season.latestSeason} if unspecified.

- "category": one of "news"|"stats"|"fixtures"|"analysis"|"teams"|"reference" — or null if unclear.
  Use "stats" for standings, tables, league positions, xG, xPTS.
  Use "stats" for individual player stats, top scorers, assists, xG (player tables live under "stats").
  Use "fixtures" for match schedules, results, upcoming games.
  Use "analysis" for fixture difficulty, run-in comparisons, form guides, match previews.

Output ONLY valid JSON, no markdown fences.`,
          },
          { role: "user", content: conversationContext },
        ],
        response_format: { type: "json_object" },
      });
      const raw = planResult.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as Partial<RetrievalPlan>;
      const queries = Array.isArray(parsed.queries)
        ? parsed.queries.filter((q): q is string => typeof q === "string").slice(0, 3)
        : [];
      plan = {
        queries: queries.length > 0 ? queries : [lastMessage],
        category: typeof parsed.category === "string" ? parsed.category : null,
      };
      plan.category = normalizeCategory(plan.category);
    } catch {
      // fall back to single query if planning fails
    }
    console.log("[chat] retrieval plan", {
      queries: plan.queries.map((q) => q.slice(0, 60)),
      category: plan.category,
    });
  }
  const queryBundle = [lastMessage, ...plan.queries].join(" ");
  const queryTokens = tokenizeQuery(queryBundle);
  const retrievalHints = buildRetrievalHints(queryBundle, season.latestSeason);
  const retrievalCategories = inferRetrievalCategories(queryBundle, plan.category);
  const fixtureLikeRequest = /fixture|fixtures|result|results|schedule|upcoming|kick-?off/i.test(
    queryBundle,
  );
  const comparisonLikeRequest = /compare|comparison|versus|\bvs\b/.test(queryBundle.toLowerCase());

  // Embed all queries in parallel
  const embeddingResponses = await Promise.all(
    plan.queries.map((q) =>
      openai.embeddings.create({
        model: "text-embedding-3-large",
        input: q,
        encoding_format: "float",
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    ),
  );
  const embeddings = embeddingResponses.map((r) => r.data[0].embedding);
  console.log("[chat] embeddings", {
    count: embeddings.length,
    dimensions: embeddings[0]?.length,
  });

  // Vector search — multi-query parent-child retrieval
  try {
    const collection = db.collection(ASTRA_DB_COLLECTION);
    console.log("[chat] vector search (multi-query parent-child)", {
      keyspace: ASTRA_DB_NAMESPACE,
      collection: ASTRA_DB_COLLECTION,
      category: plan.category,
    });

    type ScoredDoc = {
      doc: Record<string, unknown>;
      similarity: number;
      rerank?: number;
      rank?: number;
      lexical?: number;
    };

    let bestByParent: Map<string, ScoredDoc>;
    let rankedParents: Array<[string, ScoredDoc]>;
    let parentIds: string[];

    try {
      // Hybrid search (native $hybrid sort + rerank) — primary path
      const hybridFilters: Array<Record<string, unknown>> = retrievalCategories
        .slice(0, 2)
        .map((category) => ({ type: "child", category }));
      hybridFilters.push({ type: "child" });

      const hybridResults = await withDbResumeRetry(() =>
        Promise.all(
          hybridFilters.flatMap((filter) =>
            embeddings.map((vec, i) =>
              hybridSearch(collection, filter, vec, plan.queries[i], lastMessage, counter),
            ),
          ),
        ),
      );

      bestByParent = new Map();
      for (const hits of hybridResults) {
        for (const hit of hits) {
          const content = String(hit.doc.content ?? "");
          if (fixtureLikeRequest && isLikelyTickerNoise(content)) continue;
          const existing = bestByParent.get(hit.parentId);
          if (!existing || hit.rerank > (existing.rerank ?? -Infinity)) {
            bestByParent.set(hit.parentId, {
              doc: hit.doc,
              rerank: hit.rerank,
              similarity: hit.similarity,
            });
          }
        }
      }

      rankedParents = Array.from(bestByParent.entries()).sort(
        (a, b) => (b[1].rerank ?? -Infinity) - (a[1].rerank ?? -Infinity),
      );
      parentIds = rankedParents.slice(0, 12).map(([parentId]) => parentId);

      console.log("[chat] hybrid results", {
        uniqueParents: bestByParent.size,
        topRerank: rankedParents[0]?.[1].rerank ?? null,
      });
    } catch (hybridErr) {
      if (isDbResumingError(hybridErr)) throw hybridErr;
      console.log("[chat] hybrid search failed, falling back to vector search", hybridErr);

      const searchFilters: Array<Record<string, unknown>> = [];
      if (retrievalCategories.length > 0) {
        for (const category of retrievalCategories) {
          searchFilters.push({ type: "child", category });
        }
      } else if (plan.category && VALID_CATEGORIES.has(plan.category)) {
        searchFilters.push({ type: "child", category: plan.category });
      }
      searchFilters.push({ type: "child" });

      // Step 1: Run all searches in parallel (retry once if the DB is resuming)
      const searchResults = await withDbResumeRetry(() =>
        Promise.all(
          searchFilters.flatMap((filter) =>
            embeddings.map((vec) => {
              counter.searchCalls += 1;
              return collection
                .find(filter, {
                  sort: { $vector: vec },
                  limit: 20,
                  includeSimilarity: true,
                  projection: {
                    parentId: 1,
                    content: 1,
                    source: 1,
                    url: 1,
                    category: 1,
                    scrapedAt: 1,
                  },
                })
                .toArray();
            }),
          ),
        ),
      );

      // Merge results — keep highest-similarity child per parentId
      bestByParent = new Map();
      for (const docs of searchResults) {
        for (const doc of docs) {
          const pid = doc.parentId as string | undefined;
          if (!pid) continue;
          const content = (doc.content as string | undefined) ?? "";
          if (fixtureLikeRequest && isLikelyTickerNoise(content)) continue;

          const similarity = (doc.$similarity as number) ?? 0;
          const searchText = `${String(doc.source || "")} ${String(doc.url || "")} ${content}`.toLowerCase();
          const lexical = lexicalOverlapScore(
            queryTokens,
            searchText,
          );
          const leagueBoost = retrievalHints.leagues.some((league) => searchText.includes(league))
            || retrievalHints.leagueTags.some((tag) => searchText.includes(`#league/${tag}`))
            ? 0.06
            : 0;
          const teamHits = retrievalHints.teams.reduce(
            (count, team) => (searchText.includes(team) ? count + 1 : count),
            0,
          ) + retrievalHints.teamTags.reduce(
            (count, tag) => (searchText.includes(`#team/${tag}`) ? count + 1 : count),
            0,
          );
          const teamBoost = Math.min(teamHits * 0.03, 0.12);
          const seasonBoost = retrievalHints.seasonVariants.some((variant) => searchText.includes(variant))
            ? 0.04
            : 0;
          const statsBoost =
            comparisonLikeRequest
            && /standings|league table|xg|xga|xpts|\|\s*pos\s*\|\s*team/i.test(searchText)
              ? 0.05
              : 0;
          const rank =
            similarity + lexical * 0.08 + leagueBoost + teamBoost + seasonBoost + statsBoost;
          const existing = bestByParent.get(pid);
          if (!existing || rank > (existing.rank ?? -Infinity)) {
            bestByParent.set(pid, { doc, rank, similarity, lexical });
          }
        }
      }

      rankedParents = Array.from(bestByParent.entries()).sort(
        (a, b) => (b[1].rank ?? -Infinity) - (a[1].rank ?? -Infinity),
      );
      parentIds = rankedParents.slice(0, 12).map(([parentId]) => parentId);

      console.log("[chat] merged child results", {
        uniqueParents: parentIds.length,
        totalRawHits: searchResults.reduce((s, r) => s + r.length, 0),
      });
    }

    // Step 2: Fetch parent chunks for rich LLM context
    let parents: Array<Record<string, unknown>> = [];
    if (parentIds.length > 0) {
      parents = await withDbResumeRetry(() =>
        collection
          .find(
            { _id: { $in: parentIds } },
            { projection: { content: 1, source: 1, url: 1 } },
          )
          .toArray(),
      );
    }
    console.log("[chat] parent fetch results", { parentsFetched: parents.length });

    // Step 3: Use parent content as LLM context (richer than child content)
    // Output rows carry exactly what route.ts serialises into the prompt (same fields/order).
    if (parents.length > 0) {
      const rankByParentId = new Map(rankedParents);
      const parentOrder = new Map(parentIds.map((id, idx) => [id, idx]));
      retrievedParents = parents
        .sort((a, b) => {
          const left = parentOrder.get(String(a._id)) ?? Number.MAX_SAFE_INTEGER;
          const right = parentOrder.get(String(b._id)) ?? Number.MAX_SAFE_INTEGER;
          return left - right;
        })
        .map((doc) => {
          const score = rankByParentId.get(String(doc._id));
          return {
            source: doc.source as string,
            url: doc.url as string,
            ...(score?.rerank !== undefined
              ? { rerank: score.rerank }
              : { rank: score?.rank ?? 0, lexical: score?.lexical ?? 0 }),
            similarity: score?.similarity ?? 0,
            content: doc.content as string,
            scrapedAt: toIso(score?.doc.scrapedAt),
          };
        });
    } else if (bestByParent.size > 0) {
      console.log("[chat] fallback: using child content (no parents found)");
      retrievedParents = rankedParents.slice(0, 12).map(([, score]) => ({
        source: score.doc.source as string,
        url: score.doc.url as string,
        ...(score.rerank !== undefined
          ? { rerank: score.rerank }
          : { rank: score.rank ?? 0, lexical: score.lexical ?? 0 }),
        similarity: score.similarity,
        content: score.doc.content as string,
        scrapedAt: toIso(score.doc.scrapedAt),
      }));
    }

    // Sources come from the same top-12 slice sent to the model (parents path and child fallback alike)
    if (retrievedParents.length > 0) sources = buildSources(rankedParents.slice(0, 12));

    if (bestByParent.size === 0) {
      try {
        const total = await withDbResumeRetry(() =>
          collection.countDocuments({}, 2000),
        );
        const fallbackDocs = await withDbResumeRetry(() =>
          collection.find({}, { limit: 1 }).toArray(),
        );
        console.log("[chat] collection check", {
          count: total,
          sampleKeys: fallbackDocs[0] ? Object.keys(fallbackDocs[0]) : [],
          hasTypeField: Boolean(fallbackDocs[0]?.type),
        });
      } catch (diagnosticErr) {
        console.log("[chat] collection check failed (diagnostic only)", diagnosticErr);
      }
    }
  } catch (error) {
    console.log("Error querying vector search:", error);
    if (isDbResumingError(error)) throw new DbResumingError(error);
    retrievedParents = [];
    sources = [];
  }

  return {
    parents: retrievedParents,
    sources,
    plan: {
      queries: plan.queries,
      category: plan.category,
      precomputed: Boolean(precomputed),
    },
    stats: { searchCalls: counter.searchCalls, ms: Date.now() - startedAt },
  };
}
