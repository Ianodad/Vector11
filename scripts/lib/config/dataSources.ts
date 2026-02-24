// footballDataGroups builder with 80+ sources
import { EPL_TEAM_SLUGS_ALL } from "./constants.js";
import { isEnabled, resolveTeamPageCount, resolveTeamSlugs } from "./env.js";

export type SourceType =
  | "html"
  | "rss"
  | "soccerway_form"
  | "soccerway_lineups";

export interface SourceItem {
  url: string;
  type: SourceType;
  source: string;
  delay?: number; // Delay in seconds - CRITICAL for rate limiting
  category?: string;
  // Soccerway form table metadata
  formMode?: "home" | "away" | "overall";
  formMatches?: number;
}

export type SourceCategory =
  | "news"
  | "stats"
  | "playerPerformance"
  | "fixtures"
  | "analysis"
  | "fifa"
  | "afcon"
  | "teams"
  | "reference"
  | "rss"
  | "soccerwayForm";

export const buildEplTeamPages = (
  eplTeamsEnabled: string | undefined,
  eplTeamPages: string | undefined,
  eplTeamSlugs: string | undefined,
): SourceItem[] => {
  if (!isEnabled(eplTeamsEnabled)) return [];
  const pageCount = resolveTeamPageCount(eplTeamPages);
  const requestedSlugs = resolveTeamSlugs(eplTeamSlugs);
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

export const buildFootballDataGroups = (
  eplTeamsEnabled: string | undefined,
  eplTeamPages: string | undefined,
  eplTeamSlugs: string | undefined,
): Record<SourceCategory, SourceItem[]> => {
  return {
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
      // {
      //   url: "https://www.espn.com/soccer/",
      //   type: "html",
      //   source: "ESPN Soccer",
      //   delay: 2,
      // },
      {
        url: "https://www.espn.com/soccer/league/_/name/eng.1",
        type: "html",
        source: "ESPN EPL",
        delay: 2,
      },
      // {
      //   url: "https://www.espn.com/soccer/africa/",
      //   type: "html",
      //   source: "ESPN Africa",
      //   delay: 2,
      // },
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
      // Soccerway News - tournament-specific news feeds (server-side rendered)
      {
        url: "https://www.soccerway.com/england/premier-league/news/",
        type: "html",
        source: "Soccerway EPL News",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/national/spain/primera-division/news/",
        type: "html",
        source: "Soccerway La Liga News",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/national/italy/serie-a/news/",
        type: "html",
        source: "Soccerway Serie A News",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/national/germany/bundesliga/news/",
        type: "html",
        source: "Soccerway Bundesliga News",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/national/france/ligue-1/news/",
        type: "html",
        source: "Soccerway Ligue 1 News",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/international/europe/uefa-champions-league/news/",
        type: "html",
        source: "Soccerway UCL News",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/international/europe/uefa-europa-league/news/",
        type: "html",
        source: "Soccerway Europa League News",
        delay: 5,
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
      // {
      //   url: "https://www.soccerstats.com/latest.asp",
      //   type: "html",
      //   source: "SoccerStats",
      //   delay: 3,
      // },
      // {
      //   url: "https://www.soccerstats.com/league.asp?league=england",
      //   type: "html",
      //   source: "SoccerStats EPL",
      //   delay: 3,
      // },
      // {
      //   url: "https://www.soccerstats.com/homeaway.asp?league=england",
      //   type: "html",
      //   source: "SoccerStats Home/Away",
      //   delay: 3,
      // },
      // FootyStats - Accessible
      // {
      //   url: "https://footystats.org/england/premier-league",
      //   type: "html",
      //   source: "FootyStats EPL",
      //   delay: 3,
      // },
      // {
      //   url: "https://footystats.org/england/premier-league/results",
      //   type: "html",
      //   source: "FootyStats Results",
      //   delay: 3,
      // },
      // FBref - CRITICAL 6 SECOND DELAY
      // {
      //   url: "https://fbref.com/en/comps/9/Premier-League-Stats",
      //   type: "html",
      //   source: "FBref EPL",
      //   delay: 6, // DO NOT REDUCE - will ban you
      // },
      // {
      //   url: "https://fbref.com/en/comps/9/schedule/Premier-League-Scores-and-Fixtures",
      //   type: "html",
      //   source: "FBref EPL Fixtures",
      //   delay: 6,
      // },
      // {
      //   url: "https://fbref.com/en/comps/9/stats/Premier-League-Stats",
      //   type: "html",
      //   source: "FBref EPL Team Stats",
      //   delay: 6,
      // },
    ],

    // ============================================
    // PLAYER PERFORMANCE
    // ============================================
    playerPerformance: [
      // {
      //   url: "https://fbref.com/en/comps/9/stats/Premier-League-Player-Stats",
      //   type: "html",
      //   source: "FBref Player Stats EPL",
      //   delay: 6,
      // },
      // {
      //   url: "https://fbref.com/en/comps/9/shooting/Premier-League-Stats",
      //   type: "html",
      //   source: "FBref Shooting Stats",
      //   delay: 6,
      // },
      // {
      //   url: "https://fbref.com/en/comps/9/passing/Premier-League-Stats",
      //   type: "html",
      //   source: "FBref Passing Stats",
      //   delay: 6,
      // },
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
      // Soccerway (www) – EPL results & fixtures
      {
        url: "https://www.soccerway.com/england/premier-league/results/",
        type: "html",
        source: "Soccerway EPL Results",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/england/premier-league/fixtures/",
        type: "html",
        source: "Soccerway EPL Fixtures",
        delay: 5,
      },
      // Soccerway – La Liga
      {
        url: "https://www.soccerway.com/spain/laliga/results/",
        type: "html",
        source: "Soccerway La Liga Results",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/spain/laliga/fixtures/",
        type: "html",
        source: "Soccerway La Liga Fixtures",
        delay: 5,
      },
      // Soccerway – Serie A
      {
        url: "https://www.soccerway.com/italy/serie-a/results/",
        type: "html",
        source: "Soccerway Serie A Results",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/italy/serie-a/fixtures/",
        type: "html",
        source: "Soccerway Serie A Fixtures",
        delay: 5,
      },
      // Soccerway – Bundesliga
      {
        url: "https://www.soccerway.com/germany/bundesliga/results/",
        type: "html",
        source: "Soccerway Bundesliga Results",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/germany/bundesliga/fixtures/",
        type: "html",
        source: "Soccerway Bundesliga Fixtures",
        delay: 5,
      },
      // Soccerway – Ligue 1
      {
        url: "https://www.soccerway.com/national/france/ligue-1/results/",
        type: "html",
        source: "Soccerway Ligue 1 Results",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/national/france/ligue-1/fixtures/",
        type: "html",
        source: "Soccerway Ligue 1 Fixtures",
        delay: 5,
      },
      // Soccerway – UEFA Champions League
      {
        url: "https://www.soccerway.com/europe/champions-league/results/",
        type: "html",
        source: "Soccerway UCL Results",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/europe/champions-league/fixtures/",
        type: "html",
        source: "Soccerway UCL Fixtures",
        delay: 5,
      },
      // Soccerway – UEFA Europa League
      {
        url: "https://www.soccerway.com/international/europe/uefa-europa-league/results/",
        type: "html",
        source: "Soccerway Europa League Results",
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/international/europe/uefa-europa-league/fixtures/",
        type: "html",
        source: "Soccerway Europa League Fixtures",
        delay: 5,
      },
      // WorldFootball.net - VERY accessible
      // {
      //   url: "https://www.worldfootball.net/all_matches/eng-premier-league/",
      //   type: "html",
      //   source: "WorldFootball EPL Matches",
      //   delay: 2,
      // },
      // {
      //   url: "https://www.worldfootball.net/schedule/eng-premier-league/",
      //   type: "html",
      //   source: "WorldFootball EPL Schedule",
      //   delay: 2,
      // },
      // {
      //   url: "https://www.worldfootball.net/schedule/afr-africa-cup-of-nations/",
      //   type: "html",
      //   source: "WorldFootball AFCON",
      //   delay: 2,
      // },
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
      // {
      //   url: "https://totalfootballanalysis.com/category/premier-league",
      //   type: "html",
      //   source: "TFA Premier League",
      //   delay: 2,
      // },
      // {
      //   url: "https://www.football365.com/",
      //   type: "html",
      //   source: "Football365",
      //   delay: 3,
      // },
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
    teams: buildEplTeamPages(eplTeamsEnabled, eplTeamPages, eplTeamSlugs),

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
    // SOCCERWAY FORM TABLES - hash-routed SPA pages
    // Last-5 home/away form standings for each major league
    // ============================================
    soccerwayForm: [
      // EPL
      {
        url: "https://www.soccerway.com/england/premier-league/standings/#/OEEq9Yvp/form/home/5/",
        type: "soccerway_form",
        source: "Soccerway EPL Home Form 5",
        formMode: "home",
        formMatches: 5,
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/england/premier-league/standings/#/OEEq9Yvp/form/away/5/",
        type: "soccerway_form",
        source: "Soccerway EPL Away Form 5",
        formMode: "away",
        formMatches: 5,
        delay: 5,
      },
      // La Liga
      {
        url: "https://www.soccerway.com/spain/laliga/standings/#/vcm2MhGk/form/home/5/",
        type: "soccerway_form",
        source: "Soccerway La Liga Home Form 5",
        formMode: "home",
        formMatches: 5,
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/spain/laliga/standings/#/vcm2MhGk/form/away/5/",
        type: "soccerway_form",
        source: "Soccerway La Liga Away Form 5",
        formMode: "away",
        formMatches: 5,
        delay: 5,
      },
      // Serie A
      {
        url: "https://www.soccerway.com/italy/serie-a/standings/#/6PWwAsA7/form/home/5/",
        type: "soccerway_form",
        source: "Soccerway Serie A Home Form 5",
        formMode: "home",
        formMatches: 5,
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/italy/serie-a/standings/#/6PWwAsA7/form/away/5/",
        type: "soccerway_form",
        source: "Soccerway Serie A Away Form 5",
        formMode: "away",
        formMatches: 5,
        delay: 5,
      },
      // Bundesliga
      {
        url: "https://www.soccerway.com/germany/bundesliga/standings/#/8UYeqfiD/form/home/5/",
        type: "soccerway_form",
        source: "Soccerway Bundesliga Home Form 5",
        formMode: "home",
        formMatches: 5,
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/germany/bundesliga/standings/#/8UYeqfiD/form/away/5/",
        type: "soccerway_form",
        source: "Soccerway Bundesliga Away Form 5",
        formMode: "away",
        formMatches: 5,
        delay: 5,
      },
      // UCL
      {
        url: "https://www.soccerway.com/europe/champions-league/standings/#/lMPimXln/form/home/5/",
        type: "soccerway_form",
        source: "Soccerway UCL Home Form 5",
        formMode: "home",
        formMatches: 5,
        delay: 5,
      },
      {
        url: "https://www.soccerway.com/europe/champions-league/standings/#/lMPimXln/form/away/5/",
        type: "soccerway_form",
        source: "Soccerway UCL Away Form 5",
        formMode: "away",
        formMatches: 5,
        delay: 5,
      },
    ] as SourceItem[],

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
};

export const buildFootballDataList = (
  eplTeamsEnabled: string | undefined,
  eplTeamPages: string | undefined,
  eplTeamSlugs: string | undefined,
): SourceItem[] => {
  const groups = buildFootballDataGroups(
    eplTeamsEnabled,
    eplTeamPages,
    eplTeamSlugs,
  );
  return Object.entries(groups).flatMap(([groupKey, items]) =>
    items.map((item) => ({ ...item, category: item.category ?? groupKey })),
  );
};
