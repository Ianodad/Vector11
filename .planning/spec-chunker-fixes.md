# SPEC — Fix chunker defects found in review (BLOCKS the re-seed)

Edit `scripts/lib/utils/markdownChunker.ts`, `scripts/lib/utils/chunking.ts`, and
`scripts/validateChunking.ts`. Do not commit. Do not run `npm run seed`.

An independent reviewer found 11 defects. I reproduced the ones below against the REAL scraped
Understat document and against targeted inputs. Fix them in this order.

---

## FIX A (HIGHEST IMPACT — reproduced on real data) — metadata must be per-SECTION, not per-document

`extractDocMeta` takes the FIRST `**Type:**` in the document and `chunking.ts` stamps that one
value onto every chunk. But the Understat scraper concatenates three sections into ONE document.

Measured on the live Understat EPL page (62,855 chars):

```
distinct **Type:** headers in the document : ["League standings","Player stats","Fixture list"]
distinct Type stamped onto chunks          : ["League standings"]
player-table chunks : 27  -> 27 wrongly stamped "League standings"
fixture-table chunks: 143 -> 143 wrongly stamped "League standings"
```

170 chunks carry actively false metadata. This is worse than no metadata, because the reranker
reads `content`: a fixtures chunk claiming `Type: League standings` gets boosted for standings
queries and buried for fixture queries.

**Required change.** Metadata must be tracked positionally, the same way headings already are.

1. In `parseBlocks`, while scanning lines, also watch for a metadata line matching
   `/\*\*(Type|League|Season):\*\*/`. When one is found, parse **all** the `**Key:** value`
   pairs on that line and update a `currentMeta: DocMeta` cursor (later lines override earlier).
2. Store the meta cursor on each `Block` (`meta: DocMeta`) exactly like `heading`.
3. `splitMarkdownAware` must return chunks paired with their block meta. Change its return type
   to `Array<{ text: string; meta: DocMeta }>` and update both call sites in `chunking.ts`.
4. `createParentChildChunks` builds the prefix **per chunk** from that chunk's own meta, falling
   back to the document-level `extractDocMeta(content)` for any field the block didn't supply
   (so the league/season still resolve when a section header omits them).

After this, a player-stats chunk must read `Type: Player stats` and a fixture chunk
`Type: Fixture list`.

Add to `validateChunking.ts` an assertion using a 3-section document (standings + player stats +
fixtures, each with its own `> **Type:** …` line) that fails unless all three distinct Type
values appear on the right chunks.

---

## FIX B (CRITICAL — reproduced) — a table without a separator gets overlap, duplicating rows

Confirmed with `splitMarkdownAware("| H1 | H2 |\n| a1 | a2 |\n| b1 | b2 |\n| c1 | c2 |", 35, 35)`:

```
[0] "| H1 | H2 |\n| a1 | a2 |\n| b1 | b2 |"
[1] "| H1 | H2 |\n| a1 | a2 |\n| b1 | b2 |\n| c1 | c2 |"
```

Rows `a1` and `b1` appear twice. Duplicated rows corrupt any total or count derived from them.

**Required change.** In `splitTextBlock`, do not apply overlap to a piece that contains table
rows. Concretely: skip `applyOverlap` entirely when either the previous or the current piece
matches `/^\s*\|.*\|\s*$/m`. Overlap stays only for genuine prose.

Also make `parseBlocks` recognise a pipe-table that has a header row followed directly by data
rows with **no** separator line, and treat it as a table block (atomic, no overlap). Emit it with
its header repeated on every piece, same as a well-formed table. Do NOT invent a separator line
in the output.

---

## FIX C (HIGH — reproduced) — heading-only content is silently dropped

`splitMarkdownAware("# One\n\n## Two\n", 20, 5)` returns `[]`. A trailing `## Notes` after the
last table is lost entirely.

**Required change.** Stop discarding heading-only buffers in `flushText`. Instead, carry a
pending-heading list forward and attach it to the next emitted block. If a heading-only buffer
reaches the END of the document with no following block, emit it as its own chunk rather than
dropping it. No input text may vanish.

---

## FIX D (CRITICAL per review) — length filters can delete whole table pieces

