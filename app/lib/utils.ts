// Utility functions

export const pickRandomPrompts = (prompts: readonly string[], count: number): string[] => {
  const shuffled = [...prompts];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
};

export const extractText = (n: unknown): string => {
  if (!n || typeof n !== "object") return "";
  const obj = n as { value?: string; children?: unknown[] };
  if (typeof obj.value === "string") return obj.value;
  return (obj.children ?? []).map(extractText).join(" ");
};

export const detectTableType = (headerText: string): string => {
  if (/\bvs\b/i.test(headerText) || /\bVenue\b/i.test(headerText)) {
    return "fixture-table";
  }
  if (/\bDifficulty\b/i.test(headerText)) {
    return "difficulty-table";
  }
  if (/\bxG\b|\bDiff\b/.test(headerText) || /\bGoals\b.*\bAssists\b/.test(headerText)) {
    return "player-stats-table";
  }
  if (/\bPts\b/.test(headerText)) {
    return "standings-table";
  }
  return "";
};

export const getCellClassName = (text: string): string | undefined => {
  const trimmed = text.trim();

  if (trimmed === "vs") return "vs-cell";
  if (/^[+-]\d/.test(trimmed)) {
    return trimmed.startsWith("+") ? "diff-positive" : "diff-negative";
  }
  if (trimmed === "Tough") return "diff-tough";
  if (trimmed === "Moderate") return "diff-moderate";
  if (trimmed === "Favourable") return "diff-favourable";
  if (/^\(A\)$/.test(trimmed)) return "venue-away";
  if (/^\(H\)$/.test(trimmed)) return "venue-home";

  return undefined;
};
