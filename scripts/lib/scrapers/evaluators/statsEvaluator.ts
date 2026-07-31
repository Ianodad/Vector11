// Stats site detection
//
// `url` here is a SourceItem.url from scripts/lib/config/dataSources.ts, as
// passed straight through by scripts/loadDb.ts (the queue item destructures
// `url` from each source entry and calls isStatsSite(url) directly — no
// separate "display url"; it's the actual fetch endpoint). The zero-key
// espn-api / football-data-api / api-football entries built there use
// `site.api.espn.com`, `api.football-data.org`, and
// `v3.football.api-sports.io` respectively, so matching those hosts here is
// enough for their standings tables to get STATS_CHUNK_SIZE like Understat's.

export const isStatsSite = (url: string): boolean => {
  return (
    url.includes("understat.com") ||
    url.includes("fbref.com") ||
    url.includes("soccerstats.com") ||
    url.includes("footystats.org") ||
    url.includes("soccerway.com") ||
    url.includes("worldfootball.net") ||
    url.includes("site.api.espn.com") ||
    url.includes("api.football-data.org") ||
    url.includes("v3.football.api-sports.io")
  );
};
