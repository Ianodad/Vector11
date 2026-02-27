// Puppeteer-based HTML scraping
import { PuppeteerWebBaseLoader } from "@langchain/community/document_loaders/web/puppeteer";
import { isAccessBlockedContent } from "./contentFilter.js";
import { isStatsSite } from "./evaluators/statsEvaluator.js";
import { evaluateFootyStatsCalendar } from "./evaluators/footyStatsEvaluator.js";
import { normalizeUrl, isBlocked, isLikelyHtml, matchesKeywords } from "../utils/helpers.js";
import { KEYWORDS } from "../config/constants.js";
import type { SourceType } from "../config/dataSources.js";

const isSoccerwayFixturesOrResultsUrl = (url: string): boolean =>
  url.includes("soccerway.com") && (url.includes("/fixtures/") || url.includes("/results/"));

const isLikelySoccerwayTickerOnlyText = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
  const tickerSignals = [
    "all live full-time scheduled today",
    "europa league - play offs",
    "conference league - play offs",
  ];
  const hits = tickerSignals.reduce(
    (count, signal) => (normalized.includes(signal) ? count + 1 : count),
    0,
  );
  return hits >= 2;
};

const detectLeagueFromUrl = (url: string): { name: string; code: string; country: string } => {
  const u = url.toLowerCase();
  if (u.includes("england/premier-league")) return { name: "Premier League", code: "EPL", country: "England" };
  if (u.includes("spain/laliga") || u.includes("primera-division")) return { name: "La Liga", code: "LALIGA", country: "Spain" };
  if (u.includes("italy/serie-a")) return { name: "Serie A", code: "SERIEA", country: "Italy" };
  if (u.includes("germany/bundesliga")) return { name: "Bundesliga", code: "BUNDESLIGA", country: "Germany" };
  if (u.includes("france/ligue-1")) return { name: "Ligue 1", code: "LIGUE1", country: "France" };
  if (u.includes("champions-league")) return { name: "UEFA Champions League", code: "UCL", country: "Europe" };
  if (u.includes("europa-league")) return { name: "UEFA Europa League", code: "UEL", country: "Europe" };
  return { name: "Football", code: "FOOT", country: "Unknown" };
};

const getCurrentSeason = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return month >= 8 ? `${year}-${String(year + 1).slice(2)}` : `${year - 1}-${String(year).slice(2)}`;
};

const isSoccerwayTickerContent = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  // The global live-ticker header is a distinctive phrase that only appears in the widget
  return normalized.includes("all live full-time scheduled today");
};

/**
 * Parse the Soccerway global live-ticker widget text into grouped markdown tables.
 *
 * Ticker structure (competition header only appears once per group):
 *   League Name
 *   COUNTRY
 *   Home Team         ← repeated for each match in the group
 *   Away Team
 *   HH:MM | FT | X-Y  ← time/score anchor
 *   [ANALYSIS]         ← optional label
 *   odds-1             ← home-win (European decimal OR American moneyline OR "-")
 *   odds-2             ← draw
 *   odds-3             ← away-win
 *   (next Home Team without repeating league/country header)
 *   ...
 */
const parseSoccerwayTicker = (raw: string): string => {
  const HEADER_NOISE = new Set(["all", "live", "full-time", "scheduled", "today"]);
  const isTimeOrScore = (s: string) =>
    /^\d{1,2}:\d{2}$/.test(s) || /^(\d+[-–]\d+|ft|ht|aet|pen)$/i.test(s);
  // European decimal (2.50), American moneyline (+150 / -250), no-odds placeholder (-)
  const isOdd = (s: string) =>
    /^\d+\.\d{2}$/.test(s) || /^[+-]\d{2,4}$/.test(s) || s === "-";

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !HEADER_NOISE.has(l.toLowerCase()));

  interface TickerRow {
    league: string;
    country: string;
    home: string;
    away: string;
    time: string;
    h: string;
    d: string;
    a: string;
  }

  const matches: TickerRow[] = [];
  let lastLeague = "Unknown";
  let lastCountry = "Unknown";
  // Index of the first line available after the previous match's odds were consumed.
  // Used to find the gap lines that contain a new competition header.
  let nextLineAfterLastMatch = 0;

  for (let i = 0; i < lines.length; i++) {
    if (i < 2 || !isTimeOrScore(lines[i])) continue;

    const time = lines[i];
    const away = lines[i - 1];
    const home = lines[i - 2];

    // Lines between the end of the previous match's odds and the current home team.
    // If ≥ 2 gap lines exist the last two are the competition header (league, country).
    // If the gap is empty the current match continues the same competition group.
    const gapLines = lines.slice(nextLineAfterLastMatch, i - 2);
    let league: string;
    let country: string;
    if (gapLines.length >= 2) {
      league  = gapLines[gapLines.length - 2];
      country = gapLines[gapLines.length - 1];
      lastLeague  = league;
      lastCountry = country;
    } else {
      league  = lastLeague;
      country = lastCountry;
    }

    // Advance past optional ANALYSIS label, then collect up to 3 odds
    let j = i + 1;
    if (j < lines.length && lines[j].toLowerCase() === "analysis") j++;
    const odds: string[] = [];
    while (j < lines.length && isOdd(lines[j]) && odds.length < 3) {
      odds.push(lines[j++]);
    }
    nextLineAfterLastMatch = j;

    matches.push({
      league,
      country,
      home,
      away,
      time,
      h: odds[0] ?? "-",
      d: odds[1] ?? "-",
      a: odds[2] ?? "-",
    });

    // Skip past consumed odds so they are not re-evaluated as times
    i = j - 1;
  }

  if (matches.length === 0) return "";

  // Group by league and emit one section per competition for cleaner markdown
  const byLeague = new Map<string, TickerRow[]>();
  for (const m of matches) {
    if (!byLeague.has(m.league)) byLeague.set(m.league, []);
    byLeague.get(m.league)!.push(m);
  }

  const parts: string[] = ["## Global Match Schedule / Live Scores"];
  for (const [leagueName, leagueMatches] of byLeague) {
    const country = leagueMatches[0].country;
    parts.push(`\n### ${leagueName} — ${country}`);
    parts.push("| Home | Away | Time / Score | 1 | X | 2 |");
    parts.push("|------|------|:------------:|:-:|:-:|:-:|");
    for (const m of leagueMatches) {
      parts.push(`| ${m.home} | ${m.away} | ${m.time} | ${m.h} | ${m.d} | ${m.a} |`);
    }
  }

  return parts.join("\n");
};

