// app/api/prompts/route.ts
import { DataAPIClient } from "@datastax/astra-db-ts";
import { CONTEXT_PROMPTS } from "../../lib/constants";

// Prompts are cosmetic (suggested questions only) — this route must NEVER
// 500. Any missing env var, DB error, or missing doc falls back to the
// static CONTEXT_PROMPTS list. Unlike app/api/chat/route.ts, env vars are
// validated inline (not via a module-scope throw) precisely so a missing var
// can never take the whole route down — it just means an earlier fallback.
const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
};

// Shorter cache on the fallback path — a missing/errored corpus doc should
// self-heal quickly once fixed, rather than being pinned behind the
// success-path's much longer TTL for up to an hour.
const FALLBACK_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
};

const fallbackResponse = () =>
  Response.json(
    {
      prompts: CONTEXT_PROMPTS,
      season: null,
      generatedAt: null,
      fallback: true,
    },
    { headers: FALLBACK_CACHE_HEADERS },
  );

export async function GET() {
  try {
    const ASTRA_DB_NAMESPACE = process.env.ASTRA_DB_NAMESPACE;
    const ASTRA_DB_COLLECTION = process.env.ASTRA_DB_COLLECTION;
    const ASTRA_DB_API_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
    const ASTRA_DB_APPLICATION_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;

    if (
      !ASTRA_DB_NAMESPACE ||
      !ASTRA_DB_COLLECTION ||
      !ASTRA_DB_API_ENDPOINT ||
      !ASTRA_DB_APPLICATION_TOKEN
    ) {
      return fallbackResponse();
    }

    // Short timeouts on purpose: this is a cosmetic, cacheable endpoint — a
    // cold (hibernating) Astra DB should fall back immediately rather than
    // make the caller wait through the chat route's resume-retry loop.
    const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN, {
      timeoutDefaults: {
        requestTimeoutMs: 5000,
        generalMethodTimeoutMs: 8000,
      },
    });
    const db = client.db(ASTRA_DB_API_ENDPOINT, {
      keyspace: ASTRA_DB_NAMESPACE,
    });
    const collection = db.collection(ASTRA_DB_COLLECTION);

    const doc = await collection.findOne({ _id: "meta:suggested-prompts" });

    if (!doc || !Array.isArray(doc.prompts) || doc.prompts.length === 0) {
      return fallbackResponse();
    }

    return Response.json(
      {
        prompts: doc.prompts,
        season: doc.season ?? null,
        generatedAt: doc.generatedAt ?? null,
        fallback: false,
      },
      { headers: CACHE_HEADERS },
    );
  } catch (error) {
    console.error("[prompts] Failed to fetch suggested prompts, using fallback:", error);
    return fallbackResponse();
  }
}
