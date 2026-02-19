// Utility functions

const countPipeCols = (line: string): number => {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return 0;
  return t.slice(1, -1).split("|").length;
};

const isSeparatorCell = (cell: string): boolean =>
  /^:?-+:?$/.test(cell.trim());

const fixSeparatorRow = (sep: string, expectedCols: number): string => {
  const t = sep.trim();
  const cells = t.slice(1, -1).split("|");

  if (cells.length === expectedCols && cells.every(isSeparatorCell)) return sep;

  // Try to split merged cells (e.g. "---:---:" → "---:" + "---:")
  const expanded: string[] = [];
  for (const cell of cells) {
    if (isSeparatorCell(cell)) {
      expanded.push(cell);
    } else {
      const parts = cell.match(/:?-+:?/g) ?? [];
      expanded.push(...parts);
    }
  }

  if (expanded.length === expectedCols) {
    return "|" + expanded.join("|") + "|";
  }
  // Fallback: plain separator with correct column count
  return "|" + Array(expectedCols).fill("---").join("|") + "|";
};

export const sanitizeMarkdown = (content: string): string => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = out[out.length - 1] ?? "";
    const looksLikeSeparator =
      line.trim().startsWith("|") &&
      line.includes("-") &&
      /^[\s|:\-]+$/.test(line);

    if (looksLikeSeparator && prev.trim().startsWith("|")) {
      const expectedCols = countPipeCols(prev);
      out.push(fixSeparatorRow(line, expectedCols));
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
};

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
