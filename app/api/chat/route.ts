// app/api/chat/route.ts
import OpenAI from "openai";
import { DataAPIClient, vector } from "@datastax/astra-db-ts";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";

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

const chat = new ChatOpenAI({
  model: "gpt-5-mini",
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
    const { messages, multiQuery: multiQueryEnabled } = await request.json();
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
    let relevantDocs: any[] = [];
    let totalTokensUsed = 0;

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
      totalTokensUsed += rewrite.usage?.total_tokens ?? 0;
      retrievalQuery =
        rewrite.choices[0]?.message?.content?.trim() ?? lastMessage;
      console.log("[chat] rewritten query", {
        original: lastMessage.slice(0, 80),
        rewritten: retrievalQuery.slice(0, 80),
        tokens: rewrite.usage?.total_tokens ?? 0,
      });
    }

    const collection = db.collection(ASTRA_DB_COLLECTION);

    // helper: embed a query and search the vector DB
    async function searchByQuery(query: string, limit: number = 10) {
      const resp = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: query,
        encoding_format: "float",
        dimensions: EMBEDDING_DIMENSIONS,
      });
      const cursor = collection.find(
        {},
        {
          sort: { $vector: resp.data[0].embedding },
          limit,
          includeSimilarity: true,
          projection: { content: 1, source: 1 },
        },
      );
      return cursor.toArray();
    }

    try {
      console.log("[chat] retrieval mode", {
        multiQuery: Boolean(multiQueryEnabled),
        keyspace: ASTRA_DB_NAMESPACE,
        collection: ASTRA_DB_COLLECTION,
      });

      let allDocuments: any[];

      if (multiQueryEnabled) {
        // generate 3 diverse search queries from the user's question
        const mqResponse = await openai.chat.completions.create({
          model: "gpt-5-mini",
          messages: [
            {
              role: "system",
              content:
                "Generate exactly 3 diverse search queries for a football stats vector database based on the user's question. Each query should approach the topic from a different angle (e.g. stats, narrative, comparison). Output ONLY the 3 queries, one per line, no numbering or extra text.",
            },
            { role: "user", content: retrievalQuery },
          ],
        });
        totalTokensUsed += mqResponse.usage?.total_tokens ?? 0;
        const queries = (mqResponse.choices[0]?.message?.content ?? retrievalQuery)
          .split("\n")
          .map((q) => q.trim())
          .filter((q) => q.length > 0)
          .slice(0, 3);

        console.log("[chat] multi-query searches", queries);

        // run all 3 searches in parallel, 5 results each
        const searchResults = await Promise.all(
          queries.map((q) => searchByQuery(q, 5)),
        );

        // merge & deduplicate by content prefix
        const seen = new Set<string>();
        allDocuments = [];
        for (const docs of searchResults) {
          for (const doc of docs) {
            const key = doc.content?.slice(0, 200) ?? "";
            if (!seen.has(key)) {
              seen.add(key);
              allDocuments.push(doc);
            }
          }
        }
        // sort by similarity descending
        allDocuments.sort(
          (a, b) => (b.$similarity ?? 0) - (a.$similarity ?? 0),
        );
      } else {
        // single-query retrieval
        allDocuments = await searchByQuery(retrievalQuery);
      }

      relevantDocs = allDocuments.filter(
        (doc) => (doc.$similarity ?? 0) >= 0.5,
      );
      console.log("[chat] vector search results", {
        mode: multiQueryEnabled ? "multi-query" : "single-query",
        total: allDocuments.length,
        aboveThreshold: relevantDocs.length,
        topSimilarity: allDocuments[0]?.$similarity ?? null,
        lowestKept: relevantDocs.at(-1)?.$similarity ?? null,
        tokensUsedSoFar: totalTokensUsed,
      });

      docContent = JSON.stringify(relevantDocs.map((doc) => doc.content));

      if (allDocuments.length === 0) {
        const total = await collection.countDocuments({}, 2000);
        console.log("[chat] collection check", { count: total });
      }
    } catch (error) {
      console.log("Error querying vector search:", error);
      docContent = "";
    }

    // Convert messages to LangChain format
    const docsFound = relevantDocs?.length ?? 0;
    const systemMessage = new SystemMessage(`You are Vector11, a football stats assistant.

## Instructions
- Use the RETRIEVED CONTEXT below as your primary source of truth.
- If the context answers the question, summarize it clearly and cite source numbers like [1], [2].
- If the context is partial, supplement with your general football knowledge and label which parts come from context vs. general knowledge.
- If there is no relevant context, say so and answer from general knowledge.
- If the user asks for standings, top teams, rankings, or league tables AND the context contains actual data for it, return a markdown table first, then a short "Quick read" summary. NEVER generate a table if the context does not contain the actual data — instead explain what data is missing.
- Be concise, tactical, and data-aware.

## Retrieved Context (${docsFound} documents)
${docContent || "No relevant documents found."}`);

    const langchainMessages = chatMessages.map((m) =>
      m.role === "user"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content)
    );

    const allMessages = [systemMessage, ...langchainMessages];

    const response = await chat.invoke(allMessages);

    // Note: LangChain ChatOpenAI doesn't expose token usage directly in the response
    // Token tracking for the final completion is not available without callbacks
    const assistantMessage = response.content as string;
    console.log("[chat] response complete", {
      mode: multiQueryEnabled ? "multi-query" : "single-query",
      tokensFromRetrievalOps: totalTokensUsed,
      note: "Final completion tokens not tracked (LangChain limitation)",
    });
    return Response.json({ message: assistantMessage });
  } catch (error) {
    return Response.json(
      { error: "Failed to generate response." },
      { status: 500 },
    );
  }
}