export const scrapPage = async (url: string, type: SourceType): Promise<string> => {
  if (type === "html") {
    try {
      // Determine if this is a stats site that needs extra time
      const isStats = isStatsSite(url);
      const isFootyStats = url.includes("footystats.org");
      const isSoccerwayFixturesOrResults = isSoccerwayFixturesOrResultsUrl(url);

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
          waitUntil: isStats ? "networkidle2" : "domcontentloaded",
          timeout: 60000, // Increase timeout to 60 seconds
        },
        evaluate: async (page, browser) => {
          // For stats sites, wait for content to load
          if (isStats) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }

          // For FootyStats calendar pages, grab current/next/previous week fixtures
          if (isFootyStats) {
            const calendarText = await evaluateFootyStatsCalendar(page, browser);
            if (calendarText) {
              return calendarText;
            }
          }

          // For Soccerway fixtures/results pages, extract match data using the
          // current Flashscore-style layout and format as plain text records for RAG.
          if (isSoccerwayFixturesOrResults) {
            const leagueInfo = detectLeagueFromUrl(url);
            const season = getCurrentSeason();
            const isResults = url.includes("/results/");

            const soccerwayText = await page.evaluate(
              (league, leagueSeason, isResultsPage) => {
                // tsx/esbuild may inject __name(...) helpers into transpiled functions.
                // Provide a browser-global no-op shim so injected calls can resolve.
                if (typeof (globalThis as { __name?: (target: unknown, value?: string) => unknown }).__name !== "function") {
                  (globalThis as { __name?: (target: unknown, value?: string) => unknown }).__name = (
                    target: unknown,
                  ) => target;
                }
                const t = (el: Element | null): string =>
                  el ? (el.textContent?.trim() ?? "") : "";
                const slug = (name: string): string =>
                  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                const toReportUrl = (href: string | null): string | null => {
                  if (!href) return null;
                  try {
                    const u = new URL(href);
                    if (!u.pathname.includes("/match/")) return null;
                    return `${u.origin}${u.pathname.replace(/\/$/, "")}/report/`;
                  } catch { return null; }
                };
                const toLineupsUrl = (href: string | null): string | null => {
                  if (!href) return null;
                  try {
                    const u = new URL(href);
                    if (!u.pathname.includes("/match/")) return null;
                    return `${u.origin}${u.pathname.replace(/\/$/, "")}/summary/lineups/`;
                  } catch { return null; }
                };

                interface MatchRow {
                  round: string | null;
                  date: string | null;
                  timeOrStatus: string;
                  home: string;
                  away: string;
                  scoreOrKickoff: string;
                  matchUrl: string | null;
                  reportUrl: string | null;
                  lineupsUrl: string | null;
                }
                const rows: MatchRow[] = [];

                // --- Current Flashscore-style layout (.event__match) ---
                const eventItems = Array.from(
                  document.querySelectorAll(".event__round, .event__match"),
                );
                let currentRound: string | null = null;
                for (const item of eventItems) {
                  if (item.classList.contains("event__round")) {
                    currentRound = t(item) || null;
                    continue;
                  }
                  if (!item.classList.contains("event__match")) continue;
                  const home = t(item.querySelector(".event__homeParticipant"));
                  const away = t(item.querySelector(".event__awayParticipant"));
                  if (!home || !away) continue;
                  const timeEl = item.querySelector(".event__time");
                  const scoreHome = t(item.querySelector(".event__score--home"));
                  const scoreAway = t(item.querySelector(".event__score--away"));
                  const isDash = (v: string) => !v || /^[-–]+$/.test(v);
                  const scoreOrKickoff =
                    !isDash(scoreHome) || !isDash(scoreAway)
                      ? `${scoreHome} - ${scoreAway}`
                      : t(timeEl);
                  const linkEl = item.querySelector(
                    "a.eventRowLink, a[href*='/match/'], a",
                  );
                  const matchHref = linkEl ? (linkEl as HTMLAnchorElement).href : null;
                  const dateMatch = t(timeEl).match(/\d{2}\.\d{2}\./);
                  rows.push({
                    round: currentRound,
                    date: dateMatch ? dateMatch[0] : null,
                    timeOrStatus: t(timeEl),
                    home,
                    away,
                    scoreOrKickoff,
                    matchUrl: matchHref,
                    reportUrl: toReportUrl(matchHref),
                    lineupsUrl: toLineupsUrl(matchHref),
                  });
                }

                // --- Legacy table fallback ---
                if (rows.length === 0) {
                  const allTables = Array.from(document.querySelectorAll("table"));
                  const validTables = allTables.filter(
                    (tbl) =>
                      tbl.className.includes("matches") ||
                      !!tbl.closest(".matches") ||
                      tbl.querySelectorAll("tr").length >= 3,
                  );
                  let currentDate: string | null = null;
                  for (const table of validTables.slice(0, 3)) {
                    for (const tr of Array.from(table.querySelectorAll("tr"))) {
                      const tds = Array.from(tr.querySelectorAll("td"));
                      const cls = tr.className || "";
                      if (
                        cls.includes("date") ||
                        (tds.length === 1 && cls.includes("group"))
                      ) {
                        currentDate = t(tds[0]);
                        continue;
                      }
                      if (tds.length < 3) continue;
                      const homeTd = tr.querySelector("td.team-a, td.team_a");
                      const awayTd = tr.querySelector("td.team-b, td.team_b");
                      const scoreTd = tr.querySelector(
                        "td.score-time, td.score_time, td.score",
                      );
                      const linkEl =
                        (scoreTd && scoreTd.querySelector("a")) ||
                        tr.querySelector("a");
                      const home = t(homeTd) || t(tds[1]);
                      const away =
                        t(awayTd) || (tds.length >= 4 ? t(tds[3]) : "");
                      if (!home || !away) continue;
                      const matchHref = linkEl
                        ? (linkEl as HTMLAnchorElement).href
                        : null;
                      rows.push({
                        round: null,
                        date: currentDate,
                        timeOrStatus: t(tds[0]),
                        home,
                        away,
                        scoreOrKickoff: t(scoreTd) || "",
                        matchUrl: matchHref,
                        reportUrl: toReportUrl(matchHref),
                        lineupsUrl: toLineupsUrl(matchHref),
                      });
                    }
                  }
                }

                // Dedupe by home+away+matchUrl
                const seen = new Set<string>();
                const deduped = rows.filter((r) => {
                  const key = `${r.matchUrl || ""}|${r.home}|${r.away}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });

                if (deduped.length === 0) return "";

                // Format as self-contained plain text records optimised for RAG embedding
                const recType = isResultsPage ? "MATCH_RESULT" : "MATCH_FIXTURE";
                const prefix = isResultsPage ? "MR" : "MF";
                const records: string[] = [];
                let idx = 1;

                for (const row of deduped) {
                  const id = `${prefix}-${league.code}-${idx++}`;
                  const lines = [
                    `### ${id} ${recType}`,
                    `League: ${league.name}`,
                    `Country: ${league.country}`,
                    `Season: ${leagueSeason}`,
                  ];
                  if (row.round) lines.push(`Round: ${row.round}`);
                  if (row.date) lines.push(`Date: ${row.date}`);
                  lines.push(`Teams: ${row.home} vs ${row.away}`);
                  if (isResultsPage && row.scoreOrKickoff) {
                    lines.push(`Score: ${row.scoreOrKickoff}`);
                  } else {
                    lines.push(`Kickoff: ${row.timeOrStatus || "TBC"}`);
                  }
                  if (row.matchUrl) lines.push(`matchUrl: ${row.matchUrl}`);
                  if (row.reportUrl) lines.push(`reportUrl: ${row.reportUrl}`);
                  if (row.lineupsUrl) lines.push(`lineupsUrl: ${row.lineupsUrl}`);
                  lines.push(
                    `Tags: #league/${slug(league.name)} #team/${slug(row.home)} #team/${slug(row.away)} #season/${leagueSeason} #type/${isResultsPage ? "result" : "fixture"}`,
                  );
                  lines.push(
                    `Keywords: ${row.home} ${row.away} ${league.name} ${isResultsPage ? `result ${row.scoreOrKickoff}` : "fixture upcoming"} ${row.round || ""} ${leagueSeason}`,
                  );
                  records.push(lines.join("\n"));
                }

                return records.join("\n\n");
              },
              leagueInfo,
              season,
              isResults,
            );
            if (soccerwayText && soccerwayText.trim().length > 0) {
              await browser.close();
              return soccerwayText;
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
      // Fixtures/results pages: if their specific extractor failed and we got the
      // ticker instead, discard (the record-format handler already returned early).
      if (isSoccerwayFixturesOrResults && isLikelySoccerwayTickerOnlyText(cleaned)) return "";
      // Any other Soccerway page (news, standings, etc.) that returned the global
      // live-ticker widget: convert it to a structured markdown table instead of
      // embedding raw noise text.
      if (url.includes("soccerway.com") && isSoccerwayTickerContent(cleaned)) {
        const table = parseSoccerwayTicker(cleaned);
        return table || "";
      }
      return cleaned;
    } catch (error) {
      console.error(`Scraping error for ${url}:`, error);
      return "";
    }
  }
  return "";
};

export const scrapeSoccerwayFormPage = async (
  url: string,
  meta: { formMode: string; formMatches: number },
): Promise<string> => {
  try {
    const leagueInfo = detectLeagueFromUrl(url);
    const season = getCurrentSeason();

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
        waitUntil: "domcontentloaded",
        timeout: 60000,
      },
      evaluate: async (page, browser) => {
        // Hash-routed SPA – wait for the standings table to render
        try {
          await page.waitForSelector(".tableWrapper", { timeout: 25000 });
          // Extra settle time for all rows to populate
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch {
          await browser.close();
          return "";
        }

        const text = await page.evaluate(
          (league, leagueSeason, formMode, formMatches) => {
            // tsx/esbuild may inject __name(...) helpers into transpiled functions.
            if (typeof (globalThis as { __name?: (target: unknown, value?: string) => unknown }).__name !== "function") {
              (globalThis as { __name?: (target: unknown, value?: string) => unknown }).__name = (
                target: unknown,
              ) => target;
            }
            const t = (el: Element | null): string =>
              el ? (el.textContent?.trim() ?? "") : "";
            const toInt = (s: string): number | null => {
              const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
              return isNaN(n) ? null : n;
            };
            const slug = (name: string): string =>
              name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

            const pageLeague = t(document.querySelector(".headerLeague__title-text"));
            const pageCountry = t(document.querySelector(".headerLeague__category-text"));
            const leagueName = pageLeague || league.name;
            const country = pageCountry || league.country;

            const typeCode =
              formMode === "home" ? "TFH" : formMode === "away" ? "TFA" : "TF";
            const typeLabel =
              formMode === "home"
                ? "TEAM_FORM_HOME"
                : formMode === "away"
                  ? "TEAM_FORM_AWAY"
                  : "TEAM_FORM";
            const modeLabel =
              formMode === "home" ? "Home" : formMode === "away" ? "Away" : "Overall";

            const rows = Array.from(
              document.querySelectorAll(".tableWrapper .ui-table__row"),
            );
            if (rows.length === 0) return "";

            const records: string[] = [];
            let idx = 1;

            for (const row of rows) {
              const rank = toInt(t(row.querySelector(".tableCellRank")));
              const teamEl = row.querySelector(
                ".tableCellParticipant__name a, .tableCellParticipant__name",
              );
              const team = t(teamEl);
              const teamUrl =
                teamEl instanceof HTMLAnchorElement ? teamEl.href : null;
              if (!team || rank === null) continue;

              const valueCells = Array.from(
                row.querySelectorAll(".table__cell--value"),
              );
              const mp = toInt(t(valueCells[0]));
              const wins = toInt(t(valueCells[1]));
              const draws = toInt(t(valueCells[2]));
              const losses = toInt(t(valueCells[3]));
              const goals = t(row.querySelector(".table__cell--score"));
              const goalDiff = toInt(
                t(row.querySelector(".table__cell--goalsForAgainstDiff")),
              );
              const points = toInt(t(row.querySelector(".table__cell--points")));
              const formResults = Array.from(
                row.querySelectorAll(
                  ".table__cell--form .wcl-badgeform_AKaAR span, .table__cell--form span",
                ),
              )
                .map((el) => t(el))
                .filter(Boolean)
                .join(" ");

              const id = `${typeCode}-${league.code}-${idx++}`;
              const lines = [
                `### ${id} ${typeLabel}_${formMatches}`,
                `League: ${leagueName}`,
                `Country: ${country}`,
                `Mode: ${modeLabel} | Last ${formMatches} Matches`,
                `Season: ${leagueSeason}`,
                `Rank: ${rank}`,
                `Team: ${team}`,
              ];
              if (teamUrl) lines.push(`teamUrl: ${teamUrl}`);
              if (mp !== null)
                lines.push(
                  `Played: ${mp} | Wins: ${wins ?? 0} | Draws: ${draws ?? 0} | Losses: ${losses ?? 0}`,
                );
              if (goals) lines.push(`Goals: ${goals}`);
              if (goalDiff !== null)
                lines.push(`GoalDiff: ${goalDiff >= 0 ? "+" : ""}${goalDiff}`);
              if (points !== null) lines.push(`Points: ${points}`);
              if (formResults) lines.push(`Form: ${formResults}`);
              lines.push(
                `Tags: #league/${slug(leagueName)} #team/${slug(team)} #season/${leagueSeason} #type/form-${formMode} #form-matches/${formMatches}`,
              );
              lines.push(
                `Keywords: ${team} ${leagueName} ${modeLabel.toLowerCase()} form ${formMatches} matches standings wins points ${leagueSeason}`,
              );
              records.push(lines.join("\n"));
            }

            return records.join("\n\n");
          },
          leagueInfo,
          season,
          meta.formMode,
          meta.formMatches,
        );

        await browser.close();
        return text;
      },
    });

    const raw = (await loader.scrape()) ?? "";
    return raw.trim();
  } catch (error) {
    console.error(`Soccerway form table scraping error for ${url}:`, error);
    return "";
  }
};

