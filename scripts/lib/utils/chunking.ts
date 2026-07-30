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

// Reserved so a pathological prefix (e.g. an abnormally long League/Season/
// Source line) can never itself consume the entire per-record budget — every
// split piece keeps at least this many bytes of real chunk content, which is
// also what guarantees the split loop below terminates for any input.
const MIN_CHUNK_BUDGET_BYTES = 1024;

// Caps `prefix` when it alone would leave less than MIN_CHUNK_BUDGET_BYTES of
// room within MAX_DOCUMENT_BYTES. Metadata tail loss here is acceptable (and
// logged loudly); chunk content loss is not. Pure/deterministic so callers
// that need the same capped prefix (splitOversizedText and
// enforceDocByteLimit) always agree on it.
const capPrefix = (prefix: string, source: string, url: string): string => {
  const maxPrefixBytes = MAX_DOCUMENT_BYTES - MIN_CHUNK_BUDGET_BYTES;
  if (Buffer.byteLength(prefix, "utf8") <= maxPrefixBytes) return prefix;
  console.warn(
    `[chunking] prefix exceeded ${maxPrefixBytes}-byte budget, truncated (metadata tail lost, not chunk content). source="${source}" url="${url}"`,
  );
  return utf8SafeCut(prefix, maxPrefixBytes).cut;
};

// True backstop: by the time this runs, call sites are expected to have
// already pre-split any oversized text via splitOversizedText, so
// prefix + chunk should always already fit. If it doesn't, a call site
// skipped the pre-split — throw instead of the old truncate-and-discard
// behaviour, so the 8,000-byte invariant fails fast and loudly rather than
// silently shipping a corrupt or content-lossy record.
const enforceDocByteLimit = (prefix: string, chunk: string, source: string, url: string): string => {
  const usablePrefix = capPrefix(prefix, source, url);
  const full = prependPrefix(chunk, usablePrefix);
  if (Buffer.byteLength(full, "utf8") <= MAX_DOCUMENT_BYTES) return full;
  throw new Error(
    `[chunking] invariant violated: prefix + chunk still exceeds ${MAX_DOCUMENT_BYTES} bytes after pre-split. source="${source}" url="${url}"`,
  );
};

// When `prefix + text` would exceed MAX_DOCUMENT_BYTES, splits `text` (never
// the prefix, unless the prefix itself is pathologically large — see
// capPrefix) into multiple raw pieces using the same code-point-safe
// utf8SafeCut used everywhere else. Replaces the old truncate-and-discard
// semantics: ALL of `text` reappears across the returned pieces, nothing is
// dropped. Returns `[text]` unchanged in the overwhelming common case, since
// splitMarkdownAware already caps chunks well under this ceiling before the
// prefix is added.
const splitOversizedText = (prefix: string, text: string, source: string, url: string): string[] => {
  const full = prependPrefix(text, prefix);
  if (Buffer.byteLength(full, "utf8") <= MAX_DOCUMENT_BYTES) return [text];

  const usablePrefix = capPrefix(prefix, source, url);
  const budget = MAX_DOCUMENT_BYTES - Buffer.byteLength(usablePrefix, "utf8");

  const pieces: string[] = [];
  let rem = text;
  while (true) {
    const { cut, remainder } = utf8SafeCut(rem, budget);
    pieces.push(cut);
    if (remainder.length === 0) break;
    rem = remainder;
  }
  return pieces;
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
    // Expand a parent whose prefixed content would exceed the ceiling into
    // multiple parent pieces BEFORE any record is created, so the loop below
    // (record creation + child derivation) runs unchanged on already-fitting
    // text and enforceDocByteLimit becomes a true never-triggers backstop.
    // In the overwhelming common case this is just `[parent.text]`.
    const parentTextPieces = splitOversizedText(parentPrefix, parent.text, source, url);

    for (const parentTextPiece of parentTextPieces) {
      // Hash the piece itself (mirrors the original hash-of-text approach),
      // so each extra parent piece gets its own stable, distinct `_id`.
      const parentId = createHash("md5").update(parentTextPiece).digest("hex");
      parentDocs.push({
        _id: parentId,
        content: enforceDocByteLimit(parentPrefix, parentTextPiece, source, url),
        source,
        url,
        category,
        scrapedAt,
        type: "parent",
      });

      const childPieces = await splitMarkdownAware(parentTextPiece, childMaxSize, childOverlap);
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
        // Same expansion for an oversized child; each piece gets its own
        // embedding but keeps the same parentId.
        const childTextPieces = splitOversizedText(childPrefix, child.text, source, url);
        for (const childTextPiece of childTextPieces) {
          childTexts.push(enforceDocByteLimit(childPrefix, childTextPiece, source, url));
          childMeta.push({ parentId });
        }
      }
    }
  }

  if (childTexts.length === 0) {
    return null;
  }

  return { parentDocs, childTexts, childMeta };
};
