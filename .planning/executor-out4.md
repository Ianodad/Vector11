Everything matches expectations — no changes to `app/api/chat/route.ts` (pre-existing modification from prior work, untouched by me), and only the scoped `scripts/` files were changed. Not committing, per instructions.

## Summary

Implemented table-aware markdown chunking + `$lexical` (BM25) writes on branch `fix/retrieval-season-hybrid`, uncommitted:

1. **New `scripts/lib/utils/markdownChunker.ts`** — `extractDocMeta` (Style A/B header parsing), `buildChunkPrefix`, and `splitMarkdownAware` (keeps markdown tables atomic with their header row, even when splitting an oversized table by rows; tracks nearest heading; overlaps only non-table text).
2. **`chunking.ts`** — `createParentChildChunks` now takes a `sizes` object, uses `splitMarkdownAware` instead of the langchain splitter, and prefixes every parent/child chunk with `League/Season/Type/Source` metadata (filters still apply before the prefix).
3. **`loadDb.ts`** — updated call site to pass stats vs. default sizes; removed `initializeSplitters`. Deleted the now-unused `scripts/lib/embeddings/splitters.ts`.
4. **`operations.ts`** — `batchInsertChildren` writes `$lexical: chunk` alongside `$vector`.
5. **`collection.ts`** — both `createCollection` calls (found 2, spec said 3) now request `lexical` and `rerank` so a re-seed recreate won't silently drop hybrid search config.
6. **New `scripts/validateChunking.ts`** — in-memory 20-row fake table doc, asserts headers always travel with rows, season always present, no bare-header chunks, no dropped teams. Exits 0, all assertions pass.

Verified: `npx tsc --noEmit` clean, `npx eslint scripts/` clean on every touched file (4 pre-existing warnings remain only in an untouched file), validation script passes. Appended a "Chunking + lexical" section to `.planning/executor-report.md` with full details and two flagged items: the spec's "three createCollection calls" claim (only 2 exist), and an out-of-scope duplicate chunking implementation in `app/api/cron/update-db/route.ts` that still has the old bug. No seed run, no commit made, live collection untouched.
