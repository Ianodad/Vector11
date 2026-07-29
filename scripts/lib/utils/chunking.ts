// Parent-child chunking strategy
import { createHash } from "crypto";
import {
  extractDocMeta,
  buildChunkPrefix,
  splitMarkdownAware,
  containsTableRow,
  utf8SafeCut,
  type DocMeta,
} from "./markdownChunker.js";

export interface ParentRecord {
  _id: string;
  content: string;
  source: string;
  url: string;
  category: string;
  scrapedAt: string;
  type: "parent";
}

export interface ChildRecord {
  _id: string;
  content: string;
  parentId: string;
  source: string;
  url: string;
  category: string;
  scrapedAt: string;
  type: "child";
  $vector?: number[];
  $lexical?: string;
}

export interface ChunkingResult {
  parentDocs: ParentRecord[];
  childTexts: string[];
  childMeta: { parentId: string }[];
}

export interface ChunkSizes {
  parentMaxSize: number;
  parentOverlap: number;
  childMaxSize: number;
  childOverlap: number;
}

const PARENT_MIN_LENGTH = 120;
const CHILD_MIN_LENGTH = 80;

// Astra rejects indexed String fields (content, $lexical) over 8,000 bytes.
// splitMarkdownAware already caps chunks at MAX_CHUNK_BYTES (7,000) before the
// prefix is added, so this should never trigger — it's a defensive backstop.
export const MAX_DOCUMENT_BYTES = 8000;

// A chunk's own metadata wins; any field it doesn't supply (e.g. a section
// that only restates **Type:** and relies on the document header for
// **League:**/**Season:**) falls back to the nearest enclosing scope.
const resolveMeta = (blockMeta: DocMeta, fallback: DocMeta): DocMeta => ({
  league: blockMeta.league ?? fallback.league,
  season: blockMeta.season ?? fallback.season,
  docType: blockMeta.docType ?? fallback.docType,
});

const prependPrefix = (text: string, prefix: string): string => {
  const prefixFirstLine = prefix.split("\n")[0];
  const textFirstLine = text.split("\n")[0];
  if (prefixFirstLine && textFirstLine === prefixFirstLine) return text;
  return `${prefix}${text}`;
};

// Enforces the 8,000-byte Astra ceiling on the fully-prefixed document. If the
// prefix + chunk ever breaches it, the CHUNK is truncated (never the prefix,
// which carries the season/league context) via the same utf8SafeCut used
// everywhere else — no second truncation path.
const enforceDocByteLimit = (prefix: string, chunk: string, source: string, url: string): string => {
  const full = prependPrefix(chunk, prefix);
  if (Buffer.byteLength(full, "utf8") <= MAX_DOCUMENT_BYTES) return full;

  const prefixPortion = full.startsWith(prefix) ? prefix : (full.split("\n")[0] ?? "");
  const chunkPortion = full.slice(prefixPortion.length);
  const budget = Math.max(0, MAX_DOCUMENT_BYTES - Buffer.byteLength(prefixPortion, "utf8"));

  console.warn(
    `[chunking] chunk exceeded ${MAX_DOCUMENT_BYTES}-byte ceiling after prefix, truncated. source="${source}" url="${url}"`,
  );
  const { cut } = utf8SafeCut(chunkPortion, budget);
  return `${prefixPortion}${cut}`;
};

// The minimum-length filter exists to drop stray fragments, not table rows —
// a short trailing table piece (header + separator + one row) must survive
// even if it falls under the length floor.
const passesLengthFilter = (text: string, minLength: number): boolean =>
  containsTableRow(text) || text.length >= minLength;

export const createParentChildChunks = async (
  content: string,
  sizes: ChunkSizes,
  source: string,
  url: string,
  category: string,
  isLowValueContent: (text: string) => boolean,
): Promise<ChunkingResult | null> => {
  const { parentMaxSize, parentOverlap, childMaxSize, childOverlap } = sizes;
  const docMeta = extractDocMeta(content);

  // Step 1: Split into parent chunks
  const parentPieces = await splitMarkdownAware(content, parentMaxSize, parentOverlap);
  const filteredParents = parentPieces.filter(
    (p) => passesLengthFilter(p.text, PARENT_MIN_LENGTH) && !isLowValueContent(p.text),
  );

  if (filteredParents.length === 0) {
    return null;
  }

  // Step 2: Split each parent into child chunks
  const scrapedAt = new Date().toISOString();
  const parentDocs: ParentRecord[] = [];
  const childTexts: string[] = [];
  const childMeta: { parentId: string }[] = [];

  for (const parent of filteredParents) {
    const parentMeta = resolveMeta(parent.meta, docMeta);
    const parentPrefix = buildChunkPrefix(parentMeta, source);
    const parentId = createHash("md5").update(parent.text).digest("hex");
    parentDocs.push({
      _id: parentId,
      content: enforceDocByteLimit(parentPrefix, parent.text, source, url),
      source,
      url,
      category,
      scrapedAt,
      type: "parent",
    });

    const childPieces = await splitMarkdownAware(parent.text, childMaxSize, childOverlap);
    const filteredChildren = childPieces.filter(
      (c) => passesLengthFilter(c.text, CHILD_MIN_LENGTH) && !isLowValueContent(c.text),
    );
    for (const child of filteredChildren) {
      // Fall back to the PARENT's already-resolved metadata (not straight to
      // the document level) so a child re-split from a parent whose own text
      // doesn't repeat the section's **Type:** line still inherits the
      // correct section, not just whatever came first in the whole document.
      const childMetaResolved = resolveMeta(child.meta, parentMeta);
      const childPrefix = buildChunkPrefix(childMetaResolved, source);
      childTexts.push(enforceDocByteLimit(childPrefix, child.text, source, url));
      childMeta.push({ parentId });
    }
  }

  if (childTexts.length === 0) {
    return null;
  }

  return { parentDocs, childTexts, childMeta };
};
