// Stats site detection

export const isStatsSite = (url: string): boolean => {
  return (
    url.includes("understat.com") ||
    url.includes("fbref.com") ||
    url.includes("soccerstats.com") ||
    url.includes("footystats.org") ||
    url.includes("soccerway.com") ||
    url.includes("worldfootball.net")
  );
};
