// Markdown-aware chunking: keeps tables atomic (with their header row) and
// scopes document/section metadata to the section it came from, so chunks
// never lose — or inherit the wrong — season/league context.
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export interface DocMeta {
  league?: string;
  season?: string;
  docType?: string;
}

export interface Chunk {
  text: string;
  meta: DocMeta;
}

interface Section {
  meta: DocMeta;
  lines: string[];
}

interface TextBlock {
  kind: "text";
  lines: string[];
  heading: string | null;
  meta: DocMeta;
}

interface TableBlock {
  kind: "table";
  header: string;
  separator: string | null;
  rows: string[];
  heading: string | null;
  meta: DocMeta;
}

type Block = TextBlock | TableBlock;

const HEADING_RE = /^(#{1,3})\s+.+/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/;
// Same shape as TABLE_ROW_RE but matched with the `m` flag so it can test
// whether ANY line inside a multi-line piece is a table row.
const TABLE_LINE_ANYWHERE_RE = /^\s*\|.*\|\s*$/m;

// Style A: a blockquote-style metadata line, e.g.
// "> **Type:** League standings  |  **League:** Premier League  |  **Season:** 2025/26"
const STYLE_A_RE = /\*\*(?:Type|League|Season):\*\*/;
const STYLE_A_PAIR_RE = /\*\*(Type|League|Season):\*\*\s*([^|\n]+)/g;

// Style B: a slug-tag line, e.g.
// "Tags: #league/premier-league #season/2025-26 #type/result"
const STYLE_B_RE = /^Tags:.*#(?:league|season|type)\//i;

// Astra rejects indexed String fields over 8,000 BYTES. content and $lexical are both
// indexed, so every chunk must stay under that ceiling. Measured worst case in this
// corpus is 1.473 UTF-8 bytes per char, so the char-based sizes alone are not a guarantee.
export const MAX_CHUNK_BYTES = 7000;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

export const containsTableRow = (text: string): boolean => TABLE_LINE_ANYWHERE_RE.test(text);

const slugToText = (slug: string): string => slug.replace(/-/g, " ").trim();

const slugToTitleCase = (slug: string): string =>
  slug
    .replace(/-/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

export const extractDocMeta = (content: string): DocMeta => {
  const meta: DocMeta = {};

  const leagueMatch = content.match(/\*\*League:\*\*\s*([^|\n]+)/);
  const seasonMatch = content.match(/\*\*Season:\*\*\s*([^|\n]+)/);
  const typeMatch = content.match(/\*\*Type:\*\*\s*([^|\n]+)/);

  if (leagueMatch) meta.league = leagueMatch[1].trim();
  if (seasonMatch) meta.season = seasonMatch[1].trim();
  if (typeMatch) meta.docType = typeMatch[1].trim();

  if (!meta.league) {
    const tagMatch = content.match(/#league\/([a-z0-9-]+)/i);
    // Title-cased so a slug like "premier-league" reads as "Premier League"
    // rather than the raw lowercase-with-spaces text.
    if (tagMatch) meta.league = slugToTitleCase(tagMatch[1]);
  }
  if (!meta.season) {
    const tagMatch = content.match(/#season\/([a-z0-9-]+)/i);
    // Keep hyphens verbatim: "2025-26" is the season label, not two numbers
    // to be space-separated.
    if (tagMatch) meta.season = tagMatch[1].trim();
  }
  if (!meta.docType) {
    const tagMatch = content.match(/#type\/([a-z0-9-]+)/i);
    if (tagMatch) meta.docType = slugToText(tagMatch[1]);
  }

  return meta;
};

export const buildChunkPrefix = (meta: DocMeta, source: string): string => {
  const parts: string[] = [];
  if (meta.league) parts.push(`League: ${meta.league}`);
  if (meta.season) parts.push(`Season: ${meta.season}`);
  if (meta.docType) parts.push(`Type: ${meta.docType}`);

  if (parts.length === 0) {
    return `Source: ${source}\n\n`;
  }
  parts.push(`Source: ${source}`);
  return `${parts.join(" | ")}\n\n`;
};

const parseStyleALine = (line: string): DocMeta => {
  const meta: DocMeta = {};
  for (const match of line.matchAll(STYLE_A_PAIR_RE)) {
    const [, key, value] = match;
    const trimmed = value.trim();
    if (key === "Type") meta.docType = trimmed;
    else if (key === "League") meta.league = trimmed;
    else if (key === "Season") meta.season = trimmed;
  }
  return meta;
};

const parseStyleBLine = (line: string): DocMeta => {
  const meta: DocMeta = {};
  const leagueMatch = line.match(/#league\/([a-z0-9-]+)/i);
  const seasonMatch = line.match(/#season\/([a-z0-9-]+)/i);
  const typeMatch = line.match(/#type\/([a-z0-9-]+)/i);
  if (leagueMatch) meta.league = slugToTitleCase(leagueMatch[1]);
  if (seasonMatch) meta.season = seasonMatch[1].trim();
  if (typeMatch) meta.docType = slugToText(typeMatch[1]);
  return meta;
};

// Splits the document into sections BEFORE any chunking happens. A new section
// begins at a metadata header line (Style A or Style B); text before the first
// such line is section 0. Each section's meta is resolved ONCE, from its own
// header line with any field it doesn't define inherited from extractDocMeta
// of the whole input — so no state crosses a section boundary and one
// section's Type/League/Season can never bleed into another's chunks.
const splitIntoSections = (content: string): Section[] => {
  const lines = content.split("\n");
  const fallback = extractDocMeta(content);
  const sections: Section[] = [];
  let currentLines: string[] = [];
  let currentMeta: DocMeta = { ...fallback };

  const flush = () => {
    if (currentLines.length === 0) return;
    sections.push({ meta: currentMeta, lines: currentLines });
    currentLines = [];
  };

  for (const line of lines) {
    const isStyleB = STYLE_B_RE.test(line);
    const isStyleA = !isStyleB && STYLE_A_RE.test(line);
    if (isStyleA || isStyleB) {
      flush();
      const own = isStyleB ? parseStyleBLine(line) : parseStyleALine(line);
      currentMeta = {
        league: own.league ?? fallback.league,
        season: own.season ?? fallback.season,
        docType: own.docType ?? fallback.docType,
      };
    }
    currentLines.push(line);
  }
  flush();

  return sections;
};

// Walks a single section's lines, tracking the current heading and any table
// currently being consumed. The section's meta is fixed, so every emitted
// block simply carries it — there is no cursor to get out of sync.
const parseSectionBlocks = (section: Section): Block[] => {
  const { lines, meta } = section;
  const blocks: Block[] = [];
  let currentHeading: string | null = null;
  let textBuffer: string[] = [];
  // Heading-only buffers (e.g. a trailing "## Notes" with nothing after it)
  // are held here instead of being dropped, and attached to the next block
  // that actually gets emitted.
  let pendingHeadings: string[] = [];

  const flushText = () => {
    if (textBuffer.length === 0) return;
    const nonBlank = textBuffer.filter((l) => l.trim().length > 0);
    if (nonBlank.length === 0) {
      textBuffer = [];
      return;
    }
    const isHeadingOnly = nonBlank.every((l) => HEADING_RE.test(l.trim()));
    if (isHeadingOnly) {
      pendingHeadings.push(...nonBlank);
      textBuffer = [];
      return;
    }
    const combined = pendingHeadings.length > 0 ? [...pendingHeadings, ...textBuffer] : textBuffer;
    blocks.push({ kind: "text", lines: combined, heading: currentHeading, meta });
    pendingHeadings = [];
    textBuffer = [];
  };

  const flushPendingHeadings = () => {
    if (pendingHeadings.length === 0) return;
    blocks.push({ kind: "text", lines: [...pendingHeadings], heading: currentHeading, meta });
    pendingHeadings = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (HEADING_RE.test(line)) {
      currentHeading = line.trim();
    }

    const nextLine = lines[i + 1];
    const hasSeparatorNext = nextLine !== undefined && TABLE_SEP_RE.test(nextLine);
    const hasRowNext = nextLine !== undefined && TABLE_ROW_RE.test(nextLine);

    if (TABLE_ROW_RE.test(line) && (hasSeparatorNext || hasRowNext)) {
      const header = line;
      // A well-formed table has a separator row; a table missing one is still
      // recognised as long as a data row follows directly.
      const separator = hasSeparatorNext ? nextLine : null;
      let j = hasSeparatorNext ? i + 2 : i + 1;
      const rows: string[] = [];

      while (j < lines.length && TABLE_ROW_RE.test(lines[j]) && lines[j].trim().length > 0) {
        if (j + 1 < lines.length && TABLE_SEP_RE.test(lines[j + 1])) {
          // lines[j] is immediately followed by a separator, which means
          // lines[j] is actually the HEADER of a new adjacent table, not a
          // data row of this one. Stop and let the outer loop start fresh.
          break;
        }
        rows.push(lines[j]);
        j += 1;
      }

      if (rows.length > 0) {
        flushText();
        flushPendingHeadings();
        blocks.push({ kind: "table", header, separator, rows, heading: currentHeading, meta });
        i = j;
        continue;
      }
    }

    textBuffer.push(line);
    i += 1;
  }
  flushText();
  flushPendingHeadings();

  return blocks;
};

const withHeading = (piece: string, heading: string | null): string => {
  if (!heading) return piece;
  const firstLine = piece.split("\n")[0]?.trim() ?? "";
  if (HEADING_RE.test(firstLine)) return piece;
  return `${heading}\n\n${piece}`;
};

// Packs a table's rows into pieces, always re-emitting the full header (and
// heading, if any) on every piece: a piece starts as heading? + header +
// separator?, then rows are added while it stays within maxSize CHARS and
// MAX_CHUNK_BYTES; a piece always gets at least one row even if that single
// row alone overruns both limits. No recursion, no character slicing — a
// header can never be orphaned from its rows because it's part of every
// piece by construction. Overlap is never applied to table chunks.
const packTableRows = (
  heading: string | null,
  header: string,
  separator: string | null,
  rows: string[],
  maxSize: number,
): string[] => {
  const headLines = separator !== null ? [header, separator] : [header];
  const buildPiece = (rowSet: string[]): string => withHeading([...headLines, ...rowSet].join("\n"), heading);

  const headOnly = buildPiece([]);
  const headChars = headOnly.length;
  const headBytes = byteLen(headOnly);

  const pieces: string[] = [];
  let currentRows: string[] = [];
  // Running size of the piece being assembled (+1 per row for its joining
  // newline), tracked incrementally so this stays O(n) on large tables
  // instead of rejoining the whole row set on every row.
  let currentChars = headChars;
  let currentBytes = headBytes;

  const flush = () => {
    if (currentRows.length === 0) return;
    pieces.push(buildPiece(currentRows));
    currentRows = [];
    currentChars = headChars;
    currentBytes = headBytes;
  };

  for (const row of rows) {
    const addChars = 1 + row.length;
    const addBytes = 1 + byteLen(row);
    const candidateChars = currentChars + addChars;
    const candidateBytes = currentBytes + addBytes;
    const fits = candidateChars <= maxSize && candidateBytes <= MAX_CHUNK_BYTES;

    if (currentRows.length > 0 && !fits) {
      flush();
      currentRows.push(row);
      currentChars = headChars + addChars;
      currentBytes = headBytes + addBytes;
    } else {
      currentRows.push(row);
      currentChars = candidateChars;
      currentBytes = candidateBytes;
    }
  }
  flush();

  return pieces;
};

// RecursiveCharacterTextSplitter measures length in UTF-16 units, not code
// points, so its character-level fallback split (used when a unit has no
// smaller separator to break on) can land its cut point inside a surrogate
// pair, leaving a lone surrogate dangling at a piece boundary. That half
// survives untouched through JS string ops but turns into U+FFFD the moment
// it's encoded to UTF-8 (DB storage, byte-length checks). Stripping a lone
// surrogate off either end repairs this without hand-rolled character
// slicing — the paired half remains intact in the adjacent piece via overlap.
const repairSurrogateBoundary = (s: string): string => {
  let out = s;
  const first = out.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  const lastIndex = out.length - 1;
  const last = out.charCodeAt(lastIndex);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, lastIndex);
  return out;
};

const splitProseBlock = async (text: string, maxSize: number, overlap: number): Promise<string[]> => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: maxSize, chunkOverlap: overlap });
  const pieces = await splitter.splitText(trimmed);
  // Repair lone surrogates produced when the splitter cuts inside a surrogate
  // pair. We iterate over `pieces` (not over the filtered repaired array) so
  // that an i++ skip for a merged pair does not also skip the piece that
  // follows the lone-surrogate piece — the bug that caused content loss at
  // overlap=0 when the emoji landed exactly at a chunk boundary.
  const repairedAll = pieces.map((p) => repairSurrogateBoundary(p).trim());

  const result: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    let piece = repairedAll[i];
    const originalPiece = pieces[i];

    // If the repaired piece is shorter than the original and the very next
    // raw piece starts with a lone low surrogate, the splitter cut inside a
    // surrogate pair — rejoin the two halves using the originals.
    if (piece.length < originalPiece.length && i < pieces.length - 1) {
      const nextPieceStart = pieces[i + 1].slice(0, 1);
      const nextCode = nextPieceStart.charCodeAt(0);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        const originalEnd = originalPiece.slice(-1);
        const endCode = originalEnd.charCodeAt(0);
        if (endCode >= 0xd800 && endCode <= 0xdbff) {
          piece = (originalPiece + pieces[i + 1]).trim();
          i++; // consume the lone low-surrogate piece
        }
      }
    }

    if (piece.length > 0) result.push(piece);
  }

  return result;
};

// Iterating a string with for..of yields whole code points, so a surrogate pair is
// never split. Buffer/String.slice() work on UTF-16 units and WILL corrupt emoji.
// This is the ONLY function in the codebase that truncates text.
// Returns both the truncated text AND any remaining characters that were cut off.
// Callers MUST handle the remainder to avoid content loss.
export const utf8SafeCut = (s: string, maxBytes: number): { cut: string; remainder: string } => {
  if (byteLen(s) <= maxBytes) return { cut: s, remainder: "" };
  const chars = Array.from(s); // Split into code points (never splits a surrogate pair)
  let bytes = 0;
  for (let i = 0; i < chars.length; i++) {
    const b = byteLen(chars[i]);
    if (bytes + b > maxBytes) {
      // Use the current index `i`, not chars.indexOf(), which would return
      // the first occurrence and produce a wrong (oversized) remainder for
      // strings that contain repeated characters.
      return {
        cut: chars.slice(0, i).join(""),
        remainder: chars.slice(i).join(""),
      };
    }
    bytes += b;
  }
  return { cut: s, remainder: "" };
};

// Finds the leading table in `text` (after any heading or blank lines) and
// returns its header, optional separator, and data rows. Returns null when
// the text doesn't start with a recognisable table (at least one data row).
// Used by the ceiling loop to re-split oversized table chunks table-aware.
const extractLeadingTable = (
  text: string,
): { header: string; separator: string | null; rows: string[] } | null => {
  const ls = text.split("\n");
  let ti = 0;
  while (ti < ls.length && !TABLE_ROW_RE.test(ls[ti])) ti++;
  if (ti >= ls.length) return null;
  const hdr = ls[ti];
  let tj = ti + 1;
  let sep: string | null = null;
  if (tj < ls.length && TABLE_SEP_RE.test(ls[tj])) {
    sep = ls[tj];
    tj++;
  }
  const tableRows: string[] = [];
  while (tj < ls.length && TABLE_ROW_RE.test(ls[tj]) && ls[tj].trim().length > 0) {
    tableRows.push(ls[tj]);
    tj++;
  }
  if (tableRows.length === 0) return null;
  return { header: hdr, separator: sep, rows: tableRows };
};

export const splitMarkdownAware = async (
  content: string,
  maxSize: number,
  overlap: number,
): Promise<Chunk[]> => {
  // Defensive coercion: a misconfigured (non-positive) chunk size must never
  // reach the prose splitter or table packer with a nonsensical budget.
  const size = Math.max(1, Math.floor(maxSize));
  const ov = Math.max(0, Math.min(Math.floor(overlap), size - 1));

  const sections = splitIntoSections(content);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const blocks = parseSectionBlocks(section);
    for (const block of blocks) {
      if (block.kind === "table") {
        const pieces = packTableRows(block.heading, block.header, block.separator, block.rows, size);
        for (const piece of pieces) {
          chunks.push({ text: piece, meta: block.meta });
        }
      } else {
        const text = block.lines.join("\n");
        const pieces = await splitProseBlock(text, size, ov);
        for (const piece of pieces) {
          chunks.push({ text: withHeading(piece, block.heading), meta: block.meta });
        }
      }
    }
  }

  // ── Last-line defence ──────────────────────────────────────────────────────
  // No chunk leaving this function may exceed MAX_CHUNK_BYTES, regardless of
  // which path (table packing, prose splitting, heading attachment) produced it.
  //
  // • Table chunks that are oversized are re-split with packTableRows so the
  //   table header is repeated on every continuation piece. When a single row
  //   plus its header still exceeds the ceiling (e.g. a 50 KB cell value) we
  //   fall back to raw byte cutting while prepending the header to every piece
  //   whose header fits within the budget.
  //
  // • Non-table (prose) chunks are drained with a while loop.
  //
  // Content is NEVER dropped — cutting is a last resort, trimming is only for
  // cosmetic whitespace at the edges.
  const processedChunks: Chunk[] = [];

  for (const c of chunks) {
    const fullText = c.text;

    // Fast path: chunk already fits.
    if (byteLen(fullText) <= MAX_CHUNK_BYTES) {
      const trimmed = fullText.trim();
      if (trimmed.length > 0) processedChunks.push({ text: trimmed, meta: c.meta });
      continue;
    }

    // Slow path: chunk exceeds the ceiling.
    const tbl = extractLeadingTable(fullText);

    if (tbl !== null) {
      // ── Table-aware split ──────────────────────────────────────────────
      // Re-split using packTableRows (which always emits the header on every
      // piece). This handles multi-row tables; single oversized rows fall to
      // the raw-cut branch below.
      const { header, separator, rows } = tbl;
      const headLines = separator !== null ? [header, separator] : [header];
      const headPrefix = headLines.join("\n") + "\n";
      const headPrefixBytes = byteLen(headPrefix);
      // Only prepend the header on continuation pieces when the header itself
      // fits within the budget (an 8 KB header cannot be its own solution).
      const canAddHeader = headPrefixBytes < MAX_CHUNK_BYTES;

      const tPieces = packTableRows(null, header, separator, rows, MAX_CHUNK_BYTES);
      for (const tPiece of tPieces) {
        if (byteLen(tPiece) <= MAX_CHUNK_BYTES) {
          const trimmed = tPiece.trim();
          if (trimmed.length > 0) processedChunks.push({ text: trimmed, meta: c.meta });
          continue;
        }

        // Single row (+ header) still exceeds ceiling — raw-cut in a loop.
        // The first cut naturally includes the header because tPiece starts
        // with it. On every subsequent cut we re-prepend the header so that
        // each piece retains its table context.
        let rem = tPiece;
        while (rem.length > 0) {
          if (byteLen(rem) <= MAX_CHUNK_BYTES) {
            const trimmed = rem.trim();
            if (trimmed.length > 0) processedChunks.push({ text: trimmed, meta: c.meta });
            break;
          }
          const { cut, remainder } = utf8SafeCut(rem, MAX_CHUNK_BYTES);
          const trimmed = cut.trim();
          if (trimmed.length > 0) processedChunks.push({ text: trimmed, meta: c.meta });
          if (remainder.length === 0) break;
          rem = canAddHeader ? headPrefix + remainder : remainder;
        }
      }
    } else {
      // ── Non-table (prose) ─────────────────────────────────────────────
      // Drain the chunk with a while loop. Each iteration emits one capped
      // piece; the loop continues until nothing remains.
      let rem = fullText;
      while (rem.length > 0) {
        if (byteLen(rem) <= MAX_CHUNK_BYTES) {
          const trimmed = rem.trim();
          if (trimmed.length > 0) processedChunks.push({ text: trimmed, meta: c.meta });
          break;
        }
        const { cut, remainder } = utf8SafeCut(rem, MAX_CHUNK_BYTES);
        const trimmed = cut.trim();
        if (trimmed.length > 0) processedChunks.push({ text: trimmed, meta: c.meta });
        rem = remainder;
      }
    }
  }

  return processedChunks;
};
