import { DataAPIClient, DataAPIResponseError } from "@datastax/astra-db-ts";
import { PuppeteerWebBaseLoader } from "@langchain/community/document_loaders/web/puppeteer";
import OpenAI from "openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { XMLParser } from "fast-xml-parser";

import "dotenv/config";

type SourceType = "html" | "rss" | "json";
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
const MAX_SCRAPE_URLS = process.env.MAX_SCRAPE_URLS;
const EPL_TEAM_PAGES = process.env.EPL_TEAM_PAGES;
const EPL_TEAM_SLUGS = process.env.EPL_TEAM_SLUGS;
const EPL_TEAMS_ENABLED = process.env.EPL_TEAMS_ENABLED;

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
};

const EPL_TEAM_SLUGS_ALL = [
  "afc-bournemouth",
  "arsenal",
  "aston-villa",
  "brentford",
  "brighton-and-hove-albion",
  "burnley",
  "chelsea",
  "crystal-palace",
  "everton",
  "fulham",
  "leeds-united",
  "liverpool",
  "manchester-city",
  "manchester-united",
  "newcastle-united",
  "nottingham-forest",
  "sunderland",
  "tottenham-hotspur",
  "west-ham-united",
  "wolverhampton-wanderers",
];

const buildEplTeamPages = (): SourceItem[] => {
  if (!isEnabled(EPL_TEAMS_ENABLED)) return [];
  const pageCount = resolveTeamPageCount(EPL_TEAM_PAGES);
  const requestedSlugs = resolveTeamSlugs(EPL_TEAM_SLUGS);
  const slugs =
    requestedSlugs.length > 0 ? requestedSlugs : EPL_TEAM_SLUGS_ALL;

  const items: SourceItem[] = [];
  for (const slug of slugs) {
    for (let page = 1; page <= pageCount; page += 1) {
      items.push({
        url: `https://www.bbc.com/sport/football/teams/${slug}?page=${page}`,
        type: "html",
        source: `BBC Team ${slug.replace(/-/g, " ")} (page ${page})`,
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
  news: [
    { url: "https://www.goal.com/en/news", type: "html", source: "Goal" },
    {
      url: "https://www.goal.com/en/premier-league",
      type: "html",
      source: "Goal EPL",
    },
    {
      url: "https://www.goal.com/en/africa",
      type: "html",
      source: "Goal Africa",
    },
    { url: "https://www.goal.com/en/fifa", type: "html", source: "Goal FIFA" },
    {
      url: "https://www.bbc.com/sport/football",
      type: "html",
      source: "BBC Sport",
    },
    {
      url: "https://www.bbc.com/sport/football/premier-league",
      type: "html",
      source: "BBC EPL",
    },
    {
      url: "https://www.bbc.com/sport/football/africa",
      type: "html",
      source: "BBC Africa",
    },
    {
      url: "https://www.skysports.com/football",
      type: "html",
      source: "Sky Sports",
    },
    {
      url: "https://www.skysports.com/premier-league",
      type: "html",
      source: "Sky Sports EPL",
    },
    {
      url: "https://www.skysports.com/football/news",
      type: "html",
      source: "Sky Sports News",
    },
    {
      url: "https://www.espn.com/soccer/",
      type: "html",
      source: "ESPN Soccer",
    },
    {
      url: "https://www.espn.com/soccer/league/_/name/eng.1",
      type: "html",
      source: "ESPN EPL",
    },
    {
      url: "https://www.espn.com/soccer/africa/",
      type: "html",
      source: "ESPN Africa",
    },
    {
      url: "https://www.theguardian.com/football",
      type: "html",
      source: "The Guardian Football",
    },
    {
      url: "https://www.reuters.com/world/uk/football/",
      type: "html",
      source: "Reuters Football",
    },
    {
      url: "https://www.premierleague.com/news",
      type: "html",
      source: "Premier League News",
    },
  ],
  stats: [
    {
      url: "https://fbref.com/en/comps/9/Premier-League-Stats",
      type: "html",
      source: "FBref EPL",
    },
    {
      url: "https://fbref.com/en/comps/9/schedule/Premier-League-Scores-and-Fixtures",
      type: "html",
      source: "FBref EPL Fixtures",
    },
    {
      url: "https://fbref.com/en/comps/9/stats/Premier-League-Stats",
      type: "html",
      source: "FBref EPL Team Stats",
    },
    {
      url: "https://www.soccerstats.com/latest.asp",
      type: "html",
      source: "SoccerStats",
    },
    {
      url: "https://www.soccerstats.com/league.asp?league=england",
      type: "html",
      source: "SoccerStats EPL",
    },
    {
      url: "https://www.soccerstats.com/homeaway.asp?league=england",
      type: "html",
      source: "SoccerStats Home/Away",
    },
    {
      url: "https://footystats.org/england/premier-league",
      type: "html",
      source: "FootyStats EPL",
    },
    {
      url: "https://footystats.org/england/premier-league/results",
      type: "html",
      source: "FootyStats Results",
    },
    {
      url: "https://understat.com/league/EPL",
      type: "html",
      source: "Understat EPL",
    },
    {
      url: "https://www.whoscored.com/Regions/252/Tournaments/2/England-Premier-League",
      type: "html",
      source: "WhoScored EPL",
    },
  ],
  playerPerformance: [
    {
      url: "https://fbref.com/en/players/",
      type: "html",
      source: "FBref Players Index",
    },
    {
      url: "https://fbref.com/en/comps/9/stats/Premier-League-Player-Stats",
      type: "html",
      source: "FBref Player Stats EPL",
    },
    {
      url: "https://fbref.com/en/comps/9/shooting/Premier-League-Stats",
      type: "html",
      source: "FBref Shooting Stats",
    },
    {
      url: "https://fbref.com/en/comps/9/passing/Premier-League-Stats",
      type: "html",
      source: "FBref Passing Stats",
    },
    {
      url: "https://www.transfermarkt.com/premier-league/startseite/wettbewerb/GB1",
      type: "html",
      source: "Transfermarkt EPL",
    },
  ],
  fifa: [
    {
      url: "https://www.fifa.com/fifaplus/en/news",
      type: "html",
      source: "FIFA News",
    },
    {
      url: "https://www.fifa.com/fifaplus/en/tournaments/mens/worldcup",
      type: "html",
      source: "FIFA World Cup",
    },
    {
      url: "https://www.fifa.com/fifaplus/en/match-centre",
      type: "html",
      source: "FIFA Match Centre",
    },
    {
      url: "https://www.uefa.com/uefachampionsleague/news/",
      type: "html",
      source: "UEFA Champions League News",
    },
  ],
  afcon: [
    {
      url: "https://www.cafonline.com/afcon/news/",
      type: "html",
      source: "CAF AFCON News",
    },
    {
      url: "https://www.cafonline.com/afcon/history/",
      type: "html",
      source: "AFCON History",
    },
    {
      url: "https://www.bbc.com/sport/football/africa-cup-of-nations",
      type: "html",
      source: "BBC AFCON",
    },
    {
      url: "https://www.goal.com/en/africa/cup-of-nations",
      type: "html",
      source: "Goal AFCON",
    },
  ],
  teams: buildEplTeamPages(),
  fixtures: [
    {
      url: "https://int.soccerway.com/national/england/premier-league/",
      type: "html",
      source: "Soccerway EPL",
    },
    {
      url: "https://int.soccerway.com/matches/",
      type: "html",
      source: "Soccerway Matches",
    },
    {
      url: "https://www.worldfootball.net/all_matches/eng-premier-league/",
      type: "html",
      source: "WorldFootball EPL Matches",
    },
    {
      url: "https://www.premierleague.com/fixtures",
      type: "html",
      source: "Premier League Fixtures",
    },
  ],
  analysis: [
    {
      url: "https://theanalyst.com/eu/category/football/",
      type: "html",
      source: "The Analyst",
    },
    {
      url: "https://totalfootballanalysis.com/",
      type: "html",
      source: "Total Football Analysis",
    },
    {
      url: "https://www.football365.com/",
      type: "html",
      source: "Football365",
    },
    {
      url: "https://www.planetfootball.com/",
      type: "html",
      source: "Planet Football",
    },
    {
      url: "https://medium.com/tag/football",
      type: "html",
      source: "Medium Football",
    },
  ],
  reference: [
    {
      url: "https://en.wikipedia.org/wiki/Association_football",
      type: "html",
      source: "Wikipedia – Association football",
    },
    {
      url: "https://en.wikipedia.org/wiki/Football_player",
      type: "html",
      source: "Wikipedia – Football player",
    },
    {
      url: "https://en.wikipedia.org/wiki/List_of_foreign_Premier_League_players",
      type: "html",
      source: "Wikipedia – Foreign EPL players",
    },
    {
      url: "https://en.wikipedia.org/wiki/List_of_one-club_men_in_association_football",
      type: "html",
      source: "Wikipedia – One-club men",
    },
    {
      url: "https://en.wikipedia.org/wiki/2025_Africa_Cup_of_Nations",
      type: "html",
      source: "Wikipedia – AFCON 2025",
    },
    {
      url: "https://en.wikipedia.org/wiki/Africa_Cup_of_Nations",
      type: "html",
      source: "Wikipedia – Africa Cup of Nations",
    },
    {
      url: "https://en.wikipedia.org/wiki/Africa_Cup_of_Nations_records_and_statistics",
      type: "html",
      source: "Wikipedia – AFCON records & stats",
    },
    {
      url: "https://en.wikipedia.org/wiki/African_Footballer_of_the_Year",
      type: "html",
      source: "Wikipedia – African Footballer of the Year",
    },
    {
      url: "https://en.wikipedia.org/wiki/History_of_association_football",
      type: "html",
      source: "Wikipedia – History of football",
    },
    {
      url: "https://en.wikipedia.org/wiki/Football_club_(association_football)",
      type: "html",
      source: "Wikipedia – Football club",
    },
  ],
  rss: [
    {
      url: "https://feeds.bbci.co.uk/sport/football/rss.xml",
      type: "rss",
      source: "BBC Football RSS",
    },
    {
      url: "https://www.theguardian.com/football/rss",
      type: "rss",
      source: "The Guardian Football RSS",
    },
    {
      url: "https://www.espn.com/espn/rss/soccer/news",
      type: "rss",
      source: "ESPN Soccer RSS",
    },
    {
      url: "https://www.skysports.com/rss/12040",
      type: "rss",
      source: "Sky Sports Football RSS",
    },
  ],
};

const footballData: SourceItem[] = Object.values(footballDataGroups).flat();

const client = new DataAPIClient(ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(ASTRA_DB_API_ENDPOINT, {
  keyspace: ASTRA_DB_NAMESPACE,
});

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 100,
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
        console.log(
          `Dropping collection with ${existingDimensions} dimensions, recreating with ${DEFAULT_VECTOR_DIMENSIONS}`,
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
}> => {
  const collection = db.collection(ASTRA_DB_COLLECTION);
  const queue: SourceItem[] = [...footballData];
  const maxUrls = resolveMaxUrls(MAX_SCRAPE_URLS);
  let processedUrls = 0;
  let recordsAdded = 0;
  const processedUrlList: string[] = [];
  let skippedUrls = 0;
  let failedUrls = 0;

  for (let i = 0; i < queue.length; i += 1) {
    const { url, type, source } = queue[i];
    const baseTotal = queue.length;
    const capLabel = maxUrls !== undefined ? ` cap=${maxUrls}` : "";
    console.log(`[${i + 1}/${baseTotal}] Processing ${url} (${type})${capLabel}`);

    if (type === "rss") {
      const links = await extractRssLinks(url);
      for (const link of links) {
        queue.push({
          url: link,
          type: "html",
          source: `${source} Article`,
        });
      }
      continue;
    }

    if (maxUrls !== undefined && processedUrls >= maxUrls) break;
    if (isBbcTeamPage(url)) {
      const links = await extractHtmlLinks(url);
      const filtered = filterBbcTeamLinks(url, links);
      for (const link of filtered) {
        queue.push({
          url: link,
          type: "html",
          source: `${source} Article`,
        });
      }
      console.log(
        `Expanded BBC team page ${url} -> ${filtered.length} article links`,
      );
      continue;
    }
    if (isBlocked(url) || !isLikelyHtml(url)) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (blocked or non-html)`);
      continue;
    }

    const content = await scrapPage(url, type);
    if (!content || content.trim().length < 200) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (empty/short)`);
      continue;
    }
    if (isLowValueContent(content)) {
      skippedUrls += 1;
      console.log(`Skipped ${url} (low value content)`);
      continue;
    }

    const chunks = await splitter.splitText(content);
    try {
      for await (const chunk of chunks) {
        if (chunk.trim().length < 120) continue;
        if (isLowValueContent(chunk)) continue;
        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunk,
          dimensions: vectorDimensions,
          encoding_format: "float",
        });
        const vector = embedding.data[0].embedding;
        const res = await collection.insertOne({
          content: chunk,
          source,
          $vector: vector,
        });
        console.log(res);
        recordsAdded += 1;
      }
    } catch (err) {
      failedUrls += 1;
      console.warn(`Failed to insert for ${url}:`, err);
      continue;
    }
    processedUrls += 1;
    processedUrlList.push(url);
    console.log(
      `Completed ${url} | processed=${processedUrls} skipped=${skippedUrls} failed=${failedUrls} records=${recordsAdded}`,
    );
  }

  return { processedUrls, processedUrlList, recordsAdded };
};

const scrapPage = async (url: string, type: SourceType): Promise<string> => {
  if (type === "html") {
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
          // Remove typical noise that bloats chunks
          await page.evaluate(() => {
            for (const sel of [
              "nav",
              "footer",
              "header",
              "aside",
              "script",
              "style",
            ]) {
              document.querySelectorAll(sel).forEach((n) => n.remove());
            }
          });

          // Extract readable text (prefer main/article)
          const text = await page.evaluate(() => {
            const root =
              document.querySelector("article") ||
              document.querySelector("main") ||
              document.body;
            return root?.innerText || "";
          });
          await browser.close();
          return text;
        },
      });
      const raw = (await loader.scrape()) ?? "";
      const cleaned = raw.replace(/\s+/g, " ").trim();
      if (isAccessBlockedContent(cleaned)) return "";
      return cleaned;
    } catch {
      return "";
    }
  } else if (type === "rss") {
    const links = await extractRssLinks(url);
    return links.join("\n");
  }
  // Fallback for json or other types if not handled effectively
  return "";
};

const extractRssLinks = async (url: string): Promise<string[]> => {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; FootballRAGBot/1.0; +https://example.com/bot)",
      accept: "text/html,application/xml,text/xml,application/json,*/*",
    },
  });

  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);

  const text = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const result = parser.parse(text);

  // RSS 2.0 uses channel.item, Atom uses feed.entry
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
  // Atom feeds can use <link href="...">
  if (typeof link === "object") {
    const href = (link as { "@_href"?: string })["@_href"];
    return href;
  }
  return undefined;
};

const isLowValueContent = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
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
    .filter(
      (item): item is { url: string; text: string } =>
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
  const vectorDimensions = await createCollection("dot_product");
  const { processedUrls, processedUrlList, recordsAdded } =
    await loadSampleData(vectorDimensions);
  const durationMs = Date.now() - startedAt;
  console.log("Seed complete");
  console.log(`Time taken: ${Math.round(durationMs / 1000)}s`);
  console.log(`Parsed URLs: ${processedUrls}`);
  console.log(`Records added: ${recordsAdded}`);
  console.log("Parsed URL list:");
  for (const url of processedUrlList) {
    console.log(`- ${url}`);
  }
};

seed();
