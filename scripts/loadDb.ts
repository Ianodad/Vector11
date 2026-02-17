//app/scripts/loadDb.ts
import "dotenv/config";

// Config
import { loadEnvConfig, resolveMaxUrls, isEnabled } from "./lib/config/env.js";
import { initializeClients } from "./lib/config/clients.js";
import { buildFootballDataList } from "./lib/config/dataSources.js";
import { initializeSplitters } from "./lib/embeddings/splitters.js";

// Database
import { createCollection } from "./lib/database/collection.js";
import { batchInsertParents, batchInsertChildren } from "./lib/database/operations.js";

// Embeddings
import { generateEmbeddings } from "./lib/embeddings/generator.js";

// Scrapers
import { scrapPage, extractHtmlLinks, filterBbcTeamLinks } from "./lib/scrapers/htmlScraper.js";
import { extractRssLinks } from "./lib/scrapers/rssScraper.js";
import { isLowValueContent } from "./lib/scrapers/contentFilter.js";
import { isStatsSite } from "./lib/scrapers/evaluators/statsEvaluator.js";

// Utils
import { withRetry, sleep } from "./lib/utils/retry.js";
import { createParentChildChunks } from "./lib/utils/chunking.js";
import { logSummary, writeSummaryLog } from "./lib/utils/logging.js";
import { isBbcTeamPage, isBlocked, isLikelyHtml } from "./lib/utils/helpers.js";
import type { SourceItem } from "./lib/config/dataSources.js";

