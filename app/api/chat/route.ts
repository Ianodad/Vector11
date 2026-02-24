// app/api/chat/route.ts
import OpenAI from "openai";
import { DataAPIClient } from "@datastax/astra-db-ts";

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

    let plan: RetrievalPlan = { queries: [lastMessage], category: null };
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
    const queryTokens = tokenizeQuery([lastMessage, ...plan.queries].join(" "));
    const fixtureLikeRequest = /fixture|fixtures|result|results|schedule|upcoming|kick-?off/i.test(
      [lastMessage, ...plan.queries].join(" "),
    );

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

      const VALID_CATEGORIES = new Set([
        "news", "stats", "playerPerformance", "fixtures", "analysis", "teams",
      ]);
      const categoryFilter =
        plan.category && VALID_CATEGORIES.has(plan.category)
          ? { type: "child", category: plan.category }
          : { type: "child" };

      // Step 1: Run all searches in parallel
      const searchResults = await Promise.all(
        embeddings.map((vec) =>
          collection
            .find(categoryFilter, {
              sort: { $vector: vec },
              limit: 20,
              includeSimilarity: true,
              projection: { parentId: 1, content: 1, source: 1, url: 1 },
            })
            .toArray(),
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
          const lexical = lexicalOverlapScore(
            queryTokens,
            `${String(doc.source || "")} ${String(doc.url || "")} ${content}`,
          );
          const rank = similarity + lexical * 0.08;
          const existing = bestByParent.get(pid);
          if (!existing || rank > existing.rank) {
            bestByParent.set(pid, { doc, rank, similarity, lexical });
          }
        }
      }

      // If category filter yielded too few results, fall back to unfiltered
      if (bestByParent.size < 3 && plan.category) {
        console.log("[chat] category filter low results, retrying without category");
        const fallbackResults = await Promise.all(
          embeddings.map((vec) =>
            collection
              .find({ type: "child" }, {
                sort: { $vector: vec },
                limit: 20,
                includeSimilarity: true,
                projection: { parentId: 1, content: 1, source: 1, url: 1 },
              })
              .toArray(),
          ),
        );
        for (const docs of fallbackResults) {
          for (const doc of docs) {
            const pid = doc.parentId as string | undefined;
            if (!pid) continue;
            const content = (doc.content as string | undefined) ?? "";
            if (fixtureLikeRequest && isLikelyTickerNoise(content)) continue;

            const similarity = (doc.$similarity as number) ?? 0;
            const lexical = lexicalOverlapScore(
              queryTokens,
              `${String(doc.source || "")} ${String(doc.url || "")} ${content}`,
            );
            const rank = similarity + lexical * 0.08;
            const existing = bestByParent.get(pid);
            if (!existing || rank > existing.rank) {
              bestByParent.set(pid, { doc, rank, similarity, lexical });
            }
          }
        }
      }

      const parentIds = Array.from(bestByParent.keys());
      console.log("[chat] merged child results", {
        uniqueParents: parentIds.length,
        totalRawHits: searchResults.reduce((s, r) => s + r.length, 0),
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
        docContent = JSON.stringify(
          parents.map((doc) => ({
            source: doc.source,
            url: doc.url,
            content: doc.content,
          })),
        );
      } else if (bestByParent.size > 0) {
        console.log("[chat] fallback: using child content (no parents found)");
        docContent = JSON.stringify(
          Array.from(bestByParent.values()).map(({ doc, similarity, lexical }) => ({
            source: doc.source,
            url: doc.url,
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
