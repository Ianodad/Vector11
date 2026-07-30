Fixes K–N are done and verified. Summary:

**What changed:**
- **Fix K** (`markdownChunker.ts`): added `MAX_CHUNK_BYTES = 7000` and a final byte-ceiling enforcement pass in `splitMarkdownAware` — oversized table pieces get re-split by row (byte-driven, header repeated on each piece), and a single row too wide even with its header gets hard-cut across multiple UTF-8-safe pieces so nothing is silently lost; oversized text pieces re-run the recursive splitter then hard-cut.
- **Fix L** (`chunking.ts`): exported `MAX_DOCUMENT_BYTES = 8000` and added `enforceDocByteLimit`, a defensive backstop that truncates only the chunk (never the prefix) if `prefix + chunk` ever exceeds 8,000 bytes, with a `console.warn`.
- **Fix M** (`operations.ts` + `loadDb.ts`): a document-size rejection is now caught, logged (`_id`/source/url), counted, and skipped instead of aborting the batch; `InsertResult` gained `recordsSkipped`, and `loadDb.ts` prints `Skipped N oversized documents` at end of run.
- **Fix N** (`validateChunking.ts`): new test builds a ~20,000-char multi-byte wide table row and asserts every emitted chunk (through the real `createParentChildChunks` pipeline, prefix included) stays ≤8,000 bytes, round-trips through UTF-8 cleanly, and that the wide row's content still appears with its header intact.

**Verification:** `tsc --noEmit` clean, `eslint scripts/` clean (only pre-existing unrelated warnings), `validateChunking.ts` exits 0 with all 6 test groups passing. No commit made, `npm run seed` never run, live collection untouched.

One thing worth your attention: an untracked file `_accuracy.ts` appeared at the repo root partway through this session — not something I created, unrelated to this spec, and it talks to the live Astra collection. It has pre-existing TS errors that make a whole-project `tsc` noisy (I filtered those out to verify my own files were clean, and left the file untouched since it isn't mine to touch). You may want to check where that came from. Full writeup with all disagreements is appended to `.planning/executor-report.md` under "Astra limits (Fixes K–N)".
