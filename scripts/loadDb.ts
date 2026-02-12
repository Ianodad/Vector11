//app/scripts/loadDb.ts
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { DataAPIClient, DataAPIResponseError } from "@datastax/astra-db-ts";
import { PuppeteerWebBaseLoader } from "@langchain/community/document_loaders/web/puppeteer";
import OpenAI from "openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { XMLParser } from "fast-xml-parser";

import "dotenv/config";

type SourceType = "html" | "rss";
type SimilarityMetric = "cosine" | "euclidean" | "dot_product";

interface RssItem {
  title?: string;
  description?: string;
  summary?: string;
  link?: string | { "@_href"?: string };
}

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
const DEFAULT_VECTOR_DIMENSIONS =
  Number(process.env.EMBEDDING_DIMENSIONS) || 1000;
const ALLOW_COLLECTION_RECREATE = process.env.ALLOW_COLLECTION_RECREATE;
const MAX_SCRAPE_URLS = process.env.MAX_SCRAPE_URLS;
const EPL_TEAM_PAGES = process.env.EPL_TEAM_PAGES;
const EPL_TEAM_SLUGS = process.env.EPL_TEAM_SLUGS;
const EPL_TEAMS_ENABLED = process.env.EPL_TEAMS_ENABLED;
const STATS_CHUNK_SIZE = Number(process.env.STATS_CHUNK_SIZE) || 1500;
const STATS_CHUNK_OVERLAP = Number(process.env.STATS_CHUNK_OVERLAP) || 200;
const DEFAULT_CHUNK_SIZE = Number(process.env.DEFAULT_CHUNK_SIZE) || 800;
const DEFAULT_CHUNK_OVERLAP = Number(process.env.DEFAULT_CHUNK_OVERLAP) || 150;
const CHILD_CHUNK_SIZE = Number(process.env.CHILD_CHUNK_SIZE) || 400;
const CHILD_CHUNK_OVERLAP = Number(process.env.CHILD_CHUNK_OVERLAP) || 50;
const STATS_CHILD_CHUNK_SIZE = Number(process.env.STATS_CHILD_CHUNK_SIZE) || 400;
const STATS_CHILD_CHUNK_OVERLAP = Number(process.env.STATS_CHILD_CHUNK_OVERLAP) || 50;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 15000;
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS) || 3;
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS) || 1000;

const BLOCK_PATTERNS = [
  "/video",
  "/videos",
  "/live",
  "/liveblog",
  "/podcast",
  "/shop",
  "/store",
  "/tickets",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
  "/login",
  "/signin",
  "/signup",
  "/account",
  "/ads",
  "/subscribe",
  "/newsletter",
  "/rss",
  "/feed",
  "/search",
  "/photo",
  "/gallery",
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".zip",
  ".mp4",
  ".mp3",
];

const KEYWORDS = [
  "football",
  "soccer",
  "premier",
  "afcon",
  "fifa",
  "uefa",
  "champions",
  "goal",
  "transfer",
  "match",
  "fixture",
  "stats",
  "player",
];

const BOILERPLATE_PATTERNS = [
  "skip to content",
  "sign up",
  "sign in",
  "log in",
  "login",
  "register",
  "create account",
  "subscribe",
  "subscription",
  "unlock",
  "premium",
  "paywall",
  "trial",
  "try for",
  "buy now",
  "get access",
  "continue reading",
  "advertisement",
  "ad blocker",
  "sponsored",
  "promotion",
  "promoted",
  "notification",
  "push notification",
  "download the app",
  "get the app",
  "open in app",
  "cookie",
  "consent",
  "manage preferences",
  "privacy policy",
  "privacy",
  "terms",
  "terms of use",
  "all rights reserved",
  "copyright",
  "contact us",
  "about us",
  "help",
  "support",
  "language",
  "region",
  "edition",
  "select edition",
  "choose region",
  "back to top",
  "share",
  "print",
  "follow",
  "related topics",
  "related articles",
  "you might also like",
  "read more",
  "see more",
  "load more",
  "show more",
  "loading",
  "please wait",
  "no results",
  "not found",
  "oops",
  "we're having trouble",
  "temporarily unavailable",
  "live",
  "update",
  "match centre",
  "match center",
  "ft",
  "ht",
  "newsletter",
  "page not found",
  "sorry",
  "home",
];

const BBC_TEAM_PATH = "bbc.com/sport/football/teams/";

const resolveMaxUrls = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return undefined;
  const parsed = Number(normalized);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

const resolveTeamPageCount = (value: string | undefined): number => {
  if (!value) return 1;
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return 10;
  const parsed = Number(normalized);
  if (Number.isNaN(parsed) || parsed <= 0) return 1;
  return Math.min(Math.floor(parsed), 10);
};

const resolveTeamSlugs = (value: string | undefined): string[] => {
  if (!value) return [];
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "all") return [];
  return normalized
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const openai = new OpenAI({ apiKey: OPEN_API_KEY });

type SourceItem = {
  url: string;
  type: SourceType;
  source: string;
  delay?: number; // Delay in seconds - CRITICAL for rate limiting
  category?: string;
};

