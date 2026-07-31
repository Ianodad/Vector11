// footballDataGroups builder with 80+ sources
import { EPL_TEAM_SLUGS_ALL } from "./constants.js";
import { isEnabled, resolveTeamPageCount, resolveTeamSlugs } from "./env.js";
import { currentSeasonStartYear, understatSeasonPath } from "../scrapers/apiFetchers.js";

export type SourceType =
  | "html"
  | "rss"
  | "soccerway_form"
  | "soccerway_lineups"
  | "understat"
  | "espn-api"
  | "wikipedia-api"
  | "openfootball"
  | "football-data-api"
  | "api-football";

export interface SourceItem {
  url: string;
  type: SourceType;
  source: string;
  delay?: number; // Delay in seconds - CRITICAL for rate limiting
  category?: string;
  // Soccerway form table metadata
  formMode?: "home" | "away" | "overall";
  formMatches?: number;
  // API-fetcher metadata (see scripts/lib/scrapers/apiFetchers.ts) — mirrors
  // each fetcher's own args; only the fields a given `type` actually needs
  // are set on any one entry.
  leagueName?: string; // display name used in the fetcher's house-format header
  leagueCode?: string; // ESPN soccer league slug, e.g. "eng.1"
  espnEndpoint?: "standings" | "scoreboard"; // which ESPN fetcher to call
  wikiTitle?: string; // MediaWiki page title (may be computed dynamically)
  wikiDocType?: string; // house-format Type hint: standings|fixtures|results|mixed
  leaguePath?: string; // openfootball league path, e.g. "en.1"
  competitionCode?: string; // football-data.org competition code, e.g. "PL"
  apiLeagueId?: number; // api-football (api-sports.io) league id
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
  // Computed once per build so every dynamic-season entry below (Understat,
  // Wikipedia's current-season article) rolls forward automatically instead
  // of needing a yearly manual edit.
  const currentYear = currentSeasonStartYear();
  const previousYear = currentYear - 1;
  const nextYearSuffix = String((currentYear + 1) % 100).padStart(2, "0");
  // en-dash (U+2013), matching Wikipedia's own season-title convention, e.g.
  // "2025–26_Premier_League".
  const currentPlSeasonTitle = `${currentYear}–${nextYearSuffix}_Premier_League`;

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
      // ESPN HTML snapshots removed — replaced by zero-key `espn-api`
      // entries (standings live in `stats`, scoreboard in `fixtures`) that
      // cover the big-5 leagues via ESPN's JSON API instead of one page.
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
      // ESPN API - standings (JSON, no key) - big-5 leagues
      {
        url: "https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings",
        type: "espn-api",
        espnEndpoint: "standings",
        leagueCode: "eng.1",
        leagueName: "Premier League",
        source: "ESPN API EPL Standings",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/v2/sports/soccer/esp.1/standings",
        type: "espn-api",
        espnEndpoint: "standings",
        leagueCode: "esp.1",
        leagueName: "La Liga",
        source: "ESPN API La Liga Standings",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/v2/sports/soccer/ita.1/standings",
        type: "espn-api",
        espnEndpoint: "standings",
        leagueCode: "ita.1",
        leagueName: "Serie A",
        source: "ESPN API Serie A Standings",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/v2/sports/soccer/ger.1/standings",
        type: "espn-api",
        espnEndpoint: "standings",
        leagueCode: "ger.1",
        leagueName: "Bundesliga",
        source: "ESPN API Bundesliga Standings",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/v2/sports/soccer/fra.1/standings",
        type: "espn-api",
        espnEndpoint: "standings",
        leagueCode: "fra.1",
        leagueName: "Ligue 1",
        source: "ESPN API Ligue 1 Standings",
        delay: 2,
      },
      // football-data.org (KEY-GATED — needs FOOTBALL_DATA_API_KEY) -
      // standings + top scorers, big-5 + UCL
      {
        url: "https://api.football-data.org/v4/competitions/PL/standings",
        type: "football-data-api",
        competitionCode: "PL",
        leagueName: "Premier League",
        source: "football-data.org EPL",
        delay: 2,
      },
      {
        url: "https://api.football-data.org/v4/competitions/PD/standings",
        type: "football-data-api",
        competitionCode: "PD",
        leagueName: "La Liga",
        source: "football-data.org La Liga",
        delay: 2,
      },
      {
        url: "https://api.football-data.org/v4/competitions/SA/standings",
        type: "football-data-api",
        competitionCode: "SA",
        leagueName: "Serie A",
        source: "football-data.org Serie A",
        delay: 2,
      },
      {
        url: "https://api.football-data.org/v4/competitions/BL1/standings",
        type: "football-data-api",
        competitionCode: "BL1",
        leagueName: "Bundesliga",
        source: "football-data.org Bundesliga",
        delay: 2,
      },
      {
        url: "https://api.football-data.org/v4/competitions/FL1/standings",
        type: "football-data-api",
        competitionCode: "FL1",
        leagueName: "Ligue 1",
        source: "football-data.org Ligue 1",
        delay: 2,
      },
      {
        url: "https://api.football-data.org/v4/competitions/CL/standings",
        type: "football-data-api",
        competitionCode: "CL",
        leagueName: "Champions League",
        source: "football-data.org Champions League",
        delay: 2,
      },
      // Understat - BEST STATS SOURCE (JSON in script tags)
      {
        url: "https://understat.com/league/EPL",
        type: "understat",
        source: "Understat EPL",
        delay: 3,
      },
      {
        url: `https://understat.com/league/EPL/${understatSeasonPath(currentYear)}`,
        type: "understat",
        source: `Understat EPL ${understatSeasonPath(currentYear)}`,
        delay: 3,
      },
      {
        url: `https://understat.com/league/EPL/${understatSeasonPath(previousYear)}`,
        type: "understat",
        source: `Understat EPL ${understatSeasonPath(previousYear)}`,
        delay: 3,
      },
      {
        url: "https://understat.com/league/La_liga",
        type: "understat",
        source: "Understat La Liga",
        delay: 3,
      },
      {
        url: `https://understat.com/league/La_liga/${understatSeasonPath(currentYear)}`,
        type: "understat",
        source: `Understat La Liga ${understatSeasonPath(currentYear)}`,
        delay: 3,
      },
      {
        url: `https://understat.com/league/La_liga/${understatSeasonPath(previousYear)}`,
        type: "understat",
        source: `Understat La Liga ${understatSeasonPath(previousYear)}`,
        delay: 3,
      },
      {
        url: "https://understat.com/league/Serie_A",
        type: "understat",
        source: "Understat Serie A",
        delay: 3,
      },
      {
        url: `https://understat.com/league/Serie_A/${understatSeasonPath(currentYear)}`,
        type: "understat",
        source: `Understat Serie A ${understatSeasonPath(currentYear)}`,
        delay: 3,
      },
      {
        url: `https://understat.com/league/Serie_A/${understatSeasonPath(previousYear)}`,
        type: "understat",
        source: `Understat Serie A ${understatSeasonPath(previousYear)}`,
        delay: 3,
      },
      {
        url: "https://understat.com/league/Bundesliga",
        type: "understat",
        source: "Understat Bundesliga",
        delay: 3,
      },
      {
        url: `https://understat.com/league/Bundesliga/${understatSeasonPath(currentYear)}`,
        type: "understat",
        source: `Understat Bundesliga ${understatSeasonPath(currentYear)}`,
        delay: 3,
      },
      {
        url: `https://understat.com/league/Bundesliga/${understatSeasonPath(previousYear)}`,
        type: "understat",
        source: `Understat Bundesliga ${understatSeasonPath(previousYear)}`,
        delay: 3,
      },
      {
        url: "https://understat.com/league/Ligue_1",
        type: "understat",
        source: "Understat Ligue 1",
        delay: 3,
      },
      {
        url: `https://understat.com/league/Ligue_1/${understatSeasonPath(currentYear)}`,
        type: "understat",
        source: `Understat Ligue 1 ${understatSeasonPath(currentYear)}`,
        delay: 3,
      },
      {
        url: `https://understat.com/league/Ligue_1/${understatSeasonPath(previousYear)}`,
        type: "understat",
        source: `Understat Ligue 1 ${understatSeasonPath(previousYear)}`,
        delay: 3,
      },
      // SoccerStats - permanently 403 for this scraper — removed.
      // Replacement: ESPN API / football-data.org standings above.
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
      // FBref (EPL stats/fixtures/team-stats) - permanently 403 for this
      // scraper — removed. Replacement: ESPN API / football-data.org above.
    ],

    // ============================================
    // PLAYER PERFORMANCE
    // ============================================
    playerPerformance: [
      // FBref (player/shooting/passing stats) - permanently 403 for this
      // scraper — removed. Replacement: football-data.org top scorers
      // (football-data-api, in `stats`).
    ],

    // ============================================
    // FIXTURES - Very scrapeable
    // ============================================
    fixtures: [
      // ESPN API - scoreboard/results (JSON, no key) - big-5 leagues
      {
        url: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",
        type: "espn-api",
        espnEndpoint: "scoreboard",
        leagueCode: "eng.1",
        leagueName: "Premier League",
        source: "ESPN API EPL Scoreboard",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard",
        type: "espn-api",
        espnEndpoint: "scoreboard",
        leagueCode: "esp.1",
        leagueName: "La Liga",
        source: "ESPN API La Liga Scoreboard",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard",
        type: "espn-api",
        espnEndpoint: "scoreboard",
        leagueCode: "ita.1",
        leagueName: "Serie A",
        source: "ESPN API Serie A Scoreboard",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard",
        type: "espn-api",
        espnEndpoint: "scoreboard",
        leagueCode: "ger.1",
        leagueName: "Bundesliga",
        source: "ESPN API Bundesliga Scoreboard",
        delay: 2,
      },
      {
        url: "https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard",
        type: "espn-api",
        espnEndpoint: "scoreboard",
        leagueCode: "fra.1",
        leagueName: "Ligue 1",
        source: "ESPN API Ligue 1 Scoreboard",
        delay: 2,
      },
      // openfootball - full-season fixtures/results JSON (no key), current season
      {
        url: `https://raw.githubusercontent.com/openfootball/football.json/master/${currentYear}-${nextYearSuffix}/en.1.json`,
        type: "openfootball",
        leaguePath: "en.1",
        leagueName: "Premier League",
        source: "openfootball EPL",
        delay: 2,
      },
      {
        url: `https://raw.githubusercontent.com/openfootball/football.json/master/${currentYear}-${nextYearSuffix}/es.1.json`,
        type: "openfootball",
        leaguePath: "es.1",
        leagueName: "La Liga",
        source: "openfootball La Liga",
        delay: 2,
      },
      {
        url: `https://raw.githubusercontent.com/openfootball/football.json/master/${currentYear}-${nextYearSuffix}/it.1.json`,
        type: "openfootball",
        leaguePath: "it.1",
        leagueName: "Serie A",
        source: "openfootball Serie A",
        delay: 2,
      },
      {
        url: `https://raw.githubusercontent.com/openfootball/football.json/master/${currentYear}-${nextYearSuffix}/de.1.json`,
        type: "openfootball",
        leaguePath: "de.1",
        leagueName: "Bundesliga",
        source: "openfootball Bundesliga",
        delay: 2,
      },
      {
        url: `https://raw.githubusercontent.com/openfootball/football.json/master/${currentYear}-${nextYearSuffix}/fr.1.json`,
        type: "openfootball",
        leaguePath: "fr.1",
        leagueName: "Ligue 1",
        source: "openfootball Ligue 1",
        delay: 2,
      },
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
      // WorldFootball.net - permanently 403 for this scraper — removed.
      // Replacement: openfootball fixtures/results above (AFCON coverage
      // moves to api-football league 6, in `afcon`).
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
      // api-football (api-sports.io) (KEY-GATED — needs API_FOOTBALL_KEY) -
      // standings, filling the African coverage gap left by the removed
      // WorldFootball AFCON page.
      {
        url: "https://v3.football.api-sports.io/standings?league=6",
        type: "api-football",
        apiLeagueId: 6,
        leagueName: "AFCON",
        source: "api-football AFCON Standings",
        delay: 2,
      },
      {
        url: "https://v3.football.api-sports.io/standings?league=12",
        type: "api-football",
        apiLeagueId: 12,
        leagueName: "CAF Champions League",
        source: "api-football CAF Champions League Standings",
        delay: 2,
      },
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
        type: "wikipedia-api",
        wikiTitle: "Premier_League",
        wikiDocType: "mixed",
        leagueName: "Premier League",
        source: "Wikipedia – Premier League",
        delay: 1,
      },
      // DYNAMIC: title rolls forward automatically from currentSeasonStartYear().
      {
        url: `https://en.wikipedia.org/wiki/${currentPlSeasonTitle}`,
        type: "wikipedia-api",
        wikiTitle: currentPlSeasonTitle,
        wikiDocType: "standings",
        leagueName: "Premier League",
        source: `Wikipedia – ${currentYear}-${nextYearSuffix} Premier League`,
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/List_of_Premier_League_clubs",
        type: "wikipedia-api",
        wikiTitle: "List_of_Premier_League_clubs",
        wikiDocType: "mixed",
        leagueName: "Premier League",
        source: "Wikipedia – EPL Clubs",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/List_of_foreign_Premier_League_players",
        type: "wikipedia-api",
        wikiTitle: "List_of_foreign_Premier_League_players",
        wikiDocType: "mixed",
        leagueName: "Premier League",
        source: "Wikipedia – Foreign EPL players",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/List_of_one-club_men_in_association_football",
        type: "wikipedia-api",
        wikiTitle: "List_of_one-club_men_in_association_football",
        wikiDocType: "mixed",
        leagueName: "Football",
        source: "Wikipedia – One-club men",
        delay: 1,
      },
      // AFCON
      {
        url: "https://en.wikipedia.org/wiki/2025_Africa_Cup_of_Nations",
        type: "wikipedia-api",
        wikiTitle: "2025_Africa_Cup_of_Nations",
        wikiDocType: "mixed",
        leagueName: "AFCON",
        source: "Wikipedia – AFCON 2025",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/Africa_Cup_of_Nations",
        type: "wikipedia-api",
        wikiTitle: "Africa_Cup_of_Nations",
        wikiDocType: "mixed",
        leagueName: "AFCON",
        source: "Wikipedia – Africa Cup of Nations",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/Africa_Cup_of_Nations_records_and_statistics",
        type: "wikipedia-api",
        wikiTitle: "Africa_Cup_of_Nations_records_and_statistics",
        wikiDocType: "mixed",
        leagueName: "AFCON",
        source: "Wikipedia – AFCON records & stats",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/African_Footballer_of_the_Year",
        type: "wikipedia-api",
        wikiTitle: "African_Footballer_of_the_Year",
        wikiDocType: "mixed",
        leagueName: "AFCON",
        source: "Wikipedia – African Footballer of the Year",
        delay: 1,
      },
      // General Football
      {
        url: "https://en.wikipedia.org/wiki/Association_football",
        type: "wikipedia-api",
        wikiTitle: "Association_football",
        wikiDocType: "mixed",
        leagueName: "Football",
        source: "Wikipedia – Association football",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/Football_player",
        type: "wikipedia-api",
        wikiTitle: "Football_player",
        wikiDocType: "mixed",
        leagueName: "Football",
        source: "Wikipedia – Football player",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/History_of_association_football",
        type: "wikipedia-api",
        wikiTitle: "History_of_association_football",
        wikiDocType: "mixed",
        leagueName: "Football",
        source: "Wikipedia – History of football",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/Football_club_(association_football)",
        type: "wikipedia-api",
        wikiTitle: "Football_club_(association_football)",
        wikiDocType: "mixed",
        leagueName: "Football",
        source: "Wikipedia – Football club",
        delay: 1,
      },
      // Other Leagues
      {
        url: "https://en.wikipedia.org/wiki/La_Liga",
        type: "wikipedia-api",
        wikiTitle: "La_Liga",
        wikiDocType: "mixed",
        leagueName: "La Liga",
        source: "Wikipedia – La Liga",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/Serie_A",
        type: "wikipedia-api",
        wikiTitle: "Serie_A",
        wikiDocType: "mixed",
        leagueName: "Serie A",
        source: "Wikipedia – Serie A",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/Bundesliga",
        type: "wikipedia-api",
        wikiTitle: "Bundesliga",
        wikiDocType: "mixed",
        leagueName: "Bundesliga",
        source: "Wikipedia – Bundesliga",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/Ligue_1",
        type: "wikipedia-api",
        wikiTitle: "Ligue_1",
        wikiDocType: "mixed",
        leagueName: "Ligue 1",
        source: "Wikipedia – Ligue 1",
        delay: 1,
      },
      {
        url: "https://en.wikipedia.org/wiki/UEFA_Champions_League",
        type: "wikipedia-api",
        wikiTitle: "UEFA_Champions_League",
        wikiDocType: "mixed",
        leagueName: "Champions League",
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
