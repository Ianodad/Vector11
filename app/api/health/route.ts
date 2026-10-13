// app/api/health/route.ts
// Cheap warm-up probe. Pings Astra once; the client polls until it reports "ready".
import { DataAPIClient, DataAPITimeoutError } from "@datastax/astra-db-ts";
import { isDbResumingError } from "../../lib/astraResume";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

type HealthStatus = "ready" | "waking" | "error";

let cachedClient: DataAPIClient | null = null;
// Dev-only test hook: when the module first handles a request.
let firstRequestAt: number | null = null;

const respond = (status: HealthStatus) =>
  Response.json({ status }, { headers: { "Cache-Control": "no-store" } });

const isTimeoutError = (err: unknown): boolean => {
  if (err instanceof DataAPITimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timed? ?out/i.test(msg);
};

export async function GET() {
  // Dev-only: pretend the DB is waking for N ms (DEBUG_FORCE_DB_WAKING_MS) without touching it.
  if (process.env.NODE_ENV !== "production") {
    const forceMs = Number(process.env.DEBUG_FORCE_DB_WAKING_MS);
    if (forceMs > 0) {
      firstRequestAt ??= Date.now();
      if (Date.now() - firstRequestAt < forceMs) return respond("waking");
    }
  }

  const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
  const token = process.env.ASTRA_DB_APPLICATION_TOKEN;
  const keyspace = process.env.ASTRA_DB_NAMESPACE;
  const collectionName = process.env.ASTRA_DB_COLLECTION;
  if (!endpoint || !token || !keyspace || !collectionName) return respond("error");

  try {
    cachedClient ??= new DataAPIClient(token, {
      timeoutDefaults: { requestTimeoutMs: 8000 },
    });
    const db = cachedClient.db(endpoint, { keyspace });
    await db.collection(collectionName).findOne({}, { projection: { _id: 1 } });
    return respond("ready");
  } catch (err) {
    if (isDbResumingError(err) || isTimeoutError(err)) return respond("waking");
    console.log("[health] probe failed", err);
    return respond("error");
  }
}
