// URL normalization and utility functions
import { BLOCK_PATTERNS, KEYWORDS, BBC_TEAM_PATH } from "../config/constants.js";

export const normalizeUrl = (base: string, href: string): string | null => {
  try {
    return new URL(href, base).toString().split("#")[0];
  } catch {
    return null;
  }
};

export const isBlocked = (href: string | null | undefined): boolean => {
  const h = (href || "").toLowerCase().trim();
  return BLOCK_PATTERNS.some((pattern) => h.includes(pattern));
};

export const isLikelyHtml = (urlStr: string): boolean => {
  const u = urlStr.toLowerCase();
  if (u.endsWith(".xml") || u.endsWith(".json")) return false;
  if (u.includes("/api/")) return false;
  return true;
};

export const matchesKeywords = (urlStr: string, anchorText = ""): boolean => {
  const hay = `${urlStr} ${anchorText}`.toLowerCase();
  return KEYWORDS.some((keyword) => hay.includes(keyword));
};

export const isBbcTeamPage = (url: string): boolean =>
  url.toLowerCase().includes(BBC_TEAM_PATH);