/**
 * Scrape starting lineups from a Soccerway match lineups page.
 * Uses the Flashscore-style selectors from the user's standalone scraper.
 * Formats each match as a self-contained MATCH_LINEUPS plain text record.
 */
export const scrapeSoccerwayLineupsPage = async (url: string): Promise<string> => {
  try {
    const leagueInfo = detectLeagueFromUrl(url);
    const season = getCurrentSeason();

    // Extract team slugs from the URL path:
    // e.g. /matches/2026/02/20/england/premier-league/arsenal-fc/chelsea-fc/4278523/summary/lineups/
    const pathParts = url.split("/").filter(Boolean);
    const lineupsIdx = pathParts.indexOf("lineups");
    const matchId = lineupsIdx >= 2 ? pathParts[lineupsIdx - 2] : "";
    const awaySlugRaw = lineupsIdx >= 3 ? pathParts[lineupsIdx - 3] : "";
    const homeSlugRaw = lineupsIdx >= 4 ? pathParts[lineupsIdx - 4] : "";
    const homeFromUrl = homeSlugRaw.replace(/-/g, " ").replace(/\bfc\b/gi, "FC").trim();
    const awayFromUrl = awaySlugRaw.replace(/-/g, " ").replace(/\bfc\b/gi, "FC").trim();

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
        waitUntil: "domcontentloaded",
        timeout: 60000,
      },
      evaluate: async (page, browser) => {
        // Wait for the lineups panel to appear
        try {
          await page.waitForSelector(".lf__sides, [data-testid='wcl-lineupsParticipantGeneral-left']", {
            timeout: 20000,
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
        } catch {
          await browser.close();
          return "";
        }

        const text = await page.evaluate(
          (league, leagueSeason, homeTeam, awayTeam, matchUrl, lineupsUrlStr) => {
            // tsx/esbuild may inject __name(...) helpers into transpiled functions.
            if (typeof (globalThis as { __name?: (target: unknown, value?: string) => unknown }).__name !== "function") {
              (globalThis as { __name?: (target: unknown, value?: string) => unknown }).__name = (
                target: unknown,
              ) => target;
            }
            const t = (el: Element | null): string =>
              el ? (el.textContent?.trim() ?? "") : "";
            const slug = (name: string): string =>
              name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

            interface Participant {
              number: string | null;
              name: string | null;
              country: string | null;
              role: string | null;
              incidents: string[];
            }

            const parseParticipant = (root: Element): Participant => {
              const number = t(root.querySelector(".wcl-number_lTBFk")) || null;
              const name = t(root.querySelector(".wcl-name_ZggyJ")) || null;
              const countryImg = root.querySelector("img[title]");
              const role = t(root.querySelector(".wcl-roles_GB-m2")) || null;
              const incidents = Array.from(
                root.querySelectorAll("[data-testid='wcl-incident-badge'] svg"),
              )
                .map((svg) => svg.getAttribute("data-testid"))
                .filter((v): v is string => Boolean(v));
              return {
                number,
                name,
                country: countryImg ? countryImg.getAttribute("title") : null,
                role,
                incidents,
              };
            };

            const leftEls = Array.from(
              document.querySelectorAll(
                "[data-testid='wcl-lineupsParticipantGeneral-left']",
              ),
            );
            const rightEls = Array.from(
              document.querySelectorAll(
                "[data-testid='wcl-lineupsParticipantGeneral-right']",
              ),
            );

            const left = leftEls.map(parseParticipant).filter((p) => p.name);
            const right = rightEls.map(parseParticipant).filter((p) => p.name);

            if (left.length === 0 && right.length === 0) return "";

            // Try to read team names from the page scoreboard
            const scoreboardHome =
              t(document.querySelector(".participant--home .wcl-simpleText_CkXGm")) ||
              t(document.querySelector(".duelParticipant__home .participant__participantName")) ||
              homeTeam;
            const scoreboardAway =
              t(document.querySelector(".participant--away .wcl-simpleText_CkXGm")) ||
              t(document.querySelector(".duelParticipant__away .participant__participantName")) ||
              awayTeam;

            const formatPlayer = (p: Participant): string => {
              const parts: string[] = [];
              if (p.number) parts.push(`#${p.number}`);
              if (p.name) parts.push(p.name);
              const meta: string[] = [];
              if (p.role) meta.push(p.role);
              if (p.country) meta.push(p.country);
              if (p.incidents.length) meta.push(p.incidents.join(","));
              if (meta.length) parts.push(`(${meta.join(", ")})`);
              return parts.join(" ");
            };

            const lines = [
              `### LU-${league.code}-${matchUrl} MATCH_LINEUPS`,
              `League: ${league.name}`,
              `Country: ${league.country}`,
              `Season: ${leagueSeason}`,
              `Home: ${scoreboardHome}`,
              `Away: ${scoreboardAway}`,
              `lineupsUrl: ${lineupsUrlStr}`,
            ];

            if (left.length > 0) {
              lines.push(`Home Starting XI:`);
              left.forEach((p) => lines.push(`  ${formatPlayer(p)}`));
            }
            if (right.length > 0) {
              lines.push(`Away Starting XI:`);
              right.forEach((p) => lines.push(`  ${formatPlayer(p)}`));
            }

            lines.push(
              `Tags: #league/${slug(league.name)} #team/${slug(scoreboardHome)} #team/${slug(scoreboardAway)} #season/${leagueSeason} #type/lineups`,
            );
            lines.push(
              `Keywords: ${scoreboardHome} ${scoreboardAway} ${league.name} starting lineup XI formation ${leagueSeason}`,
            );

            return lines.join("\n");
          },
          leagueInfo,
          season,
          homeFromUrl,
          awayFromUrl,
          matchId,
          url,
        );

        await browser.close();
        return text;
      },
    });

    const raw = (await loader.scrape()) ?? "";
    return raw.trim();
  } catch (error) {
    console.error(`Soccerway lineups scraping error for ${url}:`, error);
    return "";
  }
};

