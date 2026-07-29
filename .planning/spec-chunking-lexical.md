# SPEC — Table-aware chunking + `$lexical` (items 4 & 5)

Branch `fix/retrieval-season-hybrid` is checked out. Do NOT commit. Do NOT run a full re-seed
(`npm run seed`) — a human will trigger that after reviewing your work.

## Why

The 2025-26 Premier League table is currently stored as three DISCONNECTED chunks:

| chunk | holds | missing |
|---|---|---|
| A | `# Premier League · 2025/26 · League Table` + column key | **all the rows** |
| B | rows 1–12 (Arsenal 85, Man City 78 …) | **season label + column header row** |
| C | rows 13–20 | **season label + column header row** |

`RecursiveCharacterTextSplitter` counts characters and knows nothing about markdown tables.
So retrieval returns a bare grid of numbers with no season attached, and the model falls back
to the older 2024-25 table, which *is* labelled. Verified live: 2 of 6 test queries still fail
this way.

Also: the collection has BM25 (`lexical`) and an NVIDIA reranker enabled, but the seed never
writes the `$lexical` field, so every hybrid result comes back with `$bm25Rank: null`.

**Both facts below were verified live against the real collection — treat as fact:**
- Writing `$lexical: <chunk text>` on insert makes BM25 work and turns `$bm25Rank: null` into
  `$bm25Rank: 1`.
- `EMBEDDING_DIMENSIONS=1536` matches the collection (1536, `dot_product`) and
  `text-embedding-3-large` returns exactly 1536 dims. Do not change any dimension setting.

---

## TASK 1 — New module: `scripts/lib/utils/markdownChunker.ts`

Create this file. It must not import anything from langchain.

### 1a. `extractDocMeta(content: string): DocMeta`

```ts
export interface DocMeta {
  league?: string;
  season?: string;
  docType?: string;
}
```

Parse the two header styles the scrapers actually emit:

**Style A** (Understat — note the doubled spaces around the pipes):
```
> **Type:** League standings  |  **League:** Premier League  |  **Season:** 2025/26  |  **Matchday:** ~38  |  **Source:** https://...
```
Extract with tolerant regexes that allow any run of whitespace around `|`, e.g.
`/\*\*League:\*\*\s*([^|\n]+)/`, `/\*\*Season:\*\*\s*([^|\n]+)/`, `/\*\*Type:\*\*\s*([^|\n]+)/`.
`.trim()` each capture.

**Style B** (Soccerway tag lines):
```
Tags: #league/premier-league #team/arsenal #season/2025-26 #type/fixture
```
Extract `#league/<slug>`, `#season/<slug>`, `#type/<slug>`. Convert slugs to readable text
(replace `-` with spaces). Only use Style B when Style A produced nothing for that field.

Return `{}` when neither style matches. Never throw.

### 1b. `buildChunkPrefix(meta: DocMeta, source: string): string`

Return a single compact line plus a blank line, listing only the fields that exist:

```
League: Premier League | Season: 2025/26 | Type: League standings | Source: Understat EPL
```

If `meta` is empty, return just `Source: <source>` + blank line. Keep it under ~160 chars.

### 1c. `splitMarkdownAware(content, maxSize, overlap): string[]`

A markdown-aware splitter. Rules, in priority order:

1. **A markdown table is atomic.** Detect a table as: a line starting with `|`, followed by a
   separator line matching `/^\s*\|[\s:|-]+\|\s*$/`, followed by one or more `|` rows.
   The header row + separator + all data rows form ONE block.
2. **If a table block exceeds `maxSize`, split it by rows — and REPEAT the header row and
   separator line at the top of every resulting piece.** This is the single most important
   rule in this spec. A table piece must never exist without its header.
3. Non-table content splits on blank lines (paragraphs), then on newlines, then hard-cuts at
   `maxSize` only as a last resort.
4. **Track the nearest preceding markdown heading** (a line starting with `#`, `##`, or `###`)
   and prepend it to any chunk that does not already begin with a heading.
5. Apply `overlap` between adjacent NON-table chunks only. Never overlap table rows (it
   duplicates data rows and corrupts totals).
6. Never emit a chunk that is only a header/separator with no data rows — merge it forward.

Return trimmed, non-empty strings.

---

## TASK 2 — Wire it into `scripts/lib/utils/chunking.ts`

Change `createParentChildChunks` so that:

1. It calls `extractDocMeta(content)` ONCE on the full document, before splitting.
2. Parent chunks come from `splitMarkdownAware(content, parentMaxSize, parentOverlap)` instead
   of `parentSplitter.splitText(content)`.
