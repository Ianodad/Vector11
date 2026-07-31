//app/scripts/loadDb.ts
import "dotenv/config";

// Config
import { loadEnvConfig, resolveMaxUrls, isEnabled } from "./lib/config/env.js";
import { initializeClients } from "./lib/config/clients.js";
import { buildFootballDataList } from "./lib/config/dataSources.js";

// Database
import { createCollection, waitForDbReady } from "./lib/database/collection.js";
import { batchInsertParents, batchInsertChildren } from "./lib/database/operations.js";

// Embeddings
import { generateEmbeddings } from "./lib/embeddings/generator.js";

// Scrapers
import {
  scrapPage,
  scrapeSoccerwayFormPage,
  scrapeSoccerwayLineupsPage,
  scrapeUnderstatPage,
  extractHtmlLinks,
  filterBbcTeamLinks,
} from "./lib/scrapers/htmlScraper.js";
import { extractRssLinks } from "./lib/scrapers/rssScraper.js";
import { isLowValueContent } from "./lib/scrapers/contentFilter.js";
import { isStatsSite } from "./lib/scrapers/evaluators/statsEvaluator.js";

// Utils
import { withRetry, sleep } from "./lib/utils/retry.js";
import { createParentChildChunks } from "./lib/utils/chunking.js";
import { extractDocMeta } from "./lib/utils/markdownChunker.js";
import { generatePrompts, type CorpusFacts } from "./lib/utils/promptGenerator.js";
import { logSummary, writeSummaryLog } from "./lib/utils/logging.js";
import { isBbcTeamPage, isBlocked, isLikelyHtml } from "./lib/utils/helpers.js";
import type { SourceItem } from "./lib/config/dataSources.js";

// Suggested-prompts corpus facts capture (season/leagues/champions/scorers).
// Reuses `extractDocMeta` — the same pure header parser the chunker already
// uses for section metadata — plus a small amount of Understat-specific
// markdown parsing (regex over content the scraper already produces). No
// scraper or chunker changes required; see task-weekly-prompts.md.

// Normalizes doc-header league names (e.g. "Premier League") and Understat's
// own display names into the short codes CorpusFacts/generatePrompts expect.
const LEAGUE_DISPLAY_TO_CODE: Record<string, string> = {
  "Premier League": "EPL",
  EPL: "EPL",
  "La Liga": "La Liga",
  "Serie A": "Serie A",
  Bundesliga: "Bundesliga",
  "Ligue 1": "Ligue 1",
  "Champions League": "Champions League",
  "UEFA Champions League": "Champions League",
  AFCON: "AFCON",
};

const normalizeLeagueName = (raw: string): string =>
  LEAGUE_DISPLAY_TO_CODE[raw.trim()] ?? raw.trim();

// Only these two leagues are cheaply and reliably derivable from the
// combined Understat markdown (league-page URL slug -> canonical code).
// Scoped deliberately per the task spec rather than attempting every league.
const UNDERSTAT_FACT_LEAGUES: Record<string, string> = {
  EPL: "EPL",
  La_liga: "La Liga",
};

interface UnderstatSeasonFacts {
  champions: Record<string, string>;
  topScorers: Record<string, { player: string; goals?: number }>;
}