// ── Understat API scraper ─────────────────────────────────────────────────────
// Fetches JSON directly from understat.com/getLeagueData instead of scraping HTML.
// Produces three RAG-optimised markdown sections: league table, player stats, fixtures.

const UNDERSTAT_LEAGUE_DISPLAY: Record<string, string> = {
  EPL:        'Premier League',
  La_liga:    'La Liga',
  Serie_A:    'Serie A',
  Ligue_1:    'Ligue 1',
  Bundesliga: 'Bundesliga',
};

const UNDERSTAT_HEADERS: Record<string, string> = {
  'User-Agent':       'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':           'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
};

interface UnderstatMatchHistory {
  wins?:          string | number;
  draws?:         string | number;
  loses?:         string | number;
  scored?:        string | number;
  missed?:        string | number;
  pts?:           string | number;
  xG?:            string | number;
  xGA?:           string | number;
  xpts?:          string | number;
  ppda?:          { att?: string | number; def?: string | number } | unknown;
  ppda_allowed?:  { att?: string | number; def?: string | number } | unknown;
}
interface UnderstatTeam    { title?: string; history?: UnderstatMatchHistory[]; }
interface UnderstatPlayer  { player_name?: string; team_title?: string; games?: string | number; time?: string | number; goals?: string | number; assists?: string | number; xG?: string | number; xA?: string | number; }
interface UnderstatGoals   { h?: number | null; a?: number | null; }
interface UnderstatFixture { datetime?: string; h?: { title?: string }; a?: { title?: string }; goals?: UnderstatGoals; xG?: UnderstatGoals; isResult?: boolean | number | string; }
interface UnderstatApiResponse { teams?: Record<string, UnderstatTeam>; players?: UnderstatPlayer[]; dates?: UnderstatFixture[]; }