// Updated to 2024-25 Premier League teams
const EPL_TEAM_SLUGS_ALL = [
  "arsenal",
  "aston-villa",
  "bournemouth",
  "brentford",
  "brighton-and-hove-albion",
  "chelsea",
  "crystal-palace",
  "everton",
  "fulham",
  "ipswich-town",
  "leicester-city",
  "liverpool",
  "manchester-city",
  "manchester-united",
  "newcastle-united",
  "nottingham-forest",
  "southampton",
  "tottenham-hotspur",
  "west-ham-united",
  "wolverhampton-wanderers",
];

const buildEplTeamPages = (): SourceItem[] => {
  if (!isEnabled(EPL_TEAMS_ENABLED)) return [];
  const pageCount = resolveTeamPageCount(EPL_TEAM_PAGES);
  const requestedSlugs = resolveTeamSlugs(EPL_TEAM_SLUGS);
  const slugs = requestedSlugs.length > 0 ? requestedSlugs : EPL_TEAM_SLUGS_ALL;

  const items: SourceItem[] = [];
  for (const slug of slugs) {
    for (let page = 1; page <= pageCount; page += 1) {
      items.push({
        url: `https://www.bbc.com/sport/football/teams/${slug}?page=${page}`,
        type: "html",
        source: `BBC Team ${slug.replace(/-/g, " ")} (page ${page})`,
        delay: 30, // CRITICAL: BBC requires 30-60s delay for team pages
      });
    }
  }
  return items;
};