const processDataSources = async (
  footballData: SourceItem[],
  config: ReturnType<typeof loadEnvConfig>,
  clients: ReturnType<typeof initializeClients>,
  splitters: ReturnType<typeof initializeSplitters>,
  vectorDimensions: number,
): Promise<{
  processedUrls: number;
  processedUrlList: string[];
  recordsAdded: number;
  totalEmbeddingTokens: number;
}> => {
  const collection = clients.db.collection(config.ASTRA_DB_COLLECTION);
  const queue: SourceItem[] = [...footballData];
  const seenUrls = new Set<string>();
  const maxUrls = resolveMaxUrls(config.MAX_SCRAPE_URLS);
  let processedUrls = 0;
  let recordsAdded = 0;
  let totalEmbeddingTokens = 0;
  const processedUrlList: string[] = [];
  let skippedUrls = 0;
  let failedUrls = 0;

  for (let i = 0; i < queue.length; i += 1) {
    const { url, type, source, delay = 2, category = "unknown" } = queue[i];
    const baseTotal = queue.length;
    const capLabel = maxUrls !== undefined ? ` cap=${maxUrls}` : "";
    console.log(
      `[${i + 1}/${baseTotal}] Processing ${url} (${type}) delay=${delay}s${capLabel}`,
    );

    if (type === "rss") {
      const links = await withRetry(
        `extractRssLinks:${url}`,
        () => extractRssLinks(url, config.FETCH_TIMEOUT_MS),
        config.RETRY_ATTEMPTS,
        config.RETRY_BASE_DELAY_MS,
      );
      for (const link of links) {
        if (seenUrls.has(link)) continue;
        seenUrls.add(link);
        queue.push({
          url: link,
          type: "html",
          source: `${source} Article`,
          delay: 2,
          category,
        });
      }
      await sleep(delay);
      continue;
    }

    if (maxUrls !== undefined && processedUrls >= maxUrls) break;

    if (isBbcTeamPage(url)) {
      const links = await withRetry(
        `extractHtmlLinks:${url}`,
        () => extractHtmlLinks(url),
        config.RETRY_ATTEMPTS,
        config.RETRY_BASE_DELAY_MS,
      );
      const filtered = filterBbcTeamLinks(url, links);
      for (const link of filtered) {
        if (seenUrls.has(link)) continue;
        seenUrls.add(link);
        queue.push({
          url: link,
          type: "html",
          source: `${source} Article`,
          delay: 2,
          category,
        });
      }
      console.log(
        `Expanded BBC team page ${url} -> ${filtered.length} article links`,
      );
      await sleep(delay);
      continue;
    }

    if (isBlocked(url) || !isLikelyHtml(url)) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (blocked or non-html)`);
      continue;
    }

    const content = await withRetry(
      `scrapPage:${url}`,
      () => scrapPage(url, type),
      config.RETRY_ATTEMPTS,
      config.RETRY_BASE_DELAY_MS,
    );

    // Debug logging for stats sites
    const isStats = isStatsSite(url);
    if (isStats && content) {
      const previewLen = 600;
      console.log(`📊 Stats site content length: ${content.length} chars`);
      console.log(
        `📊 First ${previewLen} chars: ${content.substring(0, previewLen)}`,
      );
    }

    if (!content || content.trim().length < 200) {
      skippedUrls += 1;
      if (isStats) {
        console.log(
          `⚠️  Stats site skipped - content too short (${content?.length || 0} chars)`,
        );
      }
      console.log(`Skipped ${url} (empty/short)`);
      await sleep(delay);
      continue;
    }
    if (isLowValueContent(content)) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (low value content)`);
      await sleep(delay);
      continue;
    }

    // Parent-child chunking
    const parentSplitter = isStats ? splitters.statsSplitter : splitters.defaultSplitter;
    const childSplitter = isStats ? splitters.statsChildSplitter : splitters.defaultChildSplitter;

    const chunkingResult = await createParentChildChunks(
      content,
      parentSplitter,
      childSplitter,
      source,
      url,
      category,
      isLowValueContent,
    );

    if (!chunkingResult) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (no valid chunks after filtering)`);
      await sleep(delay);
      continue;
    }

    const { parentDocs, childTexts, childMeta } = chunkingResult;

    try {
      // Generate embeddings
      const { vectors: allVectors, totalTokens } = await generateEmbeddings(
        clients.openai,
        childTexts,
        source,
        url,
        vectorDimensions,
        config.RETRY_ATTEMPTS,
        config.RETRY_BASE_DELAY_MS,
      );
      totalEmbeddingTokens += totalTokens;

      // Insert parent docs
      const parentResult = await batchInsertParents(collection, parentDocs);
      recordsAdded += parentResult.recordsAdded;

      // Insert child docs
      const scrapedAt = new Date().toISOString();
      const childResult = await batchInsertChildren(
        collection,
        childTexts,
        childMeta,
        allVectors,
        source,
        url,
        category,
        scrapedAt,
      );
      recordsAdded += childResult.recordsAdded;

      console.log(
        `  Inserted ${parentDocs.length} parents + ${childTexts.length} children for ${url}`,
      );
    } catch (err) {
      failedUrls += 1;
      console.warn(`Failed to process ${url}:`, err);
      await sleep(delay);
      continue;
    }

    processedUrls += 1;
    processedUrlList.push(url);
    console.log(
      `Completed ${url} | processed=${processedUrls} skipped=${skippedUrls} failed=${failedUrls} records=${recordsAdded}`,
    );

    await sleep(delay);
  }

  return { processedUrls, processedUrlList, recordsAdded, totalEmbeddingTokens };
};

const seed = async () => {
  const startedAt = Date.now();
  console.log("\n⚽ MAXIMIZED Football Data Scraper");
  console.log("✅ Removed: WhoScored, Medium, UEFA.com, Goal.com");
  console.log("✅ Expanded: Understat (10 leagues), Wikipedia (18 pages)");
  console.log("✅ Optimized: All delays properly configured\n");

  // Load configuration
  const config = loadEnvConfig();
  const clients = initializeClients(config);
  const splitters = initializeSplitters(config);
  const footballData = buildFootballDataList(
    config.EPL_TEAMS_ENABLED,
    config.EPL_TEAM_PAGES,
    config.EPL_TEAM_SLUGS,
  );

  console.log("📊 Configuration:");
  console.log(`- Total sources: ${footballData.length}`);
  console.log(
    `- BBC Team Pages: ${config.EPL_TEAMS_ENABLED ? "✅ Enabled" : "❌ Disabled"}`,
  );
  console.log(`- Max URLs: ${config.MAX_SCRAPE_URLS || "Unlimited"}\n`);

  // Create collection
  const forceRecreate = isEnabled(config.FORCE_COLLECTION_RECREATE);
  const vectorDimensions = await createCollection(
    clients.db,
    config.ASTRA_DB_COLLECTION,
    "dot_product",
    config.DEFAULT_VECTOR_DIMENSIONS,
    config.ALLOW_COLLECTION_RECREATE,
    forceRecreate,
  );

  // Process data sources
  const { processedUrls, processedUrlList, recordsAdded, totalEmbeddingTokens } =
    await processDataSources(footballData, config, clients, splitters, vectorDimensions);

  const durationMs = Date.now() - startedAt;

  // Log summary
  logSummary({
    processedUrls,
    processedUrlList,
    recordsAdded,
    totalEmbeddingTokens,
    durationMs,
  });

  // Write summary log file
  await writeSummaryLog({
    processedUrls,
    processedUrlList,
    recordsAdded,
    totalEmbeddingTokens,
    durationMs,
  });
};

seed().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