interface UStatTeamRow { Team: string; MP: number; W: number; D: number; L: number; GF: number; GA: number; GD: number; Pts: number; xG: number; xGA: number; xGD: number; xPts: number; dPts: number; }
interface UStatFixtureRow { dt: Date; isResult: boolean; home: string; away: string; hg: string | null; ag: string | null; hxg: string | null; axg: string | null; monthKey: string; weekKey: string; isoYear: number; isoWeek: number; dateStr: string; timeStr: string; }

const uSgn = (v: number): string => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
const uF2  = (v: string | number | undefined): string => { const n = parseFloat(String(v ?? 0)); return isNaN(n) ? '0.00' : n.toFixed(2); };
const uFmtXg  = (v: string | number | null | undefined): string => { const n = parseFloat(String(v ?? '')); return isNaN(n) ? '–' : n.toFixed(2); };
const uFmtXgd = (h: string | number | null | undefined, a: string | number | null | undefined): string => {
  const d = parseFloat(String(h ?? '')) - parseFloat(String(a ?? ''));
  return isNaN(d) ? '–' : d >= 0 ? `+${d.toFixed(2)}` : d.toFixed(2);
};
const uResult = (hg: string | number | null | undefined, ag: string | number | null | undefined): string => {
  const h = parseInt(String(hg ?? ''), 10), a = parseInt(String(ag ?? ''), 10);
  return (isNaN(h) || isNaN(a)) ? '–' : h > a ? 'H' : h < a ? 'A' : 'D';
};

