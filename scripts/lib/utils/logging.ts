// Structured logging & summary generation
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getErrorMessage } from "./retry.js";

export interface UrlChunkStats {
  parents: number;
  children: number;
}

export interface SeedSummary {
  processedUrls: number;
  processedUrlList: string[];
  urlChunkStats: Record<string, UrlChunkStats>; // url → per-url chunk counts
  recordsAdded: number;
  parentsAdded: number;
  childrenAdded: number;
  totalEmbeddingTokens: number;
  durationMs: number;
}

export const formatDuration = (durationMs: number): string => {
  const totalSecs = Math.floor(durationMs / 1000);
  const hh = String(Math.floor(totalSecs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSecs % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

export const calculateEmbeddingCost = (totalEmbeddingTokens: number): number => {
  // text-embedding-3-large pricing: $0.13 per 1M tokens
  return (totalEmbeddingTokens / 1_000_000) * 0.13;
};

const getDomain = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
};

/**
 * Group processed URLs by domain and build per-domain subtotals.
 * Returns an ordered array so higher-chunk domains appear first.
 */
const buildDomainGroups = (
  urls: string[],
  stats: Record<string, UrlChunkStats>,
): Array<{
  domain: string;
  entries: Array<{ url: string; parents: number; children: number }>;
  totalParents: number;
  totalChildren: number;
}> => {
  const map = new Map<
    string,
    Array<{ url: string; parents: number; children: number }>
  >();

  for (const url of urls) {
    const domain = getDomain(url);
    if (!map.has(domain)) map.set(domain, []);
    const s = stats[url] ?? { parents: 0, children: 0 };
    map.get(domain)!.push({ url, parents: s.parents, children: s.children });
  }

  return Array.from(map.entries())
    .map(([domain, entries]) => ({
      domain,
      entries,
      totalParents: entries.reduce((n, e) => n + e.parents, 0),
      totalChildren: entries.reduce((n, e) => n + e.children, 0),
    }))
    .sort((a, b) => b.totalChildren + b.totalParents - (a.totalChildren + a.totalParents));
};

export const logSummary = (summary: SeedSummary): void => {
  const {
    processedUrls,
    urlChunkStats,
    processedUrlList,
    recordsAdded,
    parentsAdded,
    childrenAdded,
    totalEmbeddingTokens,
    durationMs,
  } = summary;
  const estimatedCost = calculateEmbeddingCost(totalEmbeddingTokens);
  const formattedDuration = formatDuration(durationMs);

  console.log("\n✅ Seed complete");
  console.log(`⏱️  Time taken: ${formattedDuration}`);
  console.log(`📄 Parsed URLs: ${processedUrls}`);
  console.log(`💾 Records added: ${recordsAdded} total`);
  console.log(`   ├─ 📦 Parent chunks: ${parentsAdded}`);
  console.log(`   └─ 🧩 Child chunks:  ${childrenAdded}`);
  console.log(`🔤 Embedding tokens used: ${totalEmbeddingTokens.toLocaleString()}`);
  console.log(`💰 Estimated embedding cost: $${estimatedCost.toFixed(4)}`);

  const groups = buildDomainGroups(processedUrlList, urlChunkStats);
  console.log("\n📋 Parsed URLs by source:");
  for (const { domain, entries, totalParents, totalChildren } of groups) {
    const urlWord = entries.length === 1 ? "URL" : "URLs";
    console.log(
      `\n  ${domain}  (${entries.length} ${urlWord} — ${totalParents}p / ${totalChildren}c)`,
    );
    for (const { url, parents, children } of entries) {
      console.log(`    - ${url}  (${parents}p / ${children}c)`);
    }
  }
};

export const writeSummaryLog = async (summary: SeedSummary): Promise<void> => {
  const {
    processedUrls,
    urlChunkStats,
    processedUrlList,
    recordsAdded,
    parentsAdded,
    childrenAdded,
    totalEmbeddingTokens,
    durationMs,
  } = summary;
  const estimatedCost = calculateEmbeddingCost(totalEmbeddingTokens);
  const formattedDuration = formatDuration(durationMs);

  const groups = buildDomainGroups(processedUrlList, urlChunkStats);
  const urlLines: string[] = [];
  for (const { domain, entries, totalParents, totalChildren } of groups) {
    const urlWord = entries.length === 1 ? "URL" : "URLs";
    urlLines.push(
      `  ${domain}  (${entries.length} ${urlWord} — ${totalParents}p / ${totalChildren}c)`,
    );
    for (const { url, parents, children } of entries) {
      urlLines.push(`    - ${url}  (${parents}p / ${children}c)`);
    }
    urlLines.push("");
  }

  const dateStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logLines = [
    "✅ Seed complete",
    `⏱️  Time taken: ${formattedDuration}`,
    `📄 Parsed URLs: ${processedUrls}`,
    `💾 Records added: ${recordsAdded} total`,
    `   ├─ 📦 Parent chunks: ${parentsAdded}`,
    `   └─ 🧩 Child chunks:  ${childrenAdded}`,
    `🔤 Embedding tokens used: ${totalEmbeddingTokens.toLocaleString()}`,
    `💰 Estimated embedding cost: $${estimatedCost.toFixed(4)}`,
    "",
    "📋 Parsed URLs by source:",
    ...urlLines,
  ];

  try {
    const logDir = join(process.cwd(), "scripts", "logs");
    await mkdir(logDir, { recursive: true });
    const logFilePath = join(logDir, `seed-summary-${dateStamp}.log`);
    await writeFile(logFilePath, `${logLines.join("\n")}\n`, "utf8");
    console.log(`📝 Summary log written: ${logFilePath}`);
  } catch (error) {
    console.warn("⚠️  Failed to write seed summary log:", getErrorMessage(error));
  }
};
