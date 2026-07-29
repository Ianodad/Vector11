# TASK — fix 4 validator failures in the chunker

Edit ONLY `/data/Documents/vector11/scripts/lib/utils/markdownChunker.ts`.
Do not touch the validator or any other file — the tests are correct; the code is wrong.
Do not commit. Do not run `npm run seed`.

`npx tsx scripts/validateChunking.ts` currently fails with 4 issues. All four trace to the
"last-line defence" byte-ceiling loop at the end of `splitMarkdownAware` (~line 448-472).

## Bug 1 — the final flush is NOT capped (CRITICAL: Astra will reject the document)

```ts
if (pendingText.trim().length > 0 && processedChunks.length > 0) {
  processedChunks.push({ text: pendingText.trim(), ... });   // <-- never cut
}
```

Reproduced with a table whose header line is 8,000 bytes:

```
[0] bytes=7000   [1] bytes=7000   [2] bytes=7000   [3] bytes=24049   <-- BOOM
```

Astra rejects indexed strings over **8,000 bytes**, so that document fails to insert.

**Fix:** the trailing `pendingText` must go through the same ceiling logic, and it must LOOP —
one `utf8SafeCut` call can only produce one capped chunk, so a 24 KB remainder needs to become
four chunks, not one. Keep cutting until the remainder is empty.

## Bug 2 — the per-chunk cut is single-pass

Inside the main loop, `utf8SafeCut(fullText, MAX_CHUNK_BYTES)` is called once and the remainder
is carried to the next iteration. If the remainder is itself larger than the ceiling it keeps
growing instead of being emitted. Make this a `while` loop that emits as many capped chunks as
needed before moving on.

## Bug 3 — content is LOST at the tail

Reproduced with `splitMarkdownAware("a".repeat(399) + "😀" + " tail text", 400, 0)`:

```
stripped input  = 409 chars
stripped output = 401 chars      <-- " tail text" vanished
only 1 chunk emitted
```

Two causes:
- the trailing-`pendingText` branch is guarded by `processedChunks.length > 0` and by
  `.trim()`, so content can be silently discarded;
- `cut.trim()` is applied before the length check, so a piece that is only whitespace plus a
  carried remainder can be dropped along with the remainder.

**Fix:** never discard `pendingText`. After the loop, drain it completely (looping per Bug 1),
regardless of how many chunks were already emitted. Trim only for presentation — never let
trimming decide whether content is kept.

**Invariant to guarantee:** for every input, stripping all whitespace from the input and from
the concatenated output, every input character appears in the output, in order.

## Bug 4 — a byte-cut TABLE piece loses its header

```
[1] startsWithHeader=false ... (continuation rows with no "| Pos | Team |" header)
```

The ceiling loop is generic text surgery — it doesn't know a chunk is a table, so the
continuation piece is raw rows with no header. That is the exact bug this whole workstream
exists to prevent.

**Fix:** make the ceiling pass table-aware. If the chunk being cut contains a table header
(a `|` row, optionally followed by a `|---|` separator), then every continuation piece produced
from it must repeat that header (and separator) at the top. Re-use the existing
`packTableRows` / `buildPiece` logic rather than writing a second implementation — split the
oversized table piece by ROWS with the header repeated, and only fall back to raw byte cutting
when a SINGLE row plus its header still exceeds the ceiling (in which case cut the row but keep
the header on each piece).

## Constraints
- `npx tsc --noEmit` clean; `npx eslint scripts/lib/utils/markdownChunker.ts` clean; no `any`.
- **Do not modify `scripts/validateChunking.ts`.** If a test seems wrong, say so in your report
  instead of changing it.
- Do not weaken `MAX_CHUNK_BYTES` (7000) or the existing table/section/prose behaviour.
- Content preservation beats size purity: cutting is a last resort, dropping is never allowed.

## Done when
`npx tsx scripts/validateChunking.ts` exits **0** with ALL assertions passing, including:
- no chunk over 7,000 bytes (the 24,049-byte chunk is gone)
- every table piece carries its header
- no content loss at `overlap=0`
- emoji preserved, no U+FFFD, no lone surrogates