`chunking.ts` filters chunks with `length >= 120` (parents) and `>= 80` (children). A trailing
table piece (header + separator + one short row) can fall under 80 chars and be deleted, so that
row exists in no child and is unreachable by retrieval.

**Required change.** Apply the minimum-length filters ONLY to non-table chunks. Any chunk
containing a table data row is kept regardless of length. Keep `isLowValueContent` applied to
both.

---

## FIX E (HIGH) — adjacent tables merge and get the wrong header

Once a table starts, the row loop consumes every following `|` line. Two tables separated by no
blank line cause the second table's header and separator to be swallowed as data rows of the
first — and every split piece then repeats the FIRST table's header over the second table's rows.

**Required change.** While consuming rows, stop the table if the current line is a `|` row AND
the next line is a separator (`TABLE_SEP_RE`) — that is the start of a new table. Break there and
let the outer loop begin a fresh table block.

---

## FIX F (HIGH) — non-positive chunk sizes hang the seed forever

`recursiveTextSplit`'s hard-cut loop does `i += maxSize`. `Number("-1")` is truthy, so
`STATS_CHILD_CHUNK_SIZE=-1` in the environment passes through `env.ts` unchanged and the loop
never terminates — an infinite hang mid-seed.

**Required change.** At the top of `splitMarkdownAware`, coerce sizes defensively:
`const size = Math.max(1, Math.floor(maxSize))` and `const ov = Math.max(0, Math.min(Math.floor(overlap), size - 1))`.
Use those everywhere downstream. Additionally, in `scripts/lib/config/env.ts`, clamp all
`*_CHUNK_SIZE` / `*_OVERLAP` values to sane positives (size >= 1, overlap >= 0 and < size),
logging a warning when a configured value is rejected.

---

## FIX G (MEDIUM — reproduced) — Soccerway season slug mangled

`slugToText` turns `#season/2025-26` into `Season: 2025 26`, and `#league/premier-league` into
`League: premier league`.

**Required change.**
- Do NOT run the season slug through `slugToText` — keep hyphens verbatim (`2025-26`).
- For league, replace hyphens with spaces AND title-case each word (`Premier League`).
- Leave `docType` as-is (hyphens → spaces is fine there).

---

## FIX H (MEDIUM) — prefix is not idempotent

Prefixing is unconditional, so a chunk that already begins with a `League: … | Season: …` line
gets a second one.

**Required change.** In `createParentChildChunks`, skip prepending when the chunk's first line
already equals the prefix's first line.

---

## FIX I (MEDIUM) — quadratic table grouping

`splitTableBlock` rebuilds and re-joins the whole current row group for every row. Measured
7.9s on a pathological table.

**Required change.** Track a running character length instead of calling `buildPiece` inside the
loop; only join once per emitted piece.

---

## FIX J (HIGH) — the validator can pass while data is lost

`validateChunking.ts` concatenates parents AND children before checking row presence, so a row
missing from every child still passes because the parent retained it. It also asserts nothing
about duplication or sizes.

**Required change.** Rewrite the assertions to check, separately for parents and for children:
1. every data row appears **at least once** in the CHILD set (children are what retrieval uses);
2. no data row appears **more than once** within the child set (catches Fix B duplication);
3. every chunk containing a data row also contains a header row for ITS table;
4. every chunk carries a `Season:` and the CORRECT `Type:` for its section (Fix A);
5. heading-only input is not dropped (Fix C);
6. a no-separator table neither duplicates nor drops rows (Fix B);
7. two adjacent tables do not merge (Fix E).

Exit non-zero if any assertion fails. Keep the summary output.

---

## Constraints
- `npx tsc --noEmit` passes; `npx eslint scripts/` clean for touched files; no `any`.
- Do NOT run `npm run seed`; do NOT write to the live collection.
- Prefer correctness over chunk-size purity: it is acceptable for a chunk to exceed `maxSize`
  when the alternative is splitting a table row from its header or dropping content.

## Definition of done
1. `npx tsx scripts/validateChunking.ts` exits 0 with the strengthened assertions.
2. Fixes A–J all present.
3. Append a "Chunker review fixes" section to `.planning/executor-report.md`, and state
   explicitly for each of A–J whether you fixed it, and flag any you disagree with.
