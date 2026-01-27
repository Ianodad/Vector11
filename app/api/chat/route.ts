import OpenAI from "openai";
import { DataAPIClient, vector } from "@datastax/astra-db-ts";

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
const MAX_QUERY_VARIANTS = 6;
const RRF_K = 60;
const RRF_LIMIT = 10;
const MAX_FOLLOWUP_QUERIES = 3;

const QUERY_EXPANSIONS: Record<string, string[]> = {
  "man utd": ["manchester united", "man united", "mufc"],
  "man city": ["manchester city", "mcfc"],
  spurs: ["tottenham hotspur", "tottenham"],
  psg: ["paris saint-germain", "paris sg"],
  ucl: ["champions league", "uefa champions league"],
  uelf: ["europa league", "uefa europa league"],
  epl: ["premier league"],
  pl: ["premier league"],
  "la liga": ["laliga"],
  "serie a": ["serie-a"],
};

const QUERY_SYNONYMS: Array<[string, string]> = [
  ["fixtures", "schedule"],
  ["fixture", "schedule"],
  ["table", "standings"],
  ["stats", "statistics"],
  ["transfer", "rumor"],
  ["transfers", "rumors"],
  ["injury", "injuries"],
];

const openai = new OpenAI({
  apiKey: OPEN_API_KEY,
});

const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN, {
  timeoutDefaults: {
    requestTimeoutMs: 20000,
    generalMethodTimeoutMs: 60000,
  },
});
const db = client.db(ASTRA_DB_API_ENDPOINT, {
  keyspace: ASTRA_DB_NAMESPACE,
});

type RetrievedDoc = {
  _id?: string;
  content?: string;
  source?: string;
  $similarity?: number;
};

const normalizeQuery = (query: string): string => query.trim().toLowerCase();

const expandQueryVariants = (query: string): string[] => {
  const variants = new Set<string>([query]);
  const normalized = normalizeQuery(query);

  for (const [needle, expansions] of Object.entries(QUERY_EXPANSIONS)) {
    if (!normalized.includes(needle)) continue;
    for (const expansion of expansions) {
      variants.add(query.replace(new RegExp(needle, "gi"), expansion));
    }
  }

  for (const [needle, replacement] of QUERY_SYNONYMS) {
    if (!normalized.includes(needle)) continue;
    variants.add(query.replace(new RegExp(needle, "gi"), replacement));
  }

  return Array.from(variants).slice(0, MAX_QUERY_VARIANTS);
};

const rrfMerge = (
  resultSets: RetrievedDoc[][],
  limit = RRF_LIMIT,
  k = RRF_K,
): RetrievedDoc[] => {
  const scored = new Map<string, { doc: RetrievedDoc; score: number }>();

  resultSets.forEach((docs) => {
    docs.forEach((doc, idx) => {
      const key = doc._id ?? doc.content ?? JSON.stringify(doc);
      if (!key) return;
      const entry = scored.get(key) ?? { doc, score: 0 };
      entry.score += 1 / (k + idx + 1);
      scored.set(key, entry);
    });
  });

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.doc);
};

const buildFollowUpQueryPrompt = (
  userQuery: string,
  docs: RetrievedDoc[],
): string => {
  const snippets = docs
    .slice(0, 3)
    .map((doc, idx) => {
      const text = (doc.content || "").replace(/\s+/g, " ").trim();
      return `Doc ${idx + 1}: ${text.slice(0, 240)}`;
    })
    .join("\n");

  return [
    "Generate 2-3 short follow-up search queries to improve retrieval.",
    "Keep them football-specific and concrete. No quotes, no numbering.",
    `User query: ${userQuery}`,
    `Top docs:\n${snippets}`,
  ].join("\n");
};

const parseFollowUpQueries = (raw: string): string[] =>
  raw
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 2)
    .slice(0, MAX_FOLLOWUP_QUERIES);

