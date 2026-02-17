// RSS feed parsing & link extraction
import { XMLParser } from "fast-xml-parser";
import { normalizeUrl, isBlocked, isLikelyHtml, matchesKeywords } from "../utils/helpers.js";

export interface RssItem {
  title?: string;
  description?: string;
  summary?: string;
  link?: string | { "@_href"?: string };
}

export const extractRssLinks = async (
  url: string,
  fetchTimeoutMs: number,
): Promise<string[]> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
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
      if (!matchesKeywords(link, title)) return false;
      return true;
    })
    .map((entry) => entry.link as string);

  return Array.from(new Set<string>(links)).slice(0, 30);
};

export const normalizeRssLink = (link: RssItem["link"]): string | undefined => {
  if (!link) return undefined;
  if (typeof link === "string") return link;
  if (typeof link === "object") {
    const href = (link as { "@_href"?: string })["@_href"];
    return href;
  }
  return undefined;
};
