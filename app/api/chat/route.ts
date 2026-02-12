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
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 1000;
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

    // rewrite query using conversation context for better retrieval
    let retrievalQuery = lastMessage;
    if (chatMessages.length > 1) {
      const recentContext = chatMessages
        .slice(-4)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      const rewrite = await openai.chat.completions.create({
        model: "gpt-5-mini",
        messages: [
          {
            role: "system",
            content:
              `Rewrite the user's latest message as a standalone football stats search query. Include all relevant entities (players, teams, competitions, stats, dates) mentioned in the conversation. If season is not explicitly stated, assume current European season ${currentEuropeanSeason}. Output ONLY the rewritten query, nothing else.`,
          },
          { role: "user", content: recentContext },
        ],
      });
      retrievalQuery =
        rewrite.choices[0]?.message?.content?.trim() ?? lastMessage;
      console.log("[chat] rewritten query", {
        original: lastMessage.slice(0, 80),
        rewritten: retrievalQuery.slice(0, 80),
      });
    }

    //embedding
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: retrievalQuery,
      encoding_format: "float",
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const embedding = embeddingResponse.data[0].embedding;
    console.log("[chat] embedding", {
      dimensions: embedding.length,
      configured: EMBEDDING_DIMENSIONS,
    });

    //vector search — parent-child retrieval strategy
    try {
      const collection = db.collection(ASTRA_DB_COLLECTION);
      console.log("[chat] vector search (parent-child)", {
        keyspace: ASTRA_DB_NAMESPACE,
        collection: ASTRA_DB_COLLECTION,
      });

      // Step 1: Search child chunks for precise vector matching
      const cursor = collection.find(
        { type: "child" },
        {
          sort: { $vector: embedding },
          limit: 10,
          includeSimilarity: true,
          projection: { parentId: 1, content: 1, source: 1, url: 1 },
        },
      );
      const childDocs = await cursor.toArray();
      console.log("[chat] child search results", {
        count: childDocs.length,
        sampleKeys: childDocs[0] ? Object.keys(childDocs[0]) : [],
      });

      // Step 2: Fetch parent chunks for rich LLM context
      const parentIds = Array.from(
        new Set(
          childDocs
            .map((d) => d.parentId as string | undefined)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      let parents: Array<Record<string, unknown>> = [];
      if (parentIds.length > 0) {
        parents = await collection
          .find(
            { _id: { $in: parentIds } },
            { projection: { content: 1, source: 1, url: 1 } },
          )
          .toArray();
      }
      console.log("[chat] parent fetch results", {
        uniqueParentIds: parentIds.length,
        parentsFetched: parents.length,
      });

      // Step 3: Use parent content as LLM context (richer than child content)
      if (parents.length > 0) {
        const parentContent = parents.map((doc) => doc.content);
        docContent = JSON.stringify(parentContent);
      } else if (childDocs.length > 0) {
        // Fallback: use child content if parents are missing (orphaned children)
        console.log("[chat] fallback: using child content (no parents found)");
        const childContent = childDocs.map((d) => d.content);
        docContent = JSON.stringify(childContent);
      }

      if (childDocs.length === 0) {
        const total = await collection.countDocuments({}, 2000);
        const fallbackDocs = await collection.find({}, { limit: 1 }).toArray();
        console.log("[chat] collection check", {
          countUpperBound: 2000,
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
