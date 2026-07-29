# SPEC — Astra hard limits (addendum, MUST land before any re-seed)

Edit `scripts/lib/utils/markdownChunker.ts`, `scripts/lib/utils/chunking.ts`,
`scripts/lib/database/operations.ts`, `scripts/validateChunking.ts`.
Do not commit. Do not run `npm run seed`.

Apply this ON TOP of the A–J chunker fixes.

## Measured facts (tested live against the real Astra collection — treat as fact)

**Astra rejects any indexed String field longer than 8,000 BYTES:**

```
content + $lexical of  2,000 chars each -> ACCEPTED
content + $lexical of  8,000 chars each -> ACCEPTED
content + $lexical of 16,000 chars each -> REJECTED
   "Document size limitation violated: indexed String value (field 'content')
    length (16000 bytes) exceeds maximum allowed (8000 bytes)."
```

`content` AND `$lexical` are both indexed, so BOTH are capped at 8,000 bytes each.

**BYTES, not characters.** This corpus is full of multi-byte glyphs (`·`, `−`, `é`, `ö`, `–`).
Measured worst case across the live corpus: **1.473 bytes/char**, so the 8,000-byte ceiling can
be reached at only **~5,429 characters**.

Current production max chunk is 1,509 bytes, so normal operation has headroom. The danger is the
A–J rule "a chunk may exceed maxSize rather than split a table row from its header" — an
oversized table row or a very wide table piece can breach 8,000 bytes and get **rejected**,
which today would abort the entire 2-hour seed.

Also measured: the new chunker produces **1.73x more documents** than the old one
(Understat EPL: 211 → 364 docs), so the collection goes from ~10,209 to roughly ~17,700 docs.
That volume is fine for Astra; no action needed, but do not make it worse.

---

## FIX K — hard byte ceiling on every emitted chunk

Add to `markdownChunker.ts`:

```ts
// Astra rejects indexed String fields over 8,000 BYTES. content and $lexical are both
// indexed, so every chunk must stay under that ceiling. Measured worst case in this
// corpus is 1.473 UTF-8 bytes per char, so the char-based sizes alone are not a guarantee.
export const MAX_CHUNK_BYTES = 7000;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");
```

7,000 leaves headroom for the metadata prefix that `chunking.ts` prepends afterwards.

**Enforce it as the LAST step of `splitMarkdownAware`**, after headings are attached:
any chunk whose `byteLen` exceeds `MAX_CHUNK_BYTES` must be split further until every
piece fits.

- For a **table** chunk: split by rows, repeating the header (+ separator when present) on each
  piece, exactly as `splitTableBlock` already does — but drive the loop off `byteLen`, not
  `.length`. If one single row plus its header still exceeds the ceiling, hard-cut that row on a
  UTF-8 safe boundary (never slice mid-code-point — build with `Array.from(str)` or check
  `Buffer.byteLength` incrementally) and keep the header on each piece.
- For a **text** chunk: fall back to the existing recursive split, then hard-cut on a UTF-8 safe
  boundary.

The invariant to guarantee: **`splitMarkdownAware` never returns a chunk over `MAX_CHUNK_BYTES`.**

## FIX L — the prefix must not push a chunk over the ceiling

In `chunking.ts`, after building `${prefix}${chunk}`, assert the result is within 8,000 bytes.
Because `splitMarkdownAware` caps at 7,000 and the prefix is <200 bytes, this should never
trigger — but if it does, truncate the CHUNK (never the prefix, which carries the season) on a
UTF-8 safe boundary and `console.warn` the source and URL.

## FIX M — a size rejection must not kill a 2-hour seed

`batchInsertParents` and `batchInsertChildren` in `operations.ts` currently swallow only
`"already exists"` / `"duplicate"` errors and rethrow everything else. A single oversized
document would therefore abort the whole run.

Change both so that a document-size violation (message matches
`/document size limitation|exceeds maximum allowed/i`) is caught, logged with the source, url and
offending `_id`, counted, and SKIPPED — the batch continues. Any other error still rethrows.

Return the skipped count alongside `recordsAdded` (extend `InsertResult` with
`recordsSkipped: number`) and have `loadDb.ts` log a clear end-of-run total:
`Skipped N oversized documents` — so a silent partial seed is impossible.

## FIX N — validator must prove the ceiling holds

Add assertions to `scripts/validateChunking.ts`:
1. Build a document containing a table with one pathologically wide row (~20,000 chars of
   multi-byte characters such as `·` and `−`).
2. Assert **every** emitted parent and child chunk is `<= 8000` bytes measured with
   `Buffer.byteLength(chunk, "utf8")` — including the metadata prefix.
3. Assert no chunk splits a multi-byte character (round-trip
   `Buffer.from(chunk,"utf8").toString("utf8") === chunk`, and no U+FFFD replacement char).
4. Assert the wide row's content still appears across the chunks (truncation is allowed, total
   loss is not) and that every piece still carries the table header.

Exit non-zero on any failure.

---

## Constraints
- `npx tsc --noEmit` passes; `npx eslint scripts/` clean for touched files; no `any`.
- Do NOT run `npm run seed`; do NOT write to the live collection.
- Do not reduce `MAX_CHUNK_BYTES` below 4,000 or raise it above 7,500.

## Definition of done
1. `npx tsx scripts/validateChunking.ts` exits 0 with the A–J and K–N assertions.
2. Fixes K, L, M, N all present.
3. Append an "Astra limits" section to `.planning/executor-report.md` stating what you changed
   for each of K–N and anything you disagree with.
