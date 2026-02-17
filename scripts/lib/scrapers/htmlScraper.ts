// Puppeteer-based HTML scraping
import { PuppeteerWebBaseLoader } from "@langchain/community/document_loaders/web/puppeteer";
import { isAccessBlockedContent } from "./contentFilter.js";
import { isStatsSite } from "./evaluators/statsEvaluator.js";
import { evaluateFootyStatsCalendar } from "./evaluators/footyStatsEvaluator.js";
import { normalizeUrl, isBlocked, isLikelyHtml, matchesKeywords } from "../utils/helpers.js";
import { KEYWORDS } from "../config/constants.js";
import type { SourceType } from "../config/dataSources.js";

export const scrapPage = async (url: string, type: SourceType): Promise<string> => {
  if (type === "html") {
    try {
      // Determine if this is a stats site that needs extra time
      const isStats = isStatsSite(url);
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
  }
  return "";
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