3. Child chunks come from `splitMarkdownAware(parentChunk, childMaxSize, childOverlap)`.
4. **Every parent AND every child chunk is prefixed with `buildChunkPrefix(meta, source)`**
   before being stored/embedded. The prefix must be part of the stored `content`, because the
   reranker reads `content`.
5. Keep the existing filters (`length >= 120` for parents, `>= 80` for children,
   `!isLowValueContent(...)`). Apply them to the chunk BEFORE the prefix is added, so the
   prefix cannot rescue junk chunks.

Change the signature to accept the four sizes instead of two splitter objects:

```ts
export const createParentChildChunks = async (
  content: string,
  sizes: { parentMaxSize: number; parentOverlap: number; childMaxSize: number; childOverlap: number },
  source: string,
  url: string,
  category: string,
  isLowValueContent: (text: string) => boolean,
): Promise<ChunkingResult | null>
```

Update the single call site in `scripts/loadDb.ts` (~line 228) to pass the sizes it already
computes from `isStats` (stats → `STATS_CHUNK_SIZE`/`STATS_CHUNK_OVERLAP` +
`STATS_CHILD_CHUNK_SIZE`/`STATS_CHILD_CHUNK_OVERLAP`; otherwise the `DEFAULT_*`/`CHILD_*` pair).

`scripts/lib/embeddings/splitters.ts` and its `initializeSplitters` call become unused —
delete the file and remove its import/usage from `loadDb.ts`.

---

## TASK 3 — Write `$lexical` so BM25 works

In `scripts/lib/database/operations.ts`, `batchInsertChildren`: add `$lexical: chunk` alongside
`$vector` on every child document. Add `$lexical?: string` to the `ChildRecord` interface in
`chunking.ts`.

Children only — parents are fetched by `_id` and never searched.

---

## TASK 4 — Don't lose lexical/rerank on a collection recreate

`createCollection` in `scripts/lib/database/collection.ts` creates collections with ONLY
`vector`. The live collection currently has `lexical` and `rerank` enabled. If a re-seed drops
and recreates it, that configuration would silently vanish and hybrid search would break.

Add both to EVERY `db.createCollection(...)` call in that file (there are three):

```ts
await db.createCollection(collectionName, {
  vector: { dimension: vectorDimensions, metric: similarityMetric },
  lexical: { enabled: true, analyzer: "standard" },
  rerank: {
    enabled: true,
    service: { provider: "nvidia", modelName: "nvidia/llama-3.2-nv-rerankqa-1b-v2" },
  },
});
```

Types (already in the SDK): `CollectionLexicalOptions { enabled: boolean; analyzer?: string | Record<string, unknown> }`,
`CollectionRerankOptions { enabled?: boolean; service: RerankServiceOptions }`.

---

## TASK 5 — Validation script (this is how we avoid wasting a 2-hour re-seed)

Create `scripts/validateChunking.ts`, runnable with `npx tsx scripts/validateChunking.ts`.
It must NOT touch the production collection.

It should:
1. Build a realistic fake Understat league-table document in memory — the `# ... League Table`
   heading, the `> **Type:** ... **Season:** 2025/26 ...` line, a Column Key section, and a
   full 20-row markdown table with the real column header
   `| Pos | Team | MP | W | D | L | GF | GA | GD | Pts | xG | xGA | xGD | xPts |`.
2. Run it through `createParentChildChunks` with the stats sizes (1500/200, 400/50).
3. Print, and ASSERT with a non-zero exit on failure:
   - **every** chunk containing a table data row also contains the `| Pos | Team |` header row
   - **every** chunk contains `Season: 2025/26`
   - no chunk is a bare header with no data rows
   - all 20 teams appear somewhere across the chunks (nothing silently dropped)
4. Print a compact before/after summary: chunk count, and the first 200 chars of each chunk.

Exit 0 only if every assertion passes.

---

## Constraints
- `npx tsc --noEmit` must pass.
- `npx eslint scripts/` must report **0 errors and 0 warnings** for files you touch. No `any`.
- Do NOT run `npm run seed`. Do NOT drop, recreate or write to the live collection.
- Do NOT change embedding dimensions, models, or `app/api/chat/route.ts`.

## Definition of done
1. `npx tsc --noEmit` passes.
2. `npx eslint scripts/` clean for touched files.
3. `npx tsx scripts/validateChunking.ts` exits 0 with all assertions passing.
4. Append a "Chunking + lexical" section to `.planning/executor-report.md` covering what you
   changed, the validation output, and anything you disagreed with or could not do.
