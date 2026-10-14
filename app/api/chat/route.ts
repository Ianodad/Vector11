// app/api/chat/route.ts
import OpenAI from "openai";
import { DbResumingError, retrieveContext } from "../../lib/retrieval";
import { getSeasonContext } from "../../lib/season";
import type { ChatSource } from "../../types/chat";

export const maxDuration = 60;

const requiredEnv = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const OPEN_API_KEY = requiredEnv(process.env.OPEN_API_KEY, "OPEN_API_KEY");
const RATE_LIMIT_WINDOW_MS =
  Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_REQUESTS_PER_WINDOW =
  Number(process.env.MAX_REQUESTS_PER_WINDOW) || 12;
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS) || 600;
const MAX_MESSAGES_PER_REQUEST = Number(process.env.MAX_MESSAGES_PER_REQUEST) || 20;

const openai = new OpenAI({
  apiKey: OPEN_API_KEY,
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
    let sources: ChatSource[] = [];

    try {
      const retrieval = await retrieveContext({ chatMessages, lastMessage, season });
      sources = retrieval.sources;
      if (retrieval.parents.length > 0) {
        docContent = JSON.stringify(
          retrieval.parents.map((p) => ({
            source: p.source,
            url: p.url,
            ...(p.rerank !== undefined
              ? { rerank: p.rerank }
              : { rank: p.rank ?? 0, lexical: p.lexical ?? 0 }),
            similarity: p.similarity,
            content: p.content,
          })),
        );
      }
    } catch (error) {
      if (error instanceof DbResumingError) {
        console.log("Error querying vector search:", error.cause);
        return Response.json(
          {
            error:
              "The stats database is waking up from sleep. Give it about 30 seconds and ask again.",
          },
          { status: 503, headers: { "Retry-After": "30" } },
        );
      }
      throw error;
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

    // Await the stream handshake BEFORE building the 200 response, so OpenAI auth/rate/5xx
    // errors still land in the outer catch and return JSON 500.
    const completion = await openai.chat.completions.create(
      {
        model: "gpt-5-mini",
        messages: [template, ...chatMessages],
        stream: true,
      },
      { signal: request.signal },
    );

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          send({ type: "sources", sources });
          for await (const chunk of completion) {
            if (request.signal.aborted) break;
            const text = chunk.choices[0]?.delta?.content;
            if (text) send({ type: "delta", text });
          }
          if (!request.signal.aborted) send({ type: "done" });
        } catch (streamErr) {
          console.log("[chat] stream failed:", streamErr);
          try {
            if (!request.signal.aborted) {
              send({ type: "error", message: "The answer stream was interrupted." });
              send({ type: "done" });
            }
          } catch {
            // controller already closed/errored
          }
        } finally {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.log("[chat] request failed:", error);
    return Response.json(
      { error: "Failed to generate response." },
      { status: 500 },
    );
  }
}