// Returns the text between `heading` (exclusive) and the next "## " heading
// (or end of string) — used to scope a row-position regex to one specific
// table section instead of matching the first "| 1 | ... |" anywhere.
const extractSection = (content: string, heading: string): string => {
  const idx = content.indexOf(heading);
  if (idx === -1) return "";
  const rest = content.slice(idx + heading.length);
  const nextHeadingIdx = rest.search(/\n##\s/);
  return nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
};

// Pulls the cells of the first data row (rank "1") out of a markdown table
// section, e.g. "| 1 | Liverpool | 38 | ... |" -> ["", "1", "Liverpool", ...].
const firstDataRowCells = (section: string): string[] | null => {
  const match = section.match(/\n(\|\s*1\s*\|[^\n]*)/);
  if (!match) return null;
  return match[1].split("|").map((cell) => cell.trim());
};

// Captures the completed-season champion (standings leader, only once the
// fixture list shows zero matches remaining) and the current top scorer from
// a combined Understat league markdown document, for EPL/La Liga only.
const captureUnderstatFacts = (
  content: string,
  url: string,
  bySeason: Map<string, UnderstatSeasonFacts>,
): void => {
  const leagueSlugMatch = url.match(/understat\.com\/league\/([^/?#]+)/);
  const leagueCode = leagueSlugMatch ? UNDERSTAT_FACT_LEAGUES[leagueSlugMatch[1]] : undefined;
  if (!leagueCode) return;

  const seasonMatch = content.match(/\*\*Season:\*\*\s*([^|\n]+)/);
  const season = seasonMatch?.[1]?.trim();
  if (!season) return;

  const bucket = bySeason.get(season) ?? { champions: {}, topScorers: {} };

  const standingsCells = firstDataRowCells(extractSection(content, "## Standings"));
  const remainingMatch = content.match(/\*\*Remaining:\*\*\s*(\d+)/);
  const isCompletedSeason = remainingMatch ? Number(remainingMatch[1]) === 0 : false;
  if (standingsCells?.[2] && isCompletedSeason) {
    bucket.champions[leagueCode] = standingsCells[2];
  }

  const rankingCells = firstDataRowCells(extractSection(content, "## Rankings"));
  if (rankingCells?.[2]) {
    const goals = Number(rankingCells[6]);
    bucket.topScorers[leagueCode] = {
      player: rankingCells[2],
      ...(Number.isFinite(goals) ? { goals } : {}),
    };
  }

  bySeason.set(season, bucket);
};

const pickMostCommon = (counts: Map<string, number>): string | undefined => {
  let best: string | undefined;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
};

/**
 * Filter sources to only those whose URL or source name contains at least one
 * of the comma-separated terms. Case-insensitive. Falsy filter = no filtering.
 * Examples:
 *   filterSourcesByDomain(data, "bbc")            → only BBC sources
 *   filterSourcesByDomain(data, "bbc,understat")  → BBC + Understat sources
 *   filterSourcesByDomain(data, "soccerway")      → only Soccerway sources
 */
const filterSourcesByDomain = (sources: SourceItem[], filter: string | undefined): SourceItem[] => {
  if (!filter) return sources;
  const terms = filter.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return sources;
  return sources.filter(item => {
    const haystack = `${item.url} ${item.source}`.toLowerCase();
    return terms.some(term => haystack.includes(term));
  });
};

const processDataSources = async (
  footballData: SourceItem[],
  config: ReturnType<typeof loadEnvConfig>,
  clients: ReturnType<typeof initializeClients>,
  vectorDimensions: number,
): Promise<{
  processedUrls: number;
  processedUrlList: string[];
  urlChunkStats: Record<string, { parents: number; children: number }>;
  recordsAdded: number;
  parentsAdded: number;
  childrenAdded: number;
  recordsSkipped: number;
  recordsDuplicated: number;
  totalEmbeddingTokens: number;
  skippedUrls: number;
  failedUrls: number;
  attemptedRecords: number;
  seasonCounts: Map<string, number>;
  leaguesSeen: Set<string>;
  understatFactsBySeason: Map<string, UnderstatSeasonFacts>;
}> => {
  const collection = clients.db.collection(config.ASTRA_DB_COLLECTION);
  const queue: SourceItem[] = [...footballData];
  const seenUrls = new Set<string>();
  const maxUrls = resolveMaxUrls(config.MAX_SCRAPE_URLS);
  let processedUrls = 0;
  let recordsAdded = 0;
  let parentsAdded = 0;
  let childrenAdded = 0;
  let recordsSkipped = 0;
  let recordsDuplicated = 0;
  let totalEmbeddingTokens = 0;
  const urlChunkStats: Record<string, { parents: number; children: number }> = {};
  const processedUrlList: string[] = [];
  let skippedUrls = 0;
  let failedUrls = 0;
  // Suggested-prompts corpus facts, harvested alongside the existing
  // scrape/chunk loop below (see capture block after the low-value-content
  // check) — used to regenerate the UI's suggested prompts once the seed
  // succeeds. See top-of-file comment for how these are derived.
  const seasonCounts = new Map<string, number>();
  const leaguesSeen = new Set<string>();
  const understatFactsBySeason = new Map<string, UnderstatSeasonFacts>();
  // Sum of parent+child chunks attempted for insertion (whether or not the
  // insert ultimately succeeded) — used as the basis for the end-of-run
  // sanity assertion against recordsAdded (see BLOCKER 5 mitigation).
  let attemptedRecords = 0;

  for (let i = 0; i < queue.length; i += 1) {
    const { url, type, source, delay = 2, category = "unknown", formMode, formMatches } = queue[i];
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
      () => {
        if (type === "understat") {
          return scrapeUnderstatPage(url);
        }
        if (type === "soccerway_form") {
          return scrapeSoccerwayFormPage(url, {
            formMode: formMode ?? "home",
            formMatches: formMatches ?? 5,
          });
        }
        if (type === "soccerway_lineups") {
          return scrapeSoccerwayLineupsPage(url);
        }
        return scrapPage(url, type);
      },
      config.RETRY_ATTEMPTS,
      config.RETRY_BASE_DELAY_MS,
    );

    // After scraping a Soccerway results page, optionally queue reportUrl and
    // lineupsUrl discovered in the plain-text records so they are also embedded.
    // Enable with: SCRAPE_MATCH_DETAILS=1
    if (
      isEnabled(config.SCRAPE_MATCH_DETAILS) &&
      url.includes("soccerway.com") &&
      url.includes("/results/") &&
      content
    ) {
      for (const line of content.split("\n")) {
        const reportMatch = line.match(/^reportUrl:\s*(https:\/\/[^\s]+)/);
        const lineupsMatch = line.match(/^lineupsUrl:\s*(https:\/\/[^\s]+)/);
        const discovered = reportMatch?.[1] ?? lineupsMatch?.[1];
        const discoveredType = reportMatch ? "html" : "soccerway_lineups";
        if (discovered && !seenUrls.has(discovered)) {
          seenUrls.add(discovered);
          queue.push({
            url: discovered,
            type: discoveredType,
            source: `${source} ${reportMatch ? "Report" : "Lineups"}`,
            delay: 5,
            category,
          });
        }
      }
    }

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

    // Suggested-prompts corpus facts capture — read-only metadata harvesting
    // from content that is actually about to be chunked into the corpus (so
    // facts reflect what got seeded, not what was skipped above). Reuses the
    // same `extractDocMeta` header parser the chunker uses for its own
    // section metadata; Understat pages are additionally regex-parsed for
    // the completed-season champion + top scorer (see captureUnderstatFacts).
    const docMeta = extractDocMeta(content);
    if (docMeta.season) {
      seasonCounts.set(docMeta.season, (seasonCounts.get(docMeta.season) ?? 0) + 1);
    }
    if (docMeta.league) {
      leaguesSeen.add(normalizeLeagueName(docMeta.league));
    }
    if (type === "understat") {
      captureUnderstatFacts(content, url, understatFactsBySeason);
    }

    // Parent-child chunking
    const chunkSizes = isStats
      ? {
          parentMaxSize: config.STATS_CHUNK_SIZE,
          parentOverlap: config.STATS_CHUNK_OVERLAP,
          childMaxSize: config.STATS_CHILD_CHUNK_SIZE,
          childOverlap: config.STATS_CHILD_CHUNK_OVERLAP,
        }
      : {
          parentMaxSize: config.DEFAULT_CHUNK_SIZE,
          parentOverlap: config.DEFAULT_CHUNK_OVERLAP,
          childMaxSize: config.CHILD_CHUNK_SIZE,
          childOverlap: config.CHILD_CHUNK_OVERLAP,
        };

    const chunkingResult = await createParentChildChunks(
      content,
      chunkSizes,
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
    console.log(
      `  Chunking ${url} -> parents=${parentDocs.length} children=${childTexts.length} meta=${childMeta.length}`,
    );
    attemptedRecords += parentDocs.length + childTexts.length;

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
      parentsAdded += parentResult.recordsAdded;
      recordsSkipped += parentResult.recordsSkipped;
      recordsDuplicated += parentResult.recordsDuplicated;

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
      childrenAdded += childResult.recordsAdded;
      recordsSkipped += childResult.recordsSkipped;
      recordsDuplicated += childResult.recordsDuplicated;

      // Track per-URL chunk counts for the summary
      urlChunkStats[url] = {
        parents: parentResult.recordsAdded,
        children: childResult.recordsAdded,
      };

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

  return {
    processedUrls,
    processedUrlList,
    urlChunkStats,
    recordsAdded,
    parentsAdded,
    childrenAdded,
    recordsSkipped,
    recordsDuplicated,
    totalEmbeddingTokens,
    skippedUrls,
    failedUrls,
    attemptedRecords,
    seasonCounts,
    leaguesSeen,
    understatFactsBySeason,
  };
};

const seed = async () => {
  const startedAt = Date.now();
  const showEnv = (value: string | undefined): string =>
    value === undefined ? "undefined" : value === "" ? "(empty)" : value;
  console.log("\n⚽ MAXIMIZED Football Data Scraper");
  console.log("✅ Removed: WhoScored, Medium, UEFA.com, Goal.com");
  console.log("✅ Expanded: Understat (10 leagues), Wikipedia (18 pages)");
  console.log("✅ Optimized: All delays properly configured\n");

  // Load configuration
  const config = loadEnvConfig();
  const clients = initializeClients(config);
  const allFootballData = buildFootballDataList(
    config.EPL_TEAMS_ENABLED,
    config.EPL_TEAM_PAGES,
    config.EPL_TEAM_SLUGS,
  );

  // Support --source=<filter> CLI arg (overrides SOURCE_FILTER env var)
  const sourceArgMatch = process.argv.find(a => a.startsWith('--source='));
  const sourceFilter   = sourceArgMatch ? sourceArgMatch.split('=').slice(1).join('=') : config.SOURCE_FILTER;
  const footballData   = filterSourcesByDomain(allFootballData, sourceFilter);

  console.log("📊 Configuration:");
  console.log(`- Total sources: ${allFootballData.length}${sourceFilter ? ` (filtered to ${footballData.length} matching "${sourceFilter}")` : ''}`);
  console.log(
    `- BBC Team Pages: ${config.EPL_TEAMS_ENABLED ? "✅ Enabled" : "❌ Disabled"}`,
  );
  console.log(`- Max URLs: ${config.MAX_SCRAPE_URLS || "Unlimited"}\n`);
  console.log("🧩 Env settings in use:");
  console.log("  Raw process.env values:");
  console.log(`  - EMBEDDING_DIMENSIONS: ${showEnv(process.env.EMBEDDING_DIMENSIONS)}`);
  console.log(`  - MAX_SCRAPE_URLS: ${showEnv(process.env.MAX_SCRAPE_URLS)}`);
  console.log(`  - EPL_TEAM_PAGES: ${showEnv(process.env.EPL_TEAM_PAGES)}`);
  console.log(`  - EPL_TEAM_SLUGS: ${showEnv(process.env.EPL_TEAM_SLUGS)}`);
  console.log(`  - EPL_TEAMS_ENABLED: ${showEnv(process.env.EPL_TEAMS_ENABLED)}`);
  console.log(`- EMBEDDING_DIMENSIONS: ${config.DEFAULT_VECTOR_DIMENSIONS}`);
  console.log(`- MAX_SCRAPE_URLS: ${config.MAX_SCRAPE_URLS || "Unlimited"}`);
  console.log(`- EPL_TEAM_PAGES: ${config.EPL_TEAM_PAGES || "default"}`);
  console.log(`- EPL_TEAM_SLUGS: ${config.EPL_TEAM_SLUGS || "all/default"}`);
  console.log(
    `- EPL_TEAMS_ENABLED: ${config.EPL_TEAMS_ENABLED || "false (default)"}`,
  );
  if (sourceFilter) {
    console.log(`- SOURCE_FILTER: "${sourceFilter}" → ${footballData.length}/${allFootballData.length} sources selected`);
  }
  console.log("- Chunk config:");
  console.log(
    `  - DEFAULT_CHUNK_SIZE/OVERLAP: ${config.DEFAULT_CHUNK_SIZE}/${config.DEFAULT_CHUNK_OVERLAP}`,
  );
  console.log(
    `  - CHILD_CHUNK_SIZE/OVERLAP: ${config.CHILD_CHUNK_SIZE}/${config.CHILD_CHUNK_OVERLAP}`,
  );
  console.log(
    `  - STATS_CHUNK_SIZE/OVERLAP: ${config.STATS_CHUNK_SIZE}/${config.STATS_CHUNK_OVERLAP}`,
  );
  console.log(
    `  - STATS_CHILD_CHUNK_SIZE/OVERLAP: ${config.STATS_CHILD_CHUNK_SIZE}/${config.STATS_CHILD_CHUNK_OVERLAP}\n`,
  );

  // Wait for the (possibly hibernating) serverless DB to resume before any
  // writes — otherwise a cold DB fails the whole seed in ~45s. See waitForDbReady.
  console.log("⏳ Waiting for Astra DB to be ready...");
  await waitForDbReady(clients.db);
  console.log("✅ Astra DB ready\n");

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
  const {
    processedUrls,
    processedUrlList,
    urlChunkStats,
    recordsAdded,
    parentsAdded,
    childrenAdded,
    recordsSkipped,
    recordsDuplicated,
    totalEmbeddingTokens,
    skippedUrls,
    failedUrls,
    attemptedRecords,
    seasonCounts,
    leaguesSeen,
    understatFactsBySeason,
  } = await processDataSources(footballData, config, clients, vectorDimensions);

  const durationMs = Date.now() - startedAt;

  // A silent partial seed must be impossible: any document Astra rejected for
  // exceeding its 8,000-byte indexed field limit was logged per-document above
  // and is summed here as one unmissable end-of-run total.
  console.log(`\nSkipped ${recordsSkipped} oversized documents`);
  console.log(`Duplicated ${recordsDuplicated} documents (same content-hash _id, tolerated by design)`);
  console.log(`Skipped URLs: ${skippedUrls} | Failed URLs: ${failedUrls}`);

  // The in-place, non-atomic rebuild (no transactional guarantee across the
  // whole run) means a failed URL or a partial insert can otherwise slip by
  // silently. These are cheap safety rails, not a redesign: surface failures
  // loudly and fail CI instead of reporting a quiet success.
  if (failedUrls > 0) {
    console.warn(
      `\n⚠️  ${failedUrls} URL(s) failed to process — seed completed but is INCOMPLETE. Check logs above for per-URL errors.`,
    );
    process.exitCode = 1;
  }

  const expectedRecordsAdded = attemptedRecords - recordsSkipped - recordsDuplicated;
  if (recordsAdded !== expectedRecordsAdded) {
    console.warn(
      `\n⚠️  Record count mismatch: recordsAdded=${recordsAdded} but expected ${expectedRecordsAdded} ` +
        `(attempted=${attemptedRecords} - oversizedSkipped=${recordsSkipped} - duplicated=${recordsDuplicated}). This indicates a silent partial insert.`,
    );
    process.exitCode = 1;
  }

  // Log summary
  logSummary({
    processedUrls,
    processedUrlList,
    urlChunkStats,
    recordsAdded,
    parentsAdded,
    childrenAdded,
    totalEmbeddingTokens,
    durationMs,
  });

  // Write summary log file
  await writeSummaryLog({
    processedUrls,
    processedUrlList,
    urlChunkStats,
    recordsAdded,
    parentsAdded,
    childrenAdded,
    totalEmbeddingTokens,
    durationMs,
  });

  // Regenerate the UI's suggested prompts from what THIS seed actually put in
  // the corpus (season + leagues present, plus a few concrete facts when
  // cheaply available — see capture block in processDataSources). Runs on the
  // success path, after the summary/count assertions above, so it can never
  // affect those counters. Wrapped so a failure here can only WARN — this is
  // cosmetic (suggested prompts), never worth failing an otherwise-successful
  // seed over, so process.exitCode is deliberately left untouched below.
  //
  // Retrieval safety: this doc is `type: "meta"`, not `type: "child"`. Chat
  // retrieval (app/api/chat/route.ts) only ever queries `type: "child"` (plus
  // parent lookups by `_id`), so a `type: "meta"` doc is invisible to it.
  // It also carries no `$vector`/`$lexical` fields, which Astra collections
  // accept fine for a plain (non-searched) document.
  try {
    const season = pickMostCommon(seasonCounts);
    if (!season) {
      console.warn(
        "[prompts] No season captured from corpus metadata — skipping suggested-prompts regeneration",
      );
    } else {
      const leagues = Array.from(leaguesSeen).sort();
      const seasonFacts = understatFactsBySeason.get(season);
      const facts: CorpusFacts = {
        season,
        leagues,
        champions: seasonFacts?.champions,
        topScorers: seasonFacts?.topScorers,
      };
      const prompts = generatePrompts(facts);
      const collection = clients.db.collection(config.ASTRA_DB_COLLECTION);
      await collection.replaceOne(
        { _id: "meta:suggested-prompts" },
        {
          type: "meta",
          season,
          leagues,
          prompts,
          generatedAt: new Date().toISOString(),
        },
        { upsert: true },
      );
      console.log(
        `[prompts] Regenerated ${prompts.length} suggested prompts for season ${season} (${leagues.join(", ") || "no leagues detected"})`,
      );
    }
  } catch (err) {
    console.warn("[prompts] Failed to regenerate suggested prompts (non-fatal):", err);
  }
};

seed()
  .then(() => {
    // seed() sets process.exitCode = 1 (without throwing) when it detects
    // failed URLs or a record-count mismatch — respect that here instead of
    // hardcoding a 0 exit, otherwise those warnings never fail CI.
    const code = process.exitCode ?? 0;
    console.log(
      code === 0
        ? "✅ loadDb completed. Exiting."
        : "⚠️  loadDb completed with warnings (see above). Exiting non-zero.",
    );
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
