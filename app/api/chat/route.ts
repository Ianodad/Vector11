// app/api/chat/route.ts
import OpenAI from "openai";
import { Collection, DataAPIClient, SomeDoc } from "@datastax/astra-db-ts";
import { RETRIEVAL_PLANS } from "../../lib/retrievalPlans";

export const maxDuration = 60;

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
const RATE_LIMIT_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_REQUESTS_PER_WINDOW =
  Number(process.env.MAX_REQUESTS_PER_WINDOW) || 12;
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS) || 600;
const MAX_MESSAGES_PER_REQUEST = Number(process.env.MAX_MESSAGES_PER_REQUEST) || 20;

const openai = new OpenAI({
  apiKey: OPEN_API_KEY,
});

const getSeasonContext = (date: Date = new Date()) => {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  // Europe's top leagues kick off in the first half of August and finish in May.
  // A new season only becomes "the latest season" once it has actually kicked off.
  const newSeasonHasKickedOff = month > 8 || (month === 8 && day >= 8);
  const startYear = newSeasonHasKickedOff ? year : year - 1;
  const fmt = (start: number) =>
    `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  const latestSeason = fmt(startYear);
  const nextSeason = fmt(startYear + 1);
  // June, July and the first week of August sit between two seasons.
  const inOffSeason = month === 6 || month === 7 || (month === 8 && day < 8);
  return { latestSeason, nextSeason, inOffSeason };
};

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

// The NVIDIA reranker is a separate service from the database. Its failures must fall back
// to plain vector search, not be reported to the user as a hibernating database.
const isRerankerError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /rerank/i.test(msg);
};

// Serverless Astra hibernates when idle; the first request after a pause fails
// with a 503 "Resuming your database". Retry only that transient class so a cold
// DB no longer returns a confident but empty answer to the first user of the day.
const isDbResumingError = (err: unknown): boolean => {
  if (isRerankerError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /resum|hibernat|503|not (yet )?ready|starting|initializ|unavailable_database|not enough (nodes|replicas)|refused to start processing|quorum|safe to retry/i
    .test(msg);
};

const withDbResumeRetry = async <T>(
  op: () => Promise<T>,
  attempts = 8,
  baseDelayMs = 1500,
): Promise<T> => {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isDbResumingError(err)) throw err;
      const delayMs = Math.min(baseDelayMs * i, 8000);
      console.log(`[chat] DB resuming — retry ${i}/${attempts} in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
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

const requestBuckets = new Map<string, number[]>();

const getClientIp = (request: Request): string => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
};

