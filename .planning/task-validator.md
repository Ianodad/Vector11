# TASK — finish updating scripts/validateChunking.ts

Edit ONLY `/data/Documents/vector11/scripts/validateChunking.ts`. Do not touch any other file.
Do not commit. Do not run `npm run seed`.

## Context

`scripts/lib/utils/markdownChunker.ts` was just rewritten. Its API changed:

```ts
export interface DocMeta { league?: string; season?: string; docType?: string }
export interface Chunk { text: string; meta: DocMeta }

// WAS: (content, maxSize, overlap) => string[]
// NOW: async, and returns objects
export const splitMarkdownAware = async (
  content: string, maxSize: number, overlap: number,
): Promise<Chunk[]>

export const utf8SafeCut: (s: string, maxBytes: number) => string
export const MAX_CHUNK_BYTES: number  // 7000
```

`validateChunking.ts` was NOT updated for this and now fails to compile.

## Part 1 — fix the compile errors (mechanical)

These three functions still call the old sync API:
- `runNoSeparatorTableTest` (line ~221)
- `runHeadingOnlyTest` (line ~251)
- `runAdjacentTablesTest` (line ~271)

For each:
1. Change the signature from `(): Failures` to `async (): Promise<Failures>`.
2. `await` the `splitMarkdownAware(...)` call.
3. The result is `Chunk[]`, not `string[]` — read the text via `.text` (e.g.
   `const pieces = (await splitMarkdownAware(...)).map((c) => c.text)`).
4. Add explicit types to every callback parameter — `(p: string, idx: number)` etc.
   **No implicit `any` and no explicit `any`.**
5. Update `main()` to `await` these three calls.

## Part 2 — add four new tests

Follow the existing file's style exactly: each test returns `Failures`, pushes a descriptive
string per failed assertion, prints a `\n=== Name: ... ===` header, and is awaited from `main()`.

### `runEmojiTest`
Input containing a 4-byte non-BMP character, e.g. `"a".repeat(399) + "😀" + " tail text"`,
split at `maxSize = 400`. Assert for EVERY chunk:
- no U+FFFD replacement character that was not in the input: `!c.includes("�")`
- it round-trips: `Buffer.from(c, "utf8").toString("utf8") === c`

### `runProseMultiSectionTest`
A prose-only document (NO tables) with two sections:

```
> **Type:** Alpha  |  **League:** EPL  |  **Season:** 2025/26

Alpha section prose about the first topic, long enough to stand as its own chunk of text.

> **Type:** Beta  |  **League:** EPL  |  **Season:** 2025/26

Beta section prose about the second topic, also long enough to stand as its own chunk.
```

Split at `maxSize = 200`, `overlap = 0`. Assert:
- chunks whose text mentions "Alpha section prose" have `meta.docType === "Alpha"`
- chunks whose text mentions "Beta section prose" have `meta.docType === "Beta"`
- at least two DISTINCT `meta.docType` values appear overall

(This currently regresses: everything gets stamped with the LAST section's Type.)

### `runOversizedHeaderTest`
A table whose HEADER line alone exceeds 7,000 bytes (e.g. `"| " + "H".repeat(8000) + " |"`),
followed by a separator row and 3 short data rows. Assert:
- every emitted chunk is `<= MAX_CHUNK_BYTES` bytes via `Buffer.byteLength(c, "utf8")`
- the result is not empty (content is cut, never dropped entirely)

### `runRowCoverageTest`
A 25-row table. Run it through `createParentChildChunks` with stats sizes
(parent 1500/200, child 400/50). Assert, across the CHILD texts only:
- every data row appears **at least once**
- no data row appears **more than once** (catches duplication)

## Constraints
- `npx tsc --noEmit` must pass with zero errors.
- `npx eslint scripts/validateChunking.ts` must report zero errors and zero warnings.
- No `any`, explicit or implicit.
- Keep ALL existing tests and assertions intact.
- The script must exit non-zero if any assertion fails, zero if all pass.

## Done when
`npx tsc --noEmit` is clean and `npx tsx scripts/validateChunking.ts` runs to completion
(it is OK and EXPECTED for the new tests to REPORT failures — that means they are working;
what must not happen is a crash or a compile error).