const isEnabled = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
};

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const withRetry = async <T>(
  operationName: string,
  fn: () => Promise<T>,
  attempts = RETRY_ATTEMPTS,
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[retry] ${operationName} failed (attempt ${attempt}/${attempts}): ${getErrorMessage(error)}. Retrying in ${delayMs}ms`,
      );
      await sleepMs(delayMs);
    }
  }

  throw lastError;
};

// MAXIMIZED & OPTIMIZED DATA SOURCES
// Based on research - removed: WhoScored, Medium, UEFA.com, Goal.com
// Added: More Understat leagues, more Wikipedia pages, better coverage
const footballDataGroups: Record<
  | "news"
  | "stats"
  | "playerPerformance"
  | "fixtures"
  | "analysis"
  | "fifa"
  | "afcon"
  | "teams"
  | "reference"
  | "rss",
  SourceItem[]
> = {
  // ============================================
  // NEWS - Easy to scrape, reliable
  // ============================================
  news: [
    // BBC Sport - BEST OPTION (no Cloudflare, simple HTML)
    {
      url: "https://www.bbc.com/sport/football",
      type: "html",
      source: "BBC Sport",
      delay: 2,
    },
    {
      url: "https://www.bbc.com/sport/football/premier-league",
      type: "html",
      source: "BBC EPL",
      delay: 2,
    },
    {
      url: "https://www.bbc.com/sport/football/africa",
      type: "html",
      source: "BBC Africa",
      delay: 2,
    },
    {
      url: "https://www.bbc.com/sport/football/champions-league",
      type: "html",
      source: "BBC Champions League",
      delay: 2,
    },
    {
      url: "https://www.bbc.com/sport/football/womens-super-league",
      type: "html",
      source: "BBC Women's Football",
      delay: 2,
    },
    // ESPN - Clean HTML structure
    {
      url: "https://www.espn.com/soccer/",
      type: "html",
      source: "ESPN Soccer",
      delay: 2,
    },
    {
      url: "https://www.espn.com/soccer/league/_/name/eng.1",
      type: "html",
      source: "ESPN EPL",
      delay: 2,
    },
    {
      url: "https://www.espn.com/soccer/africa/",
      type: "html",
      source: "ESPN Africa",
      delay: 2,
    },
    {
      url: "https://www.espn.com/soccer/scoreboard",
      type: "html",
      source: "ESPN Scoreboard",
      delay: 2,
    },
    // The Guardian - Reliable HTML
    {
      url: "https://www.theguardian.com/football",
      type: "html",
      source: "The Guardian Football",
      delay: 2,
    },
    {
      url: "https://www.theguardian.com/football/premierleague",
      type: "html",
      source: "The Guardian EPL",
      delay: 2,
    },
    {
      url: "https://www.theguardian.com/football/championsleague",
      type: "html",
      source: "The Guardian UCL",
      delay: 2,
    },
  ],

  // ============================================
  // STATS - Expanded Understat coverage
  // ============================================
  stats: [
    // Understat - BEST STATS SOURCE (JSON in script tags)
    {
      url: "https://understat.com/league/EPL",
      type: "html",
      source: "Understat EPL",
      delay: 2,
    },
    {
      url: "https://understat.com/league/EPL/2024",
      type: "html",
      source: "Understat EPL 2024",
      delay: 2,
    },
    {
      url: "https://understat.com/league/EPL/2025",
      type: "html",
      source: "Understat EPL 2025",
      delay: 2,
    },
    {
      url: "https://understat.com/league/La_liga",
      type: "html",
      source: "Understat La Liga",
      delay: 2,
    },
    {
      url: "https://understat.com/league/La_liga/2024",
      type: "html",
      source: "Understat La Liga 2024",
      delay: 2,
    },
    {
      url: "https://understat.com/league/La_liga/2025",
      type: "html",
      source: "Understat La Liga 2025",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Serie_A",
      type: "html",
      source: "Understat Serie A",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Serie_A/2024",
      type: "html",
      source: "Understat Serie A 2024",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Serie_A/2025",
      type: "html",
      source: "Understat Serie A 2025",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Bundesliga",
      type: "html",
      source: "Understat Bundesliga",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Bundesliga/2024",
      type: "html",
      source: "Understat Bundesliga 2024",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Bundesliga/2025",
      type: "html",
      source: "Understat Bundesliga 2025",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Ligue_1",
      type: "html",
      source: "Understat Ligue 1",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Ligue_1/2024",
      type: "html",
      source: "Understat Ligue 1 2024",
      delay: 2,
    },
    {
      url: "https://understat.com/league/Ligue_1/2025",
      type: "html",
      source: "Understat Ligue 1 2025",
      delay: 2,
    },
    // SoccerStats - Static HTML tables
    {
      url: "https://www.soccerstats.com/latest.asp",
      type: "html",
      source: "SoccerStats",
      delay: 3,
    },
    {
      url: "https://www.soccerstats.com/league.asp?league=england",
      type: "html",
      source: "SoccerStats EPL",
      delay: 3,
    },
    {
      url: "https://www.soccerstats.com/homeaway.asp?league=england",
      type: "html",
      source: "SoccerStats Home/Away",
      delay: 3,
    },
    // FootyStats - Accessible
    {
      url: "https://footystats.org/england/premier-league",
      type: "html",
      source: "FootyStats EPL",
      delay: 3,
    },
    {
      url: "https://footystats.org/england/premier-league/results",
      type: "html",
      source: "FootyStats Results",
      delay: 3,
    },
    // FBref - CRITICAL 6 SECOND DELAY
    {
      url: "https://fbref.com/en/comps/9/Premier-League-Stats",
      type: "html",
      source: "FBref EPL",
      delay: 6, // DO NOT REDUCE - will ban you
    },
    {
      url: "https://fbref.com/en/comps/9/schedule/Premier-League-Scores-and-Fixtures",
      type: "html",
      source: "FBref EPL Fixtures",
      delay: 6,
    },
    {
      url: "https://fbref.com/en/comps/9/stats/Premier-League-Stats",
      type: "html",
      source: "FBref EPL Team Stats",
      delay: 6,
    },
  ],

  // ============================================
  // PLAYER PERFORMANCE
  // ============================================
  playerPerformance: [
    {
      url: "https://fbref.com/en/comps/9/stats/Premier-League-Player-Stats",
      type: "html",
      source: "FBref Player Stats EPL",
      delay: 6,
    },
    {
      url: "https://fbref.com/en/comps/9/shooting/Premier-League-Stats",
      type: "html",
      source: "FBref Shooting Stats",
      delay: 6,
    },
    {
      url: "https://fbref.com/en/comps/9/passing/Premier-League-Stats",
      type: "html",
      source: "FBref Passing Stats",
      delay: 6,
    },
  ],

  // ============================================
  // FIXTURES - Very scrapeable
  // ============================================
  fixtures: [
    // Soccerway - 5 second delay per robots.txt
    {
      url: "https://int.soccerway.com/national/england/premier-league/",
      type: "html",
      source: "Soccerway EPL",
      delay: 5,
    },
    {
      url: "https://int.soccerway.com/matches/",
      type: "html",
      source: "Soccerway Matches",
      delay: 5,
    },
    {
      url: "https://int.soccerway.com/international/africa/africa-cup-of-nations/",
      type: "html",
      source: "Soccerway AFCON",
      delay: 5,
    },
    // WorldFootball.net - VERY accessible
    {
      url: "https://www.worldfootball.net/all_matches/eng-premier-league/",
      type: "html",
      source: "WorldFootball EPL Matches",
      delay: 2,
    },
    {
      url: "https://www.worldfootball.net/schedule/eng-premier-league/",
      type: "html",
      source: "WorldFootball EPL Schedule",
      delay: 2,
    },
    {
      url: "https://www.worldfootball.net/schedule/afr-africa-cup-of-nations/",
      type: "html",
      source: "WorldFootball AFCON",
      delay: 2,
    },
  ],

  // ============================================
  // ANALYSIS - Removed Medium, kept safe sites
  // ============================================
  analysis: [
    {
      url: "https://totalfootballanalysis.com/",
      type: "html",
      source: "Total Football Analysis",
      delay: 2,
    },
    {
      url: "https://totalfootballanalysis.com/category/premier-league",
      type: "html",
      source: "TFA Premier League",
      delay: 2,
    },
    {
      url: "https://www.football365.com/",
      type: "html",
      source: "Football365",
      delay: 3,
    },
    {
      url: "https://www.football365.com/premier-league",
      type: "html",
      source: "Football365 EPL",
      delay: 3,
    },
    {
      url: "https://www.planetfootball.com/",
      type: "html",
      source: "Planet Football",
      delay: 3,
    },
  ],

  // ============================================
  // FIFA - Limited coverage
  // ============================================
  fifa: [
    {
      url: "https://www.fifa.com/fifaplus/en/tournaments/mens/worldcup",
      type: "html",
      source: "FIFA World Cup",
      delay: 3,
    },
  ],

  // ============================================
  // AFCON - Expanded coverage
  // ============================================
  afcon: [
    {
      url: "https://www.bbc.com/sport/football/africa-cup-of-nations",
      type: "html",
      source: "BBC AFCON",
      delay: 2,
    },
    {
      url: "https://www.bbc.com/sport/football/africa",
      type: "html",
      source: "BBC Africa",
      delay: 2,
    },
    {
      url: "https://www.cafonline.com/",
      type: "html",
      source: "CAF Online",
      delay: 4,
    },
  ],

  // ============================================
  // TEAMS - BBC dynamic pages (optional)
  // ============================================
  teams: buildEplTeamPages(),

  // ============================================
  // REFERENCE - Expanded Wikipedia coverage
  // ============================================
  reference: [
    // Premier League
    {
      url: "https://en.wikipedia.org/wiki/Premier_League",
      type: "html",
      source: "Wikipedia – Premier League",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/2024%E2%80%9325_Premier_League",
      type: "html",
      source: "Wikipedia – 2024-25 Premier League",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/List_of_Premier_League_clubs",
      type: "html",
      source: "Wikipedia – EPL Clubs",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/List_of_foreign_Premier_League_players",
      type: "html",
      source: "Wikipedia – Foreign EPL players",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/List_of_one-club_men_in_association_football",
      type: "html",
      source: "Wikipedia – One-club men",
      delay: 1,
    },
    // AFCON
    {
      url: "https://en.wikipedia.org/wiki/2025_Africa_Cup_of_Nations",
      type: "html",
      source: "Wikipedia – AFCON 2025",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/Africa_Cup_of_Nations",
      type: "html",
      source: "Wikipedia – Africa Cup of Nations",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/Africa_Cup_of_Nations_records_and_statistics",
      type: "html",
      source: "Wikipedia – AFCON records & stats",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/African_Footballer_of_the_Year",
      type: "html",
      source: "Wikipedia – African Footballer of the Year",
      delay: 1,
    },
    // General Football
    {
      url: "https://en.wikipedia.org/wiki/Association_football",
      type: "html",
      source: "Wikipedia – Association football",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/Football_player",
      type: "html",
      source: "Wikipedia – Football player",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/History_of_association_football",
      type: "html",
      source: "Wikipedia – History of football",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/Football_club_(association_football)",
      type: "html",
      source: "Wikipedia – Football club",
      delay: 1,
    },
    // Other Leagues
    {
      url: "https://en.wikipedia.org/wiki/La_Liga",
      type: "html",
      source: "Wikipedia – La Liga",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/Serie_A",
      type: "html",
      source: "Wikipedia – Serie A",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/Bundesliga",
      type: "html",
      source: "Wikipedia – Bundesliga",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/Ligue_1",
      type: "html",
      source: "Wikipedia – Ligue 1",
      delay: 1,
    },
    {
      url: "https://en.wikipedia.org/wiki/UEFA_Champions_League",
      type: "html",
      source: "Wikipedia – Champions League",
      delay: 1,
    },
  ],

  // ============================================
  // RSS FEEDS - SAFEST OPTION
  // ============================================
  rss: [
    {
      url: "https://feeds.bbci.co.uk/sport/football/rss.xml",
      type: "rss",
      source: "BBC Football RSS",
      delay: 1,
    },
    {
      url: "https://www.theguardian.com/football/rss",
      type: "rss",
      source: "The Guardian Football RSS",
      delay: 1,
    },
    {
      url: "https://www.espn.com/espn/rss/soccer/news",
      type: "rss",
      source: "ESPN Soccer RSS",
      delay: 1,
    },
    {
      url: "https://www.skysports.com/rss/12040",
      type: "rss",
      source: "Sky Sports Football RSS",
      delay: 1,
    },
  ],
};

const footballData: SourceItem[] = Object.entries(footballDataGroups).flatMap(
  ([groupKey, items]) =>
    items.map((item) => ({ ...item, category: item.category ?? groupKey })),
);

const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(ASTRA_DB_API_ENDPOINT, {
  keyspace: ASTRA_DB_NAMESPACE,
});

const statsSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: STATS_CHUNK_SIZE,
  chunkOverlap: STATS_CHUNK_OVERLAP,
});

const defaultSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: DEFAULT_CHUNK_SIZE,
  chunkOverlap: DEFAULT_CHUNK_OVERLAP,
});

const statsChildSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: STATS_CHILD_CHUNK_SIZE,
  chunkOverlap: STATS_CHILD_CHUNK_OVERLAP,
});

const defaultChildSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHILD_CHUNK_SIZE,
  chunkOverlap: CHILD_CHUNK_OVERLAP,
});

const createCollection = async (
  similarityMetric: SimilarityMetric,
): Promise<number> => {
  try {
    const res = await db.createCollection(ASTRA_DB_COLLECTION, {
      vector: {
        dimension: DEFAULT_VECTOR_DIMENSIONS,
        metric: similarityMetric,
      },
    });
    console.log(res);
    return DEFAULT_VECTOR_DIMENSIONS;
  } catch (err) {
    if (
      err instanceof DataAPIResponseError &&
      err.message.includes("Collection already exists")
    ) {
      const existing = await db.collection(ASTRA_DB_COLLECTION).options();
      const existingDimensions = existing.vector?.dimension;
      if (!existingDimensions) {
        throw new Error(
          `Collection '${ASTRA_DB_COLLECTION}' exists but has no vector dimension.`,
        );
      }
      if (existingDimensions !== DEFAULT_VECTOR_DIMENSIONS) {
        if (!isEnabled(ALLOW_COLLECTION_RECREATE)) {
          throw new Error(
            `Collection '${ASTRA_DB_COLLECTION}' dimension mismatch: existing=${existingDimensions}, requested=${DEFAULT_VECTOR_DIMENSIONS}. Set ALLOW_COLLECTION_RECREATE=true to recreate the collection.`,
          );
        }
        console.log(
          `Recreating collection with ${DEFAULT_VECTOR_DIMENSIONS} dimensions (existing was ${existingDimensions})`,
        );
        await db.dropCollection(ASTRA_DB_COLLECTION);
        const res = await db.createCollection(ASTRA_DB_COLLECTION, {
          vector: {
            dimension: DEFAULT_VECTOR_DIMENSIONS,
            metric: similarityMetric,
          },
        });
        console.log(res);
        return DEFAULT_VECTOR_DIMENSIONS;
      }
      console.log(
        `Using existing collection with ${existingDimensions} dimensions`,
      );
      return existingDimensions;
    }
    throw err;
  }
};

const loadSampleData = async (
  vectorDimensions: number,
): Promise<{
  processedUrls: number;
  processedUrlList: string[];
  recordsAdded: number;
  totalEmbeddingTokens: number;
}> => {
  const collection = db.collection(ASTRA_DB_COLLECTION);
  const queue: SourceItem[] = [...footballData];
  const seenUrls = new Set<string>();
  const maxUrls = resolveMaxUrls(MAX_SCRAPE_URLS);
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
      const links = await withRetry(`extractRssLinks:${url}`, () =>
        extractRssLinks(url),
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
      const links = await withRetry(`extractHtmlLinks:${url}`, () =>
        extractHtmlLinks(url),
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
      await sleep(delay); // Respect team page delay
      continue;
    }

    if (isBlocked(url) || !isLikelyHtml(url)) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (blocked or non-html)`);
      continue;
    }

    const content = await withRetry(`scrapPage:${url}`, () =>
      scrapPage(url, type),
    );

    // Debug logging for stats sites
    const isStatsSite =
      url.includes("understat.com") ||
      url.includes("fbref.com") ||
      url.includes("soccerstats.com") ||
      url.includes("footystats.org") ||
      url.includes("soccerway.com") ||
      url.includes("worldfootball.net");

    if (isStatsSite && content) {
      const previewLen = 600;
      console.log(`📊 Stats site content length: ${content.length} chars`);
      console.log(
        `📊 First ${previewLen} chars: ${content.substring(0, previewLen)}`,
      );
    }

    if (!content || content.trim().length < 200) {
      skippedUrls += 1;
      if (isStatsSite) {
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

    // --- Parent-child chunking strategy ---
    // Step 1: Split into parent chunks
    const parentSplitter = isStatsSite ? statsSplitter : defaultSplitter;
    const parentChunks = await parentSplitter.splitText(content);
    const filteredParents = parentChunks.filter(
      (chunk) => chunk.trim().length >= 120 && !isLowValueContent(chunk),
    );

    if (filteredParents.length === 0) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (no valid parent chunks after filtering)`);
      await sleep(delay);
      continue;
    }

    // Step 2: Split each parent into child chunks
    const childSplitter = isStatsSite ? statsChildSplitter : defaultChildSplitter;
    const scrapedAt = new Date().toISOString();

    interface ParentRecord {
      _id: string;
      content: string;
      source: string;
      url: string;
      category: string;
      scrapedAt: string;
      type: "parent";
    }
    interface ChildRecord {
      _id: string;
      content: string;
      parentId: string;
      source: string;
      url: string;
      category: string;
      scrapedAt: string;
      type: "child";
      $vector?: number[];
    }

    const parentDocs: ParentRecord[] = [];
    const childTexts: string[] = [];
    const childMeta: { parentId: string }[] = [];

    for (const parentChunk of filteredParents) {
      const parentId = createHash("md5").update(parentChunk).digest("hex");
      parentDocs.push({
        _id: parentId,
        content: parentChunk,
        source,
        url,
        category,
        scrapedAt,
        type: "parent",
      });

      const children = await childSplitter.splitText(parentChunk);
      const filteredChildren = children.filter(
        (c) => c.trim().length >= 80 && !isLowValueContent(c),
      );
      for (const childChunk of filteredChildren) {
        childTexts.push(childChunk);
        childMeta.push({ parentId });
      }
    }

    if (childTexts.length === 0) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (no valid child chunks after filtering)`);
      await sleep(delay);
      continue;
    }

    try {
      // Step 3: Batch embed ALL child chunks
      const EMBED_BATCH = 100;
      const allVectors: number[][] = [];
      for (let b = 0; b < childTexts.length; b += EMBED_BATCH) {
        const batch = childTexts.slice(b, b + EMBED_BATCH);
        const enriched = batch.map((c) => `[Source: ${source}]\n${c}`);
        const embeddingRes = await withRetry(`embed:${url}:batch:${b}`, () =>
          openai.embeddings.create({
            model: "text-embedding-3-large",
            input: enriched,
            dimensions: vectorDimensions,
            encoding_format: "float",
          }),
        );
        for (const item of embeddingRes.data) {
          allVectors.push(item.embedding);
        }
        const batchTokens = embeddingRes.usage?.total_tokens ?? 0;
        totalEmbeddingTokens += batchTokens;
        console.log(
          `  Embedded child batch ${Math.floor(b / EMBED_BATCH) + 1}/${Math.ceil(childTexts.length / EMBED_BATCH)} (${batch.length} chunks, ${batchTokens} tokens)`,
        );
      }

      // Step 4: Batch insert parent docs (no $vector)
      // No withRetry — duplicate "already exists" errors are expected and handled
      const INSERT_BATCH = 20;
      for (let b = 0; b < parentDocs.length; b += INSERT_BATCH) {
        const batch = parentDocs.slice(b, b + INSERT_BATCH);
        try {
          const res = await collection.insertMany(batch, { ordered: false });
          recordsAdded += res.insertedCount;
        } catch (insertErr: unknown) {
          const msg = insertErr instanceof Error ? insertErr.message : "";
          if (msg.includes("already exists") || msg.includes("duplicate")) {
            const inserted =
              (insertErr as Error & { partialResult?: { insertedCount?: number } })
                .partialResult?.insertedCount ?? 0;
            recordsAdded += inserted;
            console.log(
              `  Parent batch had duplicates, inserted ${inserted} new docs`,
            );
          } else {
            throw insertErr;
          }
        }
      }

      // Step 5: Batch insert child docs (with $vector and parentId)
      for (let b = 0; b < childTexts.length; b += INSERT_BATCH) {
        const batchDocs: ChildRecord[] = childTexts
          .slice(b, b + INSERT_BATCH)
          .map((chunk, idx) => {
            const globalIdx = b + idx;
            const childId = createHash("md5")
              .update(`${childMeta[globalIdx].parentId}|${chunk}`)
              .digest("hex");
            return {
              _id: childId,
              content: chunk,
              parentId: childMeta[globalIdx].parentId,
              source,
              url,
              category,
              scrapedAt,
              type: "child" as const,
              $vector: allVectors[globalIdx],
            };
          });

        try {
          const res = await collection.insertMany(batchDocs, { ordered: false });
          recordsAdded += res.insertedCount;
        } catch (insertErr: unknown) {
          const msg = insertErr instanceof Error ? insertErr.message : "";
          if (msg.includes("already exists") || msg.includes("duplicate")) {
            const inserted =
              (insertErr as Error & { partialResult?: { insertedCount?: number } })
                .partialResult?.insertedCount ?? 0;
            recordsAdded += inserted;
            console.log(
              `  Child batch had duplicates, inserted ${inserted} new docs`,
            );
          } else {
            throw insertErr;
          }
        }
      }
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

    // CRITICAL: Respect delay for this source
    await sleep(delay);
  }

  return { processedUrls, processedUrlList, recordsAdded, totalEmbeddingTokens };
};

