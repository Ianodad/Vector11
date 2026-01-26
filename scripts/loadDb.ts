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
  link?: string;
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

const openai = new OpenAI({ apiKey: OPEN_API_KEY });

const footballData: Array<{
  url: string;
  type: SourceType;
  source: string;
}> = [
  /* =====================
     📰 GLOBAL FOOTBALL NEWS
     ===================== */

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

  { url: "https://www.espn.com/soccer/", type: "html", source: "ESPN Soccer" },
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

  /* =====================
     📊 EPL & LEAGUE STATS
     ===================== */

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

  /* =====================
     👤 PLAYER PERFORMANCE
     ===================== */

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

  // /* =====================
  //    🌍 FIFA & WORLD FOOTBALL
  //    ===================== */

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

  /* =====================
     🌍 AFRICAN CUP OF NATIONS
     ===================== */

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

  /* =====================
     📅 FIXTURES & MATCH REVIEWS
     ===================== */

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

  /* =====================
     🧠 ANALYSIS & BLOGS
     ===================== */

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
  { url: "https://www.football365.com/", type: "html", source: "Football365" },
  {
    url: "https://www.planetfootball.com/",
    type: "html",
    source: "Planet Football",
  },

  /*
  WIKiPEDIA
  */
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
];

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
        // service: {
        //   provider: "openai",
        //   modelName: "text-embedding-3-small",
        //   authentication: { providerKey: "my-openai-key" },
        // },
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

const loadSampleData = async (vectorDimensions: number) => {
  const collection = db.collection(ASTRA_DB_COLLECTION);
  for await (const item of footballData) {
    const { url, type, source } = item;
    const content = await scrapPage(url, type);
    const chunks = await splitter.splitText(content);
    for await (const chunk of chunks) {
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
    }
  }
};

const scrapPage = async (url: string, type: SourceType): Promise<string> => {
  if (type === "html") {
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

        // Extract readable text
        const text = await page.evaluate(() => document.body?.innerHTML);
        await browser.close();
        return text;
      },
    });
    return (await loader.scrape())?.replace(/<[^>]*>/g, "") ?? "";
  } else if (type === "rss") {
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

    // Limit to 20 items to avoid token limits
    const formatted = items
      .slice(0, 20)
      .map((item: RssItem) => {
        const title = item.title || "No Title";
        const description = item.description || item.summary || "";
        const link = item.link || "";
        return `Title: ${title}\nDescription: ${description}\nLink: ${link}\n----------------`;
      })
      .join("\n");

    return formatted;
  }
  // Fallback for json or other types if not handled effectively
  return "";
};

const seed = async () => {
  const vectorDimensions = await createCollection("dot_product");
  await loadSampleData(vectorDimensions);
};

seed();
