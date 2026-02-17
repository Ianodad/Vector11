// Structured logging & summary generation
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getErrorMessage } from "./retry.js";

export interface SeedSummary {
  processedUrls: number;
  processedUrlList: string[];
  recordsAdded: number;
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

export const logSummary = (summary: SeedSummary): void => {
  const { processedUrls, processedUrlList, recordsAdded, totalEmbeddingTokens, durationMs } = summary;
  const estimatedCost = calculateEmbeddingCost(totalEmbeddingTokens);
  const formattedDuration = formatDuration(durationMs);

  console.log("\n✅ Seed complete");
  console.log(`⏱️  Time taken: ${formattedDuration}`);
  console.log(`📄 Parsed URLs: ${processedUrls}`);
  console.log(`💾 Records added: ${recordsAdded}`);
  console.log(`🔤 Embedding tokens used: ${totalEmbeddingTokens.toLocaleString()}`);
  console.log(`💰 Estimated embedding cost: $${estimatedCost.toFixed(4)}`);
  console.log("\n📋 Parsed URL list:");
  for (const url of processedUrlList) {
    console.log(`   - ${url}`);
  }
};

export const writeSummaryLog = async (summary: SeedSummary): Promise<void> => {
  const { processedUrls, processedUrlList, recordsAdded, totalEmbeddingTokens, durationMs } = summary;
  const estimatedCost = calculateEmbeddingCost(totalEmbeddingTokens);
  const formattedDuration = formatDuration(durationMs);

  const dateStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logLines = [
    "✅ Seed complete",
    `⏱️  Time taken: ${formattedDuration}`,
    `📄 Parsed URLs: ${processedUrls}`,
    `💾 Records added: ${recordsAdded}`,
    `🔤 Embedding tokens used: ${totalEmbeddingTokens.toLocaleString()}`,
    `💰 Estimated embedding cost: $${estimatedCost.toFixed(4)}`,
    "",
    "📋 Parsed URL list:",
    ...processedUrlList.map((url) => `   - ${url}`),
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