const scrapPage = async (url: string, type: SourceType): Promise<string> => {
  if (type === "html") {
    try {
      // Determine if this is a stats site that needs extra time
      const isStatsSite =
        url.includes("understat.com") ||
        url.includes("fbref.com") ||
        url.includes("soccerstats.com") ||
        url.includes("footystats.org") ||
        url.includes("soccerway.com") ||
        url.includes("worldfootball.net");

      const isFootyStats = url.includes("footystats.org");
      const loader = new PuppeteerWebBaseLoader(url, {
        launchOptions: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
          ],
        },
        gotoOptions: {
          waitUntil: isStatsSite ? "networkidle2" : "domcontentloaded",
          timeout: 60000, // Increase timeout to 60 seconds
        },
        evaluate: async (page, browser) => {
          // For stats sites, wait for content to load
          if (isStatsSite) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }

          // For FootyStats calendar pages, grab current/next/previous week fixtures
          if (isFootyStats) {
            const calendarSelector = ".calendar";
            const hasCalendar = await page.$(calendarSelector);
            if (hasCalendar) {
              const getWeekKey = async () =>
                page.evaluate(() => {
                  const cal = document.querySelector(".calendar");
                  if (!cal) return "";
                  const year = cal.getAttribute("data-current-year") || "";
                  const week = cal.getAttribute("data-current-week") || "";
                  return `${year}-${week}`;
                });

              const extractCalendarText = async () =>
                page.evaluate(() => {
                  const cal = document.querySelector(".calendar");
                  if (!cal) return "";
                  const blocks = Array.from(
                    cal.querySelectorAll(".calendar-date-container"),
                  );
                  const parts: string[] = [];
                  for (const block of blocks) {
                    const date =
                      block
                        .querySelector(".calendar-date")
                        ?.textContent?.trim() || "";
                    if (date) parts.push(date);
                    const games = Array.from(
                      block.querySelectorAll(".calendar-game"),
                    );
                    for (const game of games) {
                      const home =
                        game
                          .querySelector(".team-home .team-title a")
                          ?.textContent?.trim() || "";
                      const away =
                        game
                          .querySelector(".team-away .team-title a")
                          ?.textContent?.trim() || "";
                      const time =
                        game
                          .querySelector(".match-info .match-time")
                          ?.textContent?.trim() || "";
                      const line = [home, time, away]
                        .filter((v) => v)
                        .join(" ");
                      if (line) parts.push(`- ${line}`);
                    }
                  }
                  return parts.join("\n").trim();
                });

              const waitForWeekChange = async (prevKey: string) => {
                try {
                  await page.waitForFunction(
                    (key) => {
                      const cal = document.querySelector(".calendar");
                      if (!cal) return false;
                      const year = cal.getAttribute("data-current-year") || "";
                      const week = cal.getAttribute("data-current-week") || "";
                      return `${year}-${week}` !== key;
                    },
                    { timeout: 10000 },
                    prevKey,
                  );
                } catch {
                  // Ignore timeouts; we will extract whatever is available.
                }
                return getWeekKey();
              };

              const initialKey = await getWeekKey();
              const currentText = await extractCalendarText();

              let nextText = "";
              const nextBtn = await page.$(".calendar-next");
              if (nextBtn) {
                await nextBtn.click();
                const nextKey = await waitForWeekChange(initialKey);
                if (nextKey && nextKey !== initialKey) {
                  nextText = await extractCalendarText();
                }
              }

              let prevText = "";
              const prevBtn = await page.$(".calendar-prev");
              if (prevBtn) {
                const afterNextKey = await getWeekKey();
                if (afterNextKey && afterNextKey !== initialKey) {
                  await prevBtn.click();
                  await waitForWeekChange(afterNextKey);
                }
                const backKey = await getWeekKey();
                await prevBtn.click();
                const prevKey = await waitForWeekChange(backKey);
                if (prevKey && prevKey !== backKey) {
                  prevText = await extractCalendarText();
                }
              }

              const sections: string[] = [];
              if (currentText) sections.push(`Current week:\n${currentText}`);
              if (nextText) sections.push(`Next week:\n${nextText}`);
              if (prevText) sections.push(`Previous week:\n${prevText}`);
              const calendarText = sections.join("\n\n").trim();
              if (calendarText) {
                await browser.close();
                return calendarText;
              }
            }
          }

          // Remove typical noise that bloats chunks
          await page.evaluate(() => {
            for (const sel of [
              "nav",
              "footer",
              "header",
              "aside",
              "script",
              "style",
              ".advertisement",
              ".ad",
              ".cookie-banner",
              "#cookie-notice",
            ]) {
              document.querySelectorAll(sel).forEach((n) => n.remove());
            }
          });

          // Extract readable text (prefer main/article/tables)
          const text = await page.evaluate(() => {
            // For stats sites, prioritize tables
            const tables = document.querySelectorAll("table");
            if (tables.length > 0) {
              let tableText = "";
              tables.forEach((table) => {
                tableText += table.innerText + "\n\n";
              });
              if (tableText.trim().length > 0) return tableText.trim();
            }

            // Otherwise get main content
            const root =
              document.querySelector("article") ||
              document.querySelector("main") ||
              document.querySelector(".content") ||
              document.querySelector("#content") ||
              document.body;
            return root?.innerText || "";
          });
          await browser.close();
          return text;
        },
      });
      const raw = (await loader.scrape()) ?? "";
      const cleaned = raw
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (isAccessBlockedContent(cleaned)) return "";
      return cleaned;
    } catch (error) {
      console.error(`Scraping error for ${url}:`, error);
      return "";
    }
  } else if (type === "rss") {
    const links = await extractRssLinks(url);
    return links.join("\n");
  }
  return "";
};

