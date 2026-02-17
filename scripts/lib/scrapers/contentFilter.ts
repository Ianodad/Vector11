// Content validation & filtering
import { BOILERPLATE_PATTERNS } from "../config/constants.js";

export const isLowValueContent = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;

  // For stats/table content, be more lenient
  const hasNumbers = /\d+/.test(normalized);
  const hasStatsKeywords =
    /goal|assist|match|team|player|score|stat|table|league|position|points|win|draw|loss/.test(
      normalized,
    );

  if (hasNumbers && hasStatsKeywords && normalized.length >= 100) {
    return false; // Accept shorter stats content
  }

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

export const isAccessBlockedContent = (text: string): boolean => {
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
