// app/api/chat/route.ts
import OpenAI from "openai";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { RETRIEVAL_PLANS } from "../../lib/retrievalPlans";

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

const getCurrentEuropeanSeason = (date: Date = new Date()): string => {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  const startYear = month >= 7 ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYearShort}`;
};

const VALID_CATEGORIES = new Set([
  "news",
  "stats",
  "playerPerformance",
  "fixtures",
  "analysis",
  "teams",
]);

const CATEGORY_FALLBACKS: Record<string, string[]> = {
  analysis: ["stats"],
  teams: ["stats", "analysis"],
  fixtures: ["stats"],
  playerPerformance: ["stats"],
  news: ["analysis"],
  stats: ["analysis"],
};

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
    pushCategory("playerPerformance");
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

interface RerankCandidate {
  parentId: string;
  source: string;
  url: string;
  category: string;
  similarity: number;
  lexical: number;
  rank: number;
  preview: string;
}

const buildRetrievalHints = (text: string, currentSeason: string): RetrievalHints => {
  const normalized = text.toLowerCase();
  const leagues = LEAGUE_HINTS.filter((league) =>
    league.aliases.some((alias) => normalized.includes(alias)),
  );
  const teams = TEAM_ALIASES.filter((team) => normalized.includes(team));
  const [startYear, endYearShort] = currentSeason.split("-");
  const fullEndYear = startYear
    ? String(Number(startYear) + 1)
    : "";

  return {
    leagues: leagues.map((league) => league.name.toLowerCase()),
    leagueTags: leagues.map((league) => league.tag),
    teams,
    teamTags: teams.map((team) => normalizeSlug(team)),
    seasonVariants: [
      currentSeason.toLowerCase(),
      `${startYear}/${endYearShort}`.toLowerCase(),
      `${startYear}/${fullEndYear}`.toLowerCase(),
      String(startYear),
    ].filter(Boolean),
  };
};

const rerankEvidenceWithLLM = async (
  openaiClient: OpenAI,
  userQuery: string,
  candidates: RerankCandidate[],
): Promise<string[] | null> => {
  if (candidates.length === 0) return null;
  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-5-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a retrieval reranker for a football RAG system.
Given a user query and candidate evidence chunks, return JSON only:
{"parentIds":["id1","id2",...]}

Rules:
- Return at most 6 parentIds.
- Prioritize candidates that directly answer the query entities (league/team/season).
- Prefer standings/xG/xPts table evidence for comparison/stat questions.
- Exclude generic or weakly related candidates.
- Only return IDs that exist in the provided candidates.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            query: userQuery,
            candidates,
          }),
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { parentIds?: unknown };
    if (!Array.isArray(parsed.parentIds)) return null;

    const validParentIds = new Set(candidates.map((c) => c.parentId));
    const selected = parsed.parentIds
      .filter((id): id is string => typeof id === "string" && validParentIds.has(id))
      .slice(0, 6);

    return selected.length > 0 ? selected : null;
  } catch {
    return null;
  }
};

// Serverless Astra hibernates when idle; the first request after a pause fails
// with a 503 "Resuming your database". Retry only that transient class so a cold
// DB no longer returns a confident but empty answer to the first user of the day.
const isDbResumingError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /resum|503|not (yet )?ready|starting|initializ/i.test(msg);
};

const withDbResumeRetry = async <T>(
  op: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 1500,
): Promise<T> => {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isDbResumingError(err)) throw err;
      const delayMs = baseDelayMs * i;
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
    const currentEuropeanSeason = getCurrentEuropeanSeason();
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

  Always include the specific competition name from the user's question and season ${currentEuropeanSeason} if unspecified.

- "category": one of "news"|"stats"|"playerPerformance"|"fixtures"|"analysis"|"teams" — or null if unclear.
  Use "stats" for standings, tables, league positions, xG, xPTS.
  Use "playerPerformance" for individual player stats, top scorers, assists.
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
    const retrievalHints = buildRetrievalHints(queryBundle, currentEuropeanSeason);
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
      const bestByParent = new Map<
        string,
        { doc: Record<string, unknown>; rank: number; similarity: number; lexical: number }
      >();
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
          const seasonBoost = retrievalHints.seasonVariants.some((season) => searchText.includes(season))
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
          if (!existing || rank > existing.rank) {
            bestByParent.set(pid, { doc, rank, similarity, lexical });
          }
        }
      }

      const rankedParents = Array.from(bestByParent.entries())
        .sort((a, b) => b[1].rank - a[1].rank);
      let parentIds = rankedParents.slice(0, 12).map(([parentId]) => parentId);
      let rerankedParentIds: string[] | null = null;
      if (precomputed?.skipRerank) {
        console.log("[chat] skipping rerank (precomputed plan)");
      } else {
        const rerankCandidates: RerankCandidate[] = rankedParents
          .slice(0, 20)
          .map(([parentId, { doc, similarity, lexical, rank }]) => ({
            parentId,
            source: String(doc.source ?? ""),
            url: String(doc.url ?? ""),
            category: String(doc.category ?? ""),
            similarity,
            lexical,
            rank,
            preview: String(doc.content ?? "").replace(/\s+/g, " ").slice(0, 320),
          }));
        rerankedParentIds = await rerankEvidenceWithLLM(
          openai,
          lastMessage,
          rerankCandidates,
        );
        if (rerankedParentIds && rerankedParentIds.length > 0) {
          const rerankedSet = new Set(rerankedParentIds);
          const remaining = parentIds.filter((id) => !rerankedSet.has(id));
          parentIds = [...rerankedParentIds, ...remaining].slice(0, 12);
        }
      }
      console.log("[chat] merged child results", {
        uniqueParents: parentIds.length,
        totalRawHits: searchResults.reduce((s, r) => s + r.length, 0),
        rerankedTop: rerankedParentIds?.length ?? 0,
      });

      // Step 2: Fetch parent chunks for rich LLM context
      let parents: Array<Record<string, unknown>> = [];
      if (parentIds.length > 0) {
        parents = await collection
          .find(
            { _id: { $in: parentIds } },
            { projection: { content: 1, source: 1, url: 1 } },
          )
          .toArray();
      }
      console.log("[chat] parent fetch results", { parentsFetched: parents.length });

      // Step 3: Use parent content as LLM context (richer than child content)
      if (parents.length > 0) {
        const rankByParentId = new Map(
          rankedParents.map(([parentId, score]) => [parentId, score]),
        );
        const parentOrder = new Map(parentIds.map((id, idx) => [id, idx]));
        docContent = JSON.stringify(
          parents
            .sort((a, b) => {
              const left = parentOrder.get(String(a._id)) ?? Number.MAX_SAFE_INTEGER;
              const right = parentOrder.get(String(b._id)) ?? Number.MAX_SAFE_INTEGER;
              return left - right;
            })
            .map((doc) => ({
              source: doc.source,
              url: doc.url,
              rank: rankByParentId.get(String(doc._id))?.rank ?? 0,
              similarity: rankByParentId.get(String(doc._id))?.similarity ?? 0,
              lexical: rankByParentId.get(String(doc._id))?.lexical ?? 0,
              content: doc.content,
            })),
        );
      } else if (bestByParent.size > 0) {
        console.log("[chat] fallback: using child content (no parents found)");
        docContent = JSON.stringify(
          rankedParents.slice(0, 12).map(([, { doc, rank, similarity, lexical }]) => ({
            source: doc.source,
            url: doc.url,
            rank,
            similarity,
            lexical,
            content: doc.content,
          })),
        );
      }

      if (bestByParent.size === 0) {
        const total = await collection.countDocuments({}, 2000);
        const fallbackDocs = await collection.find({}, { limit: 1 }).toArray();
        console.log("[chat] collection check", {
          count: total,
          sampleKeys: fallbackDocs[0] ? Object.keys(fallbackDocs[0]) : [],
          hasTypeField: Boolean(fallbackDocs[0]?.type),
        });
      }
    } catch (error) {
      console.log("Error querying vector search:", error);
      docContent = "";
    }

    // template to pass to openai
    const template = {
      role: "system",
      content: `You are Vector11, a football stats assistant.

Date context:
- Today (UTC): ${todayIso}
- Current European season baseline: ${currentEuropeanSeason}

Rules:
- Always use retrieved context from the vector database as the primary source of truth.
- If the context is partial, combine it with general football knowledge and clearly label what is from context vs general knowledge.
- If no relevant context is available, state that clearly, then answer from general knowledge.
- Default to CURRENT season/year when user asks "current", "latest", "now", or does not specify a season.
- If user provides a historical table (for example last season), treat it as historical and do not present it as current.
- When current-season data is unavailable, say it is unavailable instead of guessing.

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
  } catch {
    return Response.json(
      { error: "Failed to generate response." },
      { status: 500 },
    );
  }
}