const extractRssLinks = async (url: string): Promise<string[]> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; FootballRAGBot/1.0; +https://example.com/bot)",
      accept: "text/html,application/xml,text/xml,application/json,*/*",
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);

  const text = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const result = parser.parse(text);

  const items = result.rss?.channel?.item || result.feed?.entry || [];
  const links: string[] = (items as RssItem[])
    .map((item: RssItem) => {
      const normalized = normalizeRssLink(item.link);
      const absolute = normalized ? normalizeUrl(url, normalized) : null;
      const title = item.title || "";
      return { link: absolute, title };
    })
    .filter(({ link, title }) => {
      if (!link) return false;
      if (isBlocked(link)) return false;
      if (!isLikelyHtml(link)) return false;
      if (KEYWORDS.length && !matchesKeywords(link, title)) return false;
      return true;
    })
    .map((entry) => entry.link as string);

  return Array.from(new Set<string>(links)).slice(0, 30);
};

const normalizeRssLink = (link: RssItem["link"]): string | undefined => {
  if (!link) return undefined;
  if (typeof link === "string") return link;
  if (typeof link === "object") {
    const href = (link as { "@_href"?: string })["@_href"];
    return href;
  }
  return undefined;
};

const isLowValueContent = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;

  // For stats/table content, be more lenient
  const hasNumbers = /\d+/.test(normalized);
  const hasStatsKeywords =
    /goal|assist|match|team|player|score|stat|table|league|position|points|win|draw|loss/.test(
      normalized,
    );

  if (hasNumbers && hasStatsKeywords && normalized.length >= 100) {
    return false; // Accept shorter stats content
  }

  if (normalized.length < 200) return true;
  if (normalized.length >= 800) return false;

  let matches = 0;
  for (const pattern of BOILERPLATE_PATTERNS) {
    if (normalized.includes(pattern)) matches += 1;
  }
  if (matches >= 3) return true;

  const words = normalized.split(" ").filter(Boolean);
  const unique = new Set(words);
  if (unique.size < 30) return true;

  return false;
};

