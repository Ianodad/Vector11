// app/api/chat/route.ts
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
              "Rewrite the user's latest message as a standalone football stats search query. Include all relevant entities (players, teams, competitions, stats, dates) mentioned in the conversation. Output ONLY the rewritten query, nothing else.",
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
      model: "text-embedding-3-small",
      input: retrievalQuery,
      encoding_format: "float",
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const embedding = embeddingResponse.data[0].embedding;
    console.log("[chat] embedding", {
      dimensions: embedding.length,
      configured: EMBEDDING_DIMENSIONS,
    });

    //vector search
    try {
      const collection = db.collection(ASTRA_DB_COLLECTION);
      console.log("[chat] vector search", {
        keyspace: ASTRA_DB_NAMESPACE,
        collection: ASTRA_DB_COLLECTION,
      });
      const cursor = collection.find(
        {},
        {
          sort: { $vector: embedding },
          limit: 10,
          includeSimilarity: true,
          projection: { content: 1, source: 1 },
        },
      );

      const documents = await cursor.toArray();
      console.log("[chat] vector search results", {
        count: documents.length,
        sampleKeys: documents[0] ? Object.keys(documents[0]) : [],
      });
      const docsMap = documents.map((doc) => doc.content);

      docContent = JSON.stringify(docsMap);

      if (documents.length === 0) {
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
  it with your football knowledge and explicitly label which parts are from context vs. general knowledge. If there is no relevant context, say so and answer from general knowledge. If the user asks for standings, top teams, rankings, or league tables, return a markdown table first, then a short "Quick read" summary. Be concise, tactical, and data-aware. Here is the context: ${docContent}`,
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