export async function POST(request: Request) {
  try {
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
            content: message.content.trim(),
          }))
          .filter((message) => message.content.length > 0)
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
    const queryVariants = expandQueryVariants(lastMessage);
    console.log("[chat] query expansion", {
      original: lastMessage,
      variants: queryVariants,
    });

    // Embedding all variants at once keeps cost low and ensures consistent dimensions.
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: queryVariants,
      encoding_format: "float",
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const embeddings = embeddingResponse.data.map((item) => item.embedding);
    console.log("[chat] embedding", {
      count: embeddings.length,
      dimensions: embeddings[0]?.length ?? 0,
      configured: EMBEDDING_DIMENSIONS,
    });

    //vector search (hop 1)
    try {
      const collection = db.collection(ASTRA_DB_COLLECTION);
      console.log("[chat] vector search", {
        keyspace: ASTRA_DB_NAMESPACE,
        collection: ASTRA_DB_COLLECTION,
      });
      const resultsPerVariant: RetrievedDoc[][] = [];

      for (const vectorEmbedding of embeddings) {
        const cursor = collection.find(
          {},
          {
            sort: { $vector: vectorEmbedding },
            limit: RRF_LIMIT,
            includeSimilarity: true,
            projection: { _id: 1, content: 1, source: 1 },
          },
        );
        resultsPerVariant.push(
          (await cursor.toArray()) as unknown as RetrievedDoc[],
        );
      }

      const merged = rrfMerge(resultsPerVariant);
      console.log("[chat] vector search results", {
        variants: resultsPerVariant.length,
        mergedCount: merged.length,
        sampleKeys: merged[0] ? Object.keys(merged[0]) : [],
      });

      // Multi-hop: generate follow-up queries from top docs and re-search.
      let finalDocs = merged;
      try {
        const followUpPrompt = buildFollowUpQueryPrompt(lastMessage, merged);
        const followUpResponse = await openai.chat.completions.create({
          model: "gpt-5-mini",
          messages: [
            { role: "system", content: "You generate search queries only." },
            { role: "user", content: followUpPrompt },
          ],
        });
        const followUpText =
          followUpResponse.choices[0]?.message?.content ?? "";
        const followUpQueries = parseFollowUpQueries(followUpText);
        console.log("[chat] follow-up queries", followUpQueries);

        if (followUpQueries.length > 0) {
          const followUpEmbeddings = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: followUpQueries,
            encoding_format: "float",
            dimensions: EMBEDDING_DIMENSIONS,
          });
          const followUpSets: RetrievedDoc[][] = [];
          for (const item of followUpEmbeddings.data) {
            const cursor = collection.find(
              {},
              {
                sort: { $vector: item.embedding },
                limit: RRF_LIMIT,
                includeSimilarity: true,
                projection: { _id: 1, content: 1, source: 1 },
              },
            );
            followUpSets.push(
              (await cursor.toArray()) as unknown as RetrievedDoc[],
            );
          }
          finalDocs = rrfMerge([merged, ...followUpSets]);
          console.log("[chat] multi-hop merge", {
            followUpCount: followUpQueries.length,
            finalCount: finalDocs.length,
          });
        }
      } catch (followUpError) {
        console.warn("[chat] follow-up query generation failed", followUpError);
      }

      docContent = JSON.stringify(
        finalDocs.map((doc) => ({
          content: doc.content,
          source: doc.source,
        })),
      );

      if (finalDocs.length === 0) {
        const total = await collection.countDocuments({}, 2000);
        const fallbackDocs = await collection.find({}, { limit: 1 }).toArray();
        console.log("[chat] collection check", {
          countUpperBound: 2000,
          count: total,
          sampleKeys: fallbackDocs[0] ? Object.keys(fallbackDocs[0]) : [],
          hasVectorField: Boolean(fallbackDocs[0]?.vector),
          hasDollarVectorField: Boolean(fallbackDocs[0]?.$vector),
        });
      }
    } catch (error) {
      console.log("Error querying vector search:", error);
      docContent = "";
    }

    // template to pass to openai
    const template = {
      role: "system",
      content: `You are Vector11, a football stats assistant. Always use the retrieved context (from the vector database) as the primary source of truth. If the context answers the question, summarize it clearly. If the context is partial, combine
  it with your football knowledge and explicitly label which parts are from context vs. general knowledge. If there is no relevant context, say so and answer from general knowledge. Be concise, tactical, and data-aware. Here is the context: ${docContent}`,
    };

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [template, ...chatMessages],
    });

    const assistantMessage = response.choices[0]?.message?.content ?? "";
    return Response.json({ message: assistantMessage });
  } catch (error) {
    return Response.json(
      { error: "Failed to generate response." },
      { status: 500 },
    );
  }
}