const isAccessBlockedContent = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
  return [
    "access denied",
    "forbidden",
    "request blocked",
    "permission denied",
    "not authorized",
    "temporarily unavailable",
    "service unavailable",
    "error 403",
    "error 404",
    "captcha",
    "verify you are human",
    "cloudflare",
  ].some((pattern) => normalized.includes(pattern));
};

const isBbcTeamPage = (url: string): boolean =>
  url.toLowerCase().includes(BBC_TEAM_PATH);

const extractHtmlLinks = async (
  url: string,
): Promise<Array<{ href: string; text: string }>> => {
  try {
    const loader = new PuppeteerWebBaseLoader(url, {
      launchOptions: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
      gotoOptions: {
        waitUntil: "domcontentloaded",
      },
      evaluate: async (page, browser) => {
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a")).map((a) => ({
            href: a.getAttribute("href") || "",
            text: a.textContent || "",
          })),
        );
        await browser.close();
        return JSON.stringify(links);
      },
    });
    const raw = (await loader.scrape()) ?? "";
    if (!raw) return [];
    return JSON.parse(raw) as Array<{ href: string; text: string }>;
  } catch {
    return [];
  }
};

const filterBbcTeamLinks = (
  baseUrl: string,
  links: Array<{ href: string; text: string }>,
): string[] => {
  const items = links
    .map((link) => ({
      url: normalizeUrl(baseUrl, link.href),
      text: link.text || "",
    }))
    .filter(({ url }) => Boolean(url && url.startsWith("http")));

  const filtered = items
    .filter(({ url }) => {
      if (!url) return false;
      const lower = url.toLowerCase();
      if (!lower.includes("bbc.com/sport/football/")) return false;
      if (lower.includes("/teams/")) return false;
      if (isBlocked(url)) return false;
      if (!isLikelyHtml(url)) return false;
      return true;
    })
    .filter((item): item is { url: string; text: string } =>
      Boolean(item.url && item.url.startsWith("http")),
    )
    .filter(({ url, text }) => {
      const hasKeywords = KEYWORDS.length ? matchesKeywords(url, text) : true;
      return hasKeywords || url.includes("/sport/football/");
    })
    .map(({ url }) => url);

  return Array.from(new Set(filtered)).slice(0, 30);
};

