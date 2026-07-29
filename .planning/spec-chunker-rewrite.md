# SPEC — Rewrite the chunker (section-first, row-based tables, proven prose splitter)

Rewrite `scripts/lib/utils/markdownChunker.ts` from scratch. Also update
`scripts/lib/utils/chunking.ts`, `scripts/lib/database/operations.ts`,
`scripts/validateChunking.ts`. Do not commit. Do not run `npm run seed`.

## Why we are rewriting instead of patching

Three review rounds have each found NEW defects in different parts of the hand-rolled chunker
(UTF-16 vs UTF-8 slicing, section-flush ordering, header sizing, table-detection heuristics).
Confirmed still broken right now:

- `splitMarkdownAware("a".repeat(399) + "😀 tail", 400, 50)` → chunks contain U+FFFD.
  The custom recursive splitter slices by UTF-16 code unit and cuts surrogate pairs in half.
- A prose-only two-section document (`**Type:** Alpha` then `**Type:** Beta`) stamps
  **every** chunk `Type: Beta`. Metadata updates without flushing the preceding text block.
  Tables only work by accident, because table detection happens to force a flush.

The design generates edge cases faster than we close them. The rewrite removes whole classes of
bug by construction rather than adding more guards.

**Keep working and do not regress** (these are measured, on real data):
- retrieval accuracy 4/4 (was 3/4)
- every table chunk carries its header and season
- max emitted chunk 1,628 bytes (Astra rejects indexed strings > 8,000 BYTES)
- `$lexical` written on children; lexical+rerank preserved on collection create

---

## The new design — three ideas

### 1. Sections first, processed in isolation

Split the document into sections BEFORE any chunking. A new section begins at a metadata
header line — either Style A `> **Type:** …  |  **League:** …  |  **Season:** …` or Style B
`Tags: #league/… #season/… #type/…`. Text before the first such line is section 0.

```ts
interface Section { meta: DocMeta; lines: string[] }
const splitIntoSections = (content: string): Section[] => { ... }
```

Each section carries its OWN `DocMeta`, parsed from its own header line, with any field it
doesn't define inherited from a document-level `extractDocMeta(content)` fallback.

Then chunk **each section independently**. Because no state crosses a section boundary, the
Type-bleed bug cannot happen. This replaces the `currentMeta` cursor entirely.

### 2. Tables: pack rows, always re-emit the header, never overlap

Within a section, a table block is: a `|` header row, an OPTIONAL `|---|` separator, then
consecutive `|` data rows. Stop the block when a row is followed by a separator (that is the
next table starting).

Emit table chunks by packing **whole rows**:
- start a new piece with `heading? + header + separator?`
- add rows while the piece stays within `maxSize` chars AND `MAX_CHUNK_BYTES` bytes
- **always include at least one row per piece**, even if that single row overruns
- never apply overlap to table chunks

A row is ~100 bytes in this corpus, so the byte ceiling is effectively never reached. No
recursion, no character slicing, no orphaning possible — the header is attached by construction.

### 3. Prose: use the proven splitter, delete the hand-rolled one

For non-table content use langchain's `RecursiveCharacterTextSplitter` (already a dependency —
`@langchain/textsplitters`; re-import it) with the section's `maxSize`/`overlap`.
**Delete `recursiveTextSplit`, `applyOverlap` and every custom character-slicing path.**

`splitText` is async, so `splitMarkdownAware` becomes `async`. Update callers.

---

## The one place we still cut: make it UTF-8 safe and use it everywhere

```ts
// Iterating a string with for..of yields whole code points, so a surrogate pair is
// never split. Buffer/String.slice() work on UTF-16 units and WILL corrupt emoji.
export const utf8SafeCut = (s: string, maxBytes: number): string => {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
};
```

This must be the ONLY function in the codebase that truncates text.

**The byte ceiling must be absolute.** As the final step of `splitMarkdownAware`, pass every
emitted chunk through `utf8SafeCut(chunk, MAX_CHUNK_BYTES)` — including chunks whose table
header alone is oversized (cut the header too; a chunk that cannot fit is cut, never dropped).
Keep `MAX_CHUNK_BYTES = 7000`.

`splitMarkdownAware` must NEVER return:
- a chunk over `MAX_CHUNK_BYTES` bytes,
- a chunk containing U+FFFD that wasn't in the input,
- an empty array when the input had non-whitespace content.

---

## Return shape

```ts
export interface Chunk { text: string; meta: DocMeta }
export const splitMarkdownAware = async (
  content: string, maxSize: number, overlap: number,
): Promise<Chunk[]>
```

Keep `extractDocMeta` and `buildChunkPrefix` (including the Fix G behaviour: season keeps its
hyphens — `2025-26`, not `2025 26`; league is title-cased). Keep size coercion:
`maxSize = Math.max(1, Math.floor(maxSize))`, `overlap` clamped to `[0, maxSize-1]`.

## `chunking.ts`

- `await splitMarkdownAware(...)` for parents, and per parent for children.
- Build the prefix **per chunk** from that chunk's own `meta`.
- Skip prefixing when the chunk's first line already equals the prefix's first line.
- Apply the `>= 120` / `>= 80` minimum-length filters ONLY to non-table chunks; any chunk with a
  table data row is kept regardless of length.
- Final guard: if `prefix + chunk` exceeds 8,000 bytes, `utf8SafeCut` the CHUNK (never the
  prefix) and `console.warn` source + url.

## `operations.ts` — fix the insert accounting (review finding #5)

The catch branch currently assumes every non-oversized document in a failed batch succeeded and
increments `recordsAdded` accordingly. A mixed or request-level error therefore silently omits
documents while reporting them as inserted.

Use the error's actual `partialResult.insertedCount` for `recordsAdded`. Count size-violation
documents into `recordsSkipped` and continue. Any other error still rethrows. Never infer
success — always read the real count.

## `validateChunking.ts` — extend, keep every existing assertion

Add cases that fail on today's bugs:
1. **Emoji**: input containing `😀` (a 4-byte, non-BMP character) cut at a boundary — assert no
   chunk contains U+FFFD and each chunk round-trips (`Buffer.from(c,"utf8").toString("utf8") === c`).
2. **Prose-only multi-section**: `**Type:** Alpha` then `**Type:** Beta`, prose only, no tables —
   assert the Alpha chunks are stamped Alpha and the Beta chunks Beta.
3. **Oversized table header**: a header line over 7,000 bytes — assert every emitted chunk is
   `<= 7000` bytes and nothing is dropped entirely.
4. **Row coverage**: every data row appears at least once and no more than once across children.
5. Keep the existing standings / three-section / no-separator / adjacent-tables / byte-ceiling /
   heading-only assertions.

Exit non-zero on any failure.

## Constraints
- `npx tsc --noEmit` passes; `npx eslint scripts/` clean for touched files; no `any`.
- Do NOT run `npm run seed`; do NOT write to the live collection.
- Do not change `app/api/chat/route.ts`, embedding dimensions, or models.
- Prefer keeping content over honouring `maxSize`: cutting is a last resort, dropping is never allowed.

## Definition of done
1. `npx tsx scripts/validateChunking.ts` exits 0 with all old + new assertions.
2. The custom recursive splitter and all `String.slice`-based truncation are gone;
   `utf8SafeCut` is the only truncation path.
3. Append a "Chunker rewrite" section to `.planning/executor-report.md` describing the new
   structure, what you deleted, and anything you disagree with.
