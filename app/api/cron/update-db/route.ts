import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import OpenAI from "openai";
import { XMLParser } from "fast-xml-parser";

// ── Environment ──────────────────────────────────────────────────────
const env = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
};

const CRON_SECRET = process.env.CRON_SECRET;
const ASTRA_DB_NAMESPACE = env("ASTRA_DB_NAMESPACE");
const ASTRA_DB_COLLECTION = env("ASTRA_DB_COLLECTION");
const ASTRA_DB_API_ENDPOINT = env("ASTRA_DB_API_ENDPOINT");
const ASTRA_DB_APPLICATION_TOKEN = env("ASTRA_DB_APPLICATION_TOKEN");
const OPEN_API_KEY = env("OPEN_API_KEY");
const VECTOR_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 15000;

// ── Clients ──────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: OPEN_API_KEY });
const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(ASTRA_DB_API_ENDPOINT, { keyspace: ASTRA_DB_NAMESPACE });

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 800,
  chunkOverlap: 150,
});

const childSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 400,
  chunkOverlap: 50,
});

// ── RSS Feeds ────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml", source: "BBC Football RSS" },
  { url: "https://www.theguardian.com/football/rss", source: "The Guardian Football RSS" },
  { url: "https://www.espn.com/espn/rss/soccer/news", source: "ESPN Soccer RSS" },
  { url: "https://www.skysports.com/rss/12040", source: "Sky Sports Football RSS" },
];

const KEYWORDS = [
  "football", "soccer", "premier", "afcon", "fifa", "uefa",
  "champions", "goal", "transfer", "match", "fixture", "stats", "player",
];

const BLOCK_PATTERNS = [
  "/video", "/live", "/podcast", "/shop", "/login", "/signup",
  ".pdf", ".jpg", ".png", ".gif", ".mp4",
];

// ── Types ────────────────────────────────────────────────────────────
interface RssItem {
  title?: string;
  link?: string | { "@_href"?: string };
}

// ── Helpers ──────────────────────────────────────────────────────────
const isBlocked = (url: string): boolean =>
  BLOCK_PATTERNS.some((p) => url.toLowerCase().includes(p));

const matchesKeywords = (url: string, title: string): boolean => {
  const hay = `${url} ${title}`.toLowerCase();
  return KEYWORDS.some((k) => hay.includes(k));
};

const normalizeRssLink = (link: RssItem["link"]): string | undefined => {
  if (!link) return undefined;
  if (typeof link === "string") return link;
  return (link as { "@_href"?: string })["@_href"];
};

const fetchWithTimeout = async (url: string): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Vector11Bot/1.0)",
      accept: "text/html,application/xml,text/xml,*/*",
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
};

const extractRssLinks = async (feedUrl: string): Promise<{ url: string; title: string }[]> => {
  const res = await fetchWithTimeout(feedUrl);
  if (!res.ok) return [];
  const text = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const result = parser.parse(text);
  const items: RssItem[] = result.rss?.channel?.item || result.feed?.entry || [];

  return items
    .map((item) => {
      const raw = normalizeRssLink(item.link);
      if (!raw) return null;
      const url = raw.split("#")[0];
      const title = String(item.title || "");
      return { url, title };
    })
    .filter((entry): entry is { url: string; title: string } => {
      if (!entry) return false;
      if (isBlocked(entry.url)) return false;
      if (!matchesKeywords(entry.url, entry.title)) return false;
      return true;
    })
    .slice(0, 30);
};

const scrapeArticle = async (url: string): Promise<string> => {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return "";
    const html = await res.text();

    // Strip HTML tags, scripts, styles — extract text content
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<aside[\s\S]*?<\/aside>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, "")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return cleaned.length >= 200 ? cleaned : "";
  } catch {
    return "";
  }
};