const isBlocked = (href: string | null | undefined): boolean => {
  const h = (href || "").toLowerCase().trim();
  return BLOCK_PATTERNS.some((pattern) => h.includes(pattern));
};

const isLikelyHtml = (urlStr: string): boolean => {
  const u = urlStr.toLowerCase();
  if (u.endsWith(".xml") || u.endsWith(".json")) return false;
  if (u.includes("/api/")) return false;
  return true;
};

const matchesKeywords = (urlStr: string, anchorText = ""): boolean => {
  const hay = `${urlStr} ${anchorText}`.toLowerCase();
  return KEYWORDS.some((keyword) => hay.includes(keyword));
};

const normalizeUrl = (base: string, href: string): string | null => {
  try {
    return new URL(href, base).toString().split("#")[0];
  } catch {
    return null;
  }
};

const seed = async () => {
  const startedAt = Date.now();
  console.log("\n⚽ MAXIMIZED Football Data Scraper");
  console.log("✅ Removed: WhoScored, Medium, UEFA.com, Goal.com");
  console.log("✅ Expanded: Understat (10 leagues), Wikipedia (18 pages)");
  console.log("✅ Optimized: All delays properly configured\n");

  console.log("📊 Configuration:");
  console.log(`- Total sources: ${footballData.length}`);
  console.log(
    `- BBC Team Pages: ${isEnabled(EPL_TEAMS_ENABLED) ? "✅ Enabled" : "❌ Disabled"}`,
  );
  console.log(`- Max URLs: ${MAX_SCRAPE_URLS || "Unlimited"}\n`);

  const vectorDimensions = await createCollection("dot_product");
  const { processedUrls, processedUrlList, recordsAdded, totalEmbeddingTokens } =
    await loadSampleData(vectorDimensions);
  const durationMs = Date.now() - startedAt;

  // text-embedding-3-large pricing: $0.13 per 1M tokens
  const estimatedCost = (totalEmbeddingTokens / 1_000_000) * 0.13;

  console.log("\n✅ Seed complete");
  const totalSecs = Math.floor(durationMs / 1000);
  const hh = String(Math.floor(totalSecs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSecs % 60).padStart(2, "0");
  console.log(`⏱️  Time taken: ${hh}:${mm}:${ss}`);
  console.log(`📄 Parsed URLs: ${processedUrls}`);
  console.log(`💾 Records added: ${recordsAdded}`);
  console.log(`🔤 Embedding tokens used: ${totalEmbeddingTokens.toLocaleString()}`);
  console.log(`💰 Estimated embedding cost: $${estimatedCost.toFixed(4)}`);
  console.log("\n📋 Parsed URL list:");
  for (const url of processedUrlList) {
    console.log(`   - ${url}`);
  }

  const dateStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logLines = [
    "✅ Seed complete",
    `⏱️  Time taken: ${hh}:${mm}:${ss}`,
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

seed().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