const getRateLimitStatus = (key: string): { allowed: boolean; retryAfterMs: number } => {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (requestBuckets.get(key) ?? []).filter((ts) => ts > cutoff);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = recent[0] ?? now;
    const retryAfterMs = Math.max(1000, RATE_LIMIT_WINDOW_MS - (now - oldest));
    requestBuckets.set(key, recent);
    return { allowed: false, retryAfterMs };
  }

  recent.push(now);
  requestBuckets.set(key, recent);
  return { allowed: true, retryAfterMs: 0 };
};

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
): Promise<HybridHit[]> => {
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

export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    const rateLimit = getRateLimitStatus(clientIp);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.ceil(rateLimit.retryAfterMs / 1000);
      return Response.json(
        {
          error: `Too many requests. Try again in about ${retryAfterSeconds}s.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const season = getSeasonContext();
    console.log("[chat] request received");
    const { messages } = await request.json();
    const chatMessages = Array.isArray(messages)
      ? messages
          .filter(
            (message) =>
              message &&
              (message.role === "user" || message.role === "assistant") &&
              typeof message.content === "string",
          )
          .map((message) => ({
            role: message.role,
            content: message.content.trim().slice(0, MAX_INPUT_CHARS),
          }))
          .filter((message) => message.content.length > 0)
          .slice(-MAX_MESSAGES_PER_REQUEST)
      : [];
    const lastMessage = chatMessages[chatMessages.length - 1]?.content;

    if (!lastMessage) {
      return Response.json(
        { error: "No user message provided." },
        { status: 400 },
      );
    }
    console.log("[chat] messages", {
      total: chatMessages.length,
      lastChars: lastMessage.slice(0, 80),
    });

    let docContent = "";

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
                hybridSearch(collection, filter, vec, plan.queries[i], lastMessage),
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
              embeddings.map((vec) =>
                collection
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
                  .toArray(),
              ),
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
      if (parents.length > 0) {
        const rankByParentId = new Map(rankedParents);
        const parentOrder = new Map(parentIds.map((id, idx) => [id, idx]));
        docContent = JSON.stringify(
          parents
            .sort((a, b) => {
              const left = parentOrder.get(String(a._id)) ?? Number.MAX_SAFE_INTEGER;
              const right = parentOrder.get(String(b._id)) ?? Number.MAX_SAFE_INTEGER;
              return left - right;
            })
            .map((doc) => {
              const score = rankByParentId.get(String(doc._id));
              return {
                source: doc.source,
                url: doc.url,
                ...(score?.rerank !== undefined
                  ? { rerank: score.rerank }
                  : { rank: score?.rank ?? 0, lexical: score?.lexical ?? 0 }),
                similarity: score?.similarity ?? 0,
                content: doc.content,
              };
            }),
        );
      } else if (bestByParent.size > 0) {
        console.log("[chat] fallback: using child content (no parents found)");
        docContent = JSON.stringify(
          rankedParents.slice(0, 12).map(([, score]) => ({
            source: score.doc.source,
            url: score.doc.url,
            ...(score.rerank !== undefined
              ? { rerank: score.rerank }
              : { rank: score.rank ?? 0, lexical: score.lexical ?? 0 }),
            similarity: score.similarity,
            content: score.doc.content,
          })),
        );
      }

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
      if (isDbResumingError(error)) {
        return Response.json(
          {
            error:
              "The stats database is waking up from sleep. Give it about 30 seconds and ask again.",
          },
          { status: 503, headers: { "Retry-After": "30" } },
        );
      }
      docContent = "";
    }

    // template to pass to openai
    const template = {
      role: "system",
      content: `You are Vector11, a football stats assistant.

Date context:
- Today (UTC): ${todayIso}
- Latest season with data: ${season.latestSeason}${season.inOffSeason ? " — this season is COMPLETE (it has finished)" : " — currently in progress"}${season.inOffSeason ? `
- The ${season.nextSeason} season has NOT kicked off yet.` : ""}

Season rules (IMPORTANT):
- "current", "latest", "now" and "this season" all mean ${season.latestSeason}.
- Report ${season.latestSeason} figures and label them clearly (e.g. "${season.latestSeason} final table").${season.inOffSeason ? `
- ${season.latestSeason} is FINISHED, not upcoming. Never describe it as "not started" or "not yet kicked off".
- You have NO ${season.nextSeason} data. Mention ${season.nextSeason} only to note it has not begun, and only if it is relevant.` : ""}
- Prefer the newest season present in the retrieved context. Do not fall back to an older
  season when a newer one is available in the context.
- NEVER refuse to answer solely because an even newer season has no data yet.
- Only say data is unavailable if the retrieved context contains NOTHING relevant to the question.

Rules:
- Always use retrieved context from the vector database as the primary source of truth.
- If the context is partial, combine it with general football knowledge and clearly label what is from context vs general knowledge.
- If no relevant context is available, state that clearly, then answer from general knowledge.
- If user provides a historical table (for example last season), treat it as historical and do not present it as current.

Table output format:
- If the user asks for standings, top teams, rankings, or league tables, output one markdown table first.
- Use this exact column order whenever applicable:
|Pos|Team|P|W|D|L|GF|GA|Pts|
|---:|---|---:|---:|---:|---:|---:|---:|---:|
- After the table, add exactly one short section:
  **Context**
  - 2 to 3 bullets explaining what the table means.
- Do not add extra sections like "Verdict", per-team breakdowns, or repeated tables unless explicitly requested.

Fixture output format:
- When listing fixtures, use a markdown table with these columns:
|Date|Home|vs|Away|Kick-off|
|---|---|---|---|---|
- Always include kick-off time when available.
- Do not add extra commentary unless explicitly requested.

Player stats output format:
- When listing player stats, comparisons, xG, top scorers, assists, or any per-player data, use a markdown table.
- For xG over/underperformance use:
|#|Player|Team|Goals|xG|Diff|
|---:|---|---|---:|---:|---:|
- For top scorers / assists use:
|#|Player|Team|Goals|Assists|
|---:|---|---|---:|---:|
- Sort by the most relevant column (e.g. Diff for over/underperformers, Goals for top scorers).
- Use +/- prefix on the Diff column (e.g. +3.2, -1.5).
- Do not add extra commentary unless explicitly requested.

Fixture difficulty / run-in format:
- When comparing fixture difficulty across teams, start with a summary table:
|#|Team|Big Games Left|Difficulty|
|---:|---|---:|---|
- Use "Tough", "Moderate", or "Favourable" in the Difficulty column.
- After the summary table, add:
  **Context**
  - 2 to 3 bullets only.
- Return per-team fixture breakdown only if explicitly requested.

General formatting:
- Prefer markdown tables over bullet-point lists when presenting structured data.
- When data involves comparisons, rankings, or multiple columns of info, use a table.
- Bold key team or player names on first mention.

Here is the retrieved context:
${docContent}`,
    };

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [template, ...chatMessages],
    });

    const assistantMessage = response.choices[0]?.message?.content ?? "";
    return Response.json({ message: assistantMessage });
  } catch (error) {
    console.log("[chat] request failed:", error);
    return Response.json(
      { error: "Failed to generate response." },
      { status: 500 },
    );
  }
}