// ── Main Handler ─────────────────────────────────────────────────────
export async function GET(request: Request) {
  // Verify cron secret (Vercel sends this header automatically)
  if (CRON_SECRET) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  const collection = db.collection(ASTRA_DB_COLLECTION);

  let newArticles = 0;
  let skipped = 0;
  let totalTokens = 0;
  const errors: string[] = [];

  for (const feed of RSS_FEEDS) {
    try {
      const articles = await extractRssLinks(feed.url);
      console.log(`[cron] ${feed.source}: ${articles.length} articles found`);

      for (const article of articles) {
        // Check if URL already exists in DB to avoid unnecessary scraping + embedding
        const existing = await collection.findOne({ url: article.url }, { projection: { _id: 1 } });
        if (existing) {
          skipped++;
          continue;
        }

        const content = await scrapeArticle(article.url);
        if (!content) {
          skipped++;
          continue;
        }

        // Parent-child chunking (same as loadDb.ts)
        const parentChunks = await splitter.splitText(content);
        const filteredParents = parentChunks.filter((c) => c.trim().length >= 120);
        if (filteredParents.length === 0) { skipped++; continue; }

        const scrapedAt = new Date().toISOString();
        const parentDocs: Array<{ _id: string; content: string; source: string; url: string; category: string; scrapedAt: string; type: "parent" }> = [];
        const childTexts: string[] = [];
        const childMeta: { parentId: string }[] = [];

        for (const parentChunk of filteredParents) {
          const parentId = createHash("md5").update(parentChunk).digest("hex");
          parentDocs.push({
            _id: parentId,
            content: parentChunk,
            source: feed.source,
            url: article.url,
            category: "rss",
            scrapedAt,
            type: "parent",
          });

          const children = await childSplitter.splitText(parentChunk);
          for (const child of children.filter((c) => c.trim().length >= 80)) {
            childTexts.push(child);
            childMeta.push({ parentId });
          }
        }

        if (childTexts.length === 0) { skipped++; continue; }

        // Batch embed child chunks
        const EMBED_BATCH = 100;
        const allVectors: number[][] = [];
        for (let b = 0; b < childTexts.length; b += EMBED_BATCH) {
          const batch = childTexts.slice(b, b + EMBED_BATCH);
          const enriched = batch.map((c) => `[Source: ${feed.source}]\n${c}`);
          const embRes = await openai.embeddings.create({
            model: "text-embedding-3-large",
            input: enriched,
            dimensions: VECTOR_DIMENSIONS,
            encoding_format: "float",
          });
          for (const item of embRes.data) allVectors.push(item.embedding);
          totalTokens += embRes.usage?.total_tokens ?? 0;
        }

        // Insert parents (no vector)
        try {
          await collection.insertMany(parentDocs, { ordered: false });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "";
          if (!msg.includes("already exists") && !msg.includes("duplicate")) throw e;
        }

        // Insert children (with vector)
        const childDocs = childTexts.map((chunk, idx) => ({
          _id: createHash("md5").update(`${childMeta[idx].parentId}|${chunk}`).digest("hex"),
          content: chunk,
          parentId: childMeta[idx].parentId,
          source: feed.source,
          url: article.url,
          category: "rss",
          scrapedAt,
          type: "child" as const,
          $vector: allVectors[idx],
        }));

        const INSERT_BATCH = 20;
        for (let b = 0; b < childDocs.length; b += INSERT_BATCH) {
          try {
            await collection.insertMany(childDocs.slice(b, b + INSERT_BATCH), { ordered: false });
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "";
            if (!msg.includes("already exists") && !msg.includes("duplicate")) throw e;
          }
        }

        newArticles++;
        console.log(`[cron] Inserted: ${article.url} (${parentDocs.length}P + ${childTexts.length}C)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${feed.source}: ${msg}`);
      console.error(`[cron] Feed error ${feed.source}:`, msg);
    }
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = {
    ok: true,
    newArticles,
    skipped,
    embeddingTokens: totalTokens,
    durationSec,
    errors: errors.length > 0 ? errors : undefined,
  };

  console.log("[cron] Done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}