const USTAT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const USTAT_MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const USTAT_MONTHS_F = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const uParseDt = (s: string): Date => new Date(s.replace(' ', 'T') + 'Z');
const uFmtDate = (dt: Date): string =>
  `${USTAT_WEEKDAYS[dt.getUTCDay()]} ${String(dt.getUTCDate()).padStart(2,'0')} ${USTAT_MONTHS_S[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
const uFmtTime = (dt: Date): string =>
  `${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;

function uGetISOWeek(dt: Date): [number, number] {
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return [d.getUTCFullYear(), Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)];
}

function uWeekRangeStr(isoYear: number, isoWeek: number): string {
  try {
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const dow  = jan4.getUTCDay() || 7;
    const mon  = new Date(jan4);
    mon.setUTCDate(jan4.getUTCDate() - (dow - 1) + (isoWeek - 1) * 7);
    const sun  = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const ms = USTAT_MONTHS_S;
    if (mon.getUTCFullYear() === sun.getUTCFullYear()) {
      if (mon.getUTCMonth() === sun.getUTCMonth())
        return `${mon.getUTCDate()}–${sun.getUTCDate()} ${ms[mon.getUTCMonth()]} ${mon.getUTCFullYear()}`;
      return `${mon.getUTCDate()} ${ms[mon.getUTCMonth()]} – ${sun.getUTCDate()} ${ms[sun.getUTCMonth()]} ${sun.getUTCFullYear()}`;
    }
    return `${mon.getUTCDate()} ${ms[mon.getUTCMonth()]} ${mon.getUTCFullYear()} – ${sun.getUTCDate()} ${ms[sun.getUTCMonth()]} ${sun.getUTCFullYear()}`;
  } catch { return `Week ${isoWeek}`; }
}

function uAggregateTeam(history: UnderstatMatchHistory[]): Omit<UStatTeamRow, 'Team'> {
  let m=0,w=0,d=0,l=0,g=0,ga=0,pts=0,xg=0,xga=0,xpts=0,paAtt=0,paDef=0,opaAtt=0,opaDef=0;
  for (const h of history) {
    m++;
    w    += parseInt(String(h.wins   ?? 0), 10);
    d    += parseInt(String(h.draws  ?? 0), 10);
    l    += parseInt(String(h.loses  ?? 0), 10);
    g    += parseInt(String(h.scored ?? 0), 10);
    ga   += parseInt(String(h.missed ?? 0), 10);
    pts  += parseInt(String(h.pts    ?? 0), 10);
    xg   += parseFloat(String(h.xG   ?? 0));
    xga  += parseFloat(String(h.xGA  ?? 0));
    xpts += parseFloat(String(h.xpts ?? 0));
    const p  = h.ppda         as { att?: number; def?: number } | null;
    const pa = h.ppda_allowed as { att?: number; def?: number } | null;
    if (p  && typeof p  === 'object') { paAtt  += parseInt(String(p.att  ?? 0), 10); paDef  += parseInt(String(p.def  ?? 0), 10); }
    if (pa && typeof pa === 'object') { opaAtt += parseInt(String(pa.att ?? 0), 10); opaDef += parseInt(String(pa.def ?? 0), 10); }
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return { MP:m, W:w, D:d, L:l, GF:g, GA:ga, GD:g-ga, Pts:pts, xG:r(xg), xGA:r(xga), xGD:r(xg-xga), xPts:r(xpts), dPts:r(pts-xpts) };
}

function uBuildTableMd(teams: Record<string, UnderstatTeam>, league: string, year: number): string {
  const rows: UStatTeamRow[] = Object.entries(teams).map(([id, t]) => ({
    ...uAggregateTeam(t.history ?? []), Team: t.title ?? id,
  }));
  rows.sort((a,b) => b.Pts-a.Pts || b.GD-a.GD || b.GF-a.GF);
  const season  = `${year}/${String(year+1).slice(-2)}`;
  const title   = UNDERSTAT_LEAGUE_DISPLAY[league] ?? league;
  const url     = `https://understat.com/league/${league}/${year}`;
  const totalMp = rows.length ? Math.max(...rows.map(r=>r.MP)) : 0;

  const lines = [
    `# ${title} · ${season} · League Table`,
    '',
    `> **Type:** League standings  |  **League:** ${title}  |  **Season:** ${season}  |  **Matchday:** ~${totalMp}  |  **Source:** ${url}`,
    '',
    '## Column Key',
    '| Column | Description |',
    '|:-------|:------------|',
    '| MP | Matches played |',
    '| W / D / L | Wins / Draws / Losses |',
    '| GF / GA | Goals for / against |',
    '| GD | Goal difference |',
    '| Pts | League points |',
    '| xG | Expected goals scored |',
    '| xGA | Expected goals conceded |',
    '| xGD | Expected goal difference (xG − xGA) |',
    '| xPts | Expected points (xG model) |',
    '| Pts−xPts | Points over/under expectation (luck/efficiency) |',
    '',
    '## Standings',
    '',
    '| Pos | Team | MP | W | D | L | GF | GA | GD | Pts | xG | xGA | xGD | xPts | Pts−xPts |',
    '|----:|:-----|--:|--:|--:|--:|---:|---:|---:|----:|---:|----:|----:|-----:|---------:|',
  ];
  for (let i=0; i<rows.length; i++) {
    const r = rows[i];
    lines.push(`| ${i+1} | ${r.Team} | ${r.MP} | ${r.W} | ${r.D} | ${r.L} | ${r.GF} | ${r.GA} | ${r.GD>=0?'+':''}${r.GD} | ${r.Pts} | ${r.xG} | ${r.xGA} | ${uSgn(r.xGD)} | ${r.xPts} | ${uSgn(r.dPts)} |`);
  }
  if (rows.length > 0) {
    const leader = rows[0], bottom = rows[rows.length-1];
    const byDelta = [...rows].sort((a,b)=>b.dPts-a.dPts);
    const over  = byDelta.slice(0,3).map(r=>`${r.Team} (${uSgn(r.dPts)})`);
    const under = byDelta.slice(-3).reverse().map(r=>`${r.Team} (${uSgn(r.dPts)})`);
    lines.push('','## Summary','',
      `- **Leader:** ${leader.Team} — ${leader.Pts} pts from ${leader.MP} matches (xPts: ${leader.xPts}, Pts−xPts: ${uSgn(leader.dPts)})`,
      `- **Bottom:** ${bottom.Team} — ${bottom.Pts} pts from ${bottom.MP} matches`,
      `- **Most overperforming xPts:** ${over.join(', ')}`,
      `- **Most underperforming xPts:** ${under.join(', ')}`,
    );
  }
  lines.push('', `*Data: ${url}*`);
  return lines.join('\n') + '\n';
}

function uBuildPlayersMd(players: UnderstatPlayer[], league: string, year: number): string {
  const MAX = 50;
  const ps  = players.slice(0, MAX);
  const season = `${year}/${String(year+1).slice(-2)}`;
  const title  = UNDERSTAT_LEAGUE_DISPLAY[league] ?? league;
  const url    = `https://understat.com/league/${league}/${year}`;

  const lines = [
    `# ${title} · ${season} · Player Statistics (Top ${ps.length})`,
    '',
    `> **Type:** Player stats  |  **League:** ${title}  |  **Season:** ${season}  |  **Showing:** top ${ps.length} of ${players.length}  |  **Ranked by:** goals  |  **Source:** ${url}`,
    '',
    '## Column Key',
    '| Column | Description |',
    '|:-------|:------------|',
    '| Apps | Appearances |',
    '| Min | Minutes played |',
    '| G | Goals |',
    '| A | Assists |',
    '| G+A | Combined goal contributions |',
    '| xG | Expected goals |',
    '| xA | Expected assists |',
    '| G−xG | Goals minus xG (finishing efficiency; positive = overperforming) |',
    '| xG90 | Expected goals per 90 min |',
    '| xA90 | Expected assists per 90 min |',
    '',
    '## Rankings',
    '',
    '| # | Player | Team | Apps | Min | G | A | G+A | xG | xA | G−xG | xG90 | xA90 |',
    '|--:|:-------|:-----|-----:|----:|--:|--:|----:|---:|---:|-----:|-----:|-----:|',
  ];
  for (let i=0; i<ps.length; i++) {
    const p     = ps[i];
    const apps  = parseInt(String(p.games   ?? 0), 10);
    const mins  = parseInt(String(parseFloat(String(p.time ?? 0))), 10);
    const goals = parseInt(String(p.goals   ?? 0), 10);
    const assts = parseInt(String(p.assists ?? 0), 10);
    const xg    = Math.round(parseFloat(String(p.xG ?? 0)) * 100) / 100;
    const xa    = Math.round(parseFloat(String(p.xA ?? 0)) * 100) / 100;
    const gXg   = Math.round((goals - xg) * 100) / 100;
    const xg90  = mins > 0 ? Math.round(xg / mins * 90 * 100) / 100 : 0;
    const xa90  = mins > 0 ? Math.round(xa / mins * 90 * 100) / 100 : 0;
    lines.push(`| ${i+1} | ${p.player_name??''} | ${p.team_title??''} | ${apps} | ${mins} | ${goals} | ${assts} | ${goals+assts} | ${xg} | ${xa} | ${uSgn(gXg)} | ${xg90} | ${xa90} |`);
  }
  const top3g  = ps.slice(0,3);
  const top3xg = [...ps].sort((a,b)=>parseFloat(String(b.xG??0))-parseFloat(String(a.xG??0))).slice(0,3);
  const top3xa = [...ps].sort((a,b)=>parseFloat(String(b.xA??0))-parseFloat(String(a.xA??0))).slice(0,3);
  lines.push('','## Quick Reference','',
    '**Top scorers:** '  + top3g.map(p=>`${p.player_name} (${p.team_title}, ${p.goals}G)`).join(' | '),
    '**Highest xG:** '   + top3xg.map(p=>`${p.player_name} (${p.team_title}, ${uF2(p.xG)})`).join(' | '),
    '**Highest xA:** '   + top3xa.map(p=>`${p.player_name} (${p.team_title}, ${uF2(p.xA)})`).join(' | '),
    '', `*Data: ${url}*`,
  );
  return lines.join('\n') + '\n';
}

function uBuildFixturesMd(rawFixtures: UnderstatFixture[], league: string, year: number): string {
  const season = `${year}/${String(year+1).slice(-2)}`;
  const title  = UNDERSTAT_LEAGUE_DISPLAY[league] ?? league;
  const url    = `https://understat.com/league/${league}/${year}`;

  const fixtures: UStatFixtureRow[] = [];
  for (const f of rawFixtures) {
    if (!f.datetime) continue;
    const dt = uParseDt(f.datetime);
    if (isNaN(dt.getTime())) continue;
    const [isoYear, isoWeek] = uGetISOWeek(dt);
    const goals = f.goals ?? {};
    const xg    = f.xG   ?? {};
    fixtures.push({
      dt, isResult: Boolean(f.isResult),
      home: f.h?.title ?? '?', away: f.a?.title ?? '?',
      hg:  goals.h != null ? String(goals.h) : null,
      ag:  goals.a != null ? String(goals.a) : null,
      hxg: xg.h   != null ? String(xg.h)    : null,
      axg: xg.a   != null ? String(xg.a)    : null,
      monthKey: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}`,
      weekKey:  `${isoYear}-W${String(isoWeek).padStart(2,'0')}`,
      isoYear, isoWeek,
      dateStr: uFmtDate(dt), timeStr: uFmtTime(dt),
    });
  }
  fixtures.sort((a,b) => a.dt.getTime() - b.dt.getTime());
  const played   = fixtures.filter(f=>f.isResult).length;
  const unplayed = fixtures.length - played;

  const grouped: Record<string, Record<string, UStatFixtureRow[]>> = {};
  for (const fx of fixtures) {
    (grouped[fx.monthKey] ??= {})[fx.weekKey] ??= [];
    grouped[fx.monthKey][fx.weekKey].push(fx);
  }

  const lines = [
    `# ${title} · ${season} · Fixtures & Results`,
    '',
    `> **Type:** Fixture list  |  **League:** ${title}  |  **Season:** ${season}  |  **Total:** ${fixtures.length}  |  **Played:** ${played}  |  **Remaining:** ${unplayed}  |  **Source:** ${url}`,
    '',
    '## Column Key (played matches)',
    '| Column | Description |',
    '|:-------|:------------|',
    "| Res | H = home win, D = draw, A = away win |",
    '| HG / AG | Home / Away goals scored |',
    '| H-xG / A-xG | Expected goals |',
    '| xGD | xG difference (H-xG − A-xG) |',
    '',
    '---',
  ];

  for (const monthKey of Object.keys(grouped).sort()) {
    const [mYear, mMonth] = monthKey.split('-').map(Number);
    lines.push('', `## ${USTAT_MONTHS_F[mMonth-1]} ${mYear}`);
    for (const weekKey of Object.keys(grouped[monthKey]).sort()) {
      const wFx     = grouped[monthKey][weekKey];
      const {isoYear:iy, isoWeek:iw} = wFx[0];
      const wrange  = uWeekRangeStr(iy, iw);
      const wPlayed = wFx.filter(fx=>fx.isResult);
      const wAhead  = wFx.filter(fx=>!fx.isResult);
      lines.push('', `### ${title} ${season} — Week ${iw} · ${wrange}`, '');
      if (wPlayed.length) {
        lines.push(`**Played (${wPlayed.length} matches)**`,'',
          '| Date | Home | HG | AG | Away | Res | H-xG | A-xG | xGD |',
          '|:-----|:-----|---:|---:|:-----|:---:|-----:|-----:|----:|',
        );
        for (const fx of [...wPlayed].sort((a,b)=>a.dt.getTime()-b.dt.getTime())) {
          const res = uResult(fx.hg, fx.ag);
          lines.push(`| ${fx.dateStr} | ${fx.home} | ${fx.hg} | ${fx.ag} | ${fx.away} | **${res}** | ${uFmtXg(fx.hxg)} | ${uFmtXg(fx.axg)} | ${uFmtXgd(fx.hxg,fx.axg)} |`);
        }
        const narr = wPlayed.slice(0,6).map(fx => {
          const res = uResult(fx.hg, fx.ag);
          const w   = res==='H' ? fx.home : res==='A' ? fx.away : null;
          return w ? `${fx.home} ${fx.hg}–${fx.ag} ${fx.away} (${w} won)` : `${fx.home} ${fx.hg}–${fx.ag} ${fx.away} (draw)`;
        });
        if (narr.length) lines.push('', `> **${title} ${season} results this week:** ${narr.join(' | ')}`);
      }
      if (wAhead.length) {
        lines.push('', `**Upcoming (${wAhead.length} matches)**`,'',
          '| Date | Home | KO | Away |',
          '|:-----|:-----|:--:|:-----|',
        );
        for (const fx of [...wAhead].sort((a,b)=>a.dt.getTime()-b.dt.getTime())) {
          lines.push(`| ${fx.dateStr} | ${fx.home} | ${fx.timeStr} | ${fx.away} |`);
        }
      }
    }
  }
  lines.push('', '---', '', `*Data from ${url}*`);
  return lines.join('\n') + '\n';
}

/**
 * Scrape an Understat league page by calling the JSON API directly.
 * URL format: https://understat.com/league/{LEAGUE}/{YEAR}
 * Returns combined markdown: league table + top-50 players + fixtures/results.
 */
export const scrapeUnderstatPage = async (url: string): Promise<string> => {
  try {
    const urlMatch = url.match(/understat\.com\/league\/([^/?#]+)(?:\/(\d{4}))?/);
    if (!urlMatch) return '';
    const league = urlMatch[1];
    const now    = new Date();
    const defYear = now.getMonth() + 1 >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    const year   = urlMatch[2] ? parseInt(urlMatch[2], 10) : defYear;

    const apiUrl = `https://understat.com/getLeagueData/${league}/${year}`;
    console.log(`  📊 Understat API → ${apiUrl}`);
    const resp = await fetch(apiUrl, {
      headers: { ...UNDERSTAT_HEADERS, Referer: url },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json() as UnderstatApiResponse;

    const parts: string[] = [];

    const teamsData = data.teams ?? {};
    if (Object.keys(teamsData).length > 0) {
      parts.push(uBuildTableMd(teamsData, league, year));
    }
    const playersData = data.players ?? [];
    if (playersData.length > 0) {
      parts.push(uBuildPlayersMd(playersData, league, year));
    }
    const rawFixtures = data.dates ?? [];
    if (rawFixtures.length > 0) {
      parts.push(uBuildFixturesMd(rawFixtures, league, year));
    }

    const combined = parts.join('\n\n---\n\n');
    console.log(`  📊 Understat: ${Object.keys(teamsData).length} teams, ${playersData.length} players, ${rawFixtures.length} fixtures → ${combined.length} chars`);
    return combined;
  } catch (error) {
    console.error(`Understat API error for ${url}:`, error);
    return '';
  }
};

export const extractHtmlLinks = async (
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

export const filterBbcTeamLinks = (
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
