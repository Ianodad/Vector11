# TASK — fix silent content loss at chunk boundaries + a broken test assertion

Edit `/data/Documents/vector11/scripts/lib/utils/markdownChunker.ts` and
`/data/Documents/vector11/scripts/validateChunking.ts`. No other files.
Do not commit. Do not run `npm run seed`.

## Bug 1 (REAL — data loss) — a multi-byte character at a chunk boundary is DROPPED

Reproduce:

```ts
const input = "a".repeat(399) + "\u{1F600}" + " tail text";   // 411 UTF-16 units
await splitMarkdownAware(input, 400, 0);
```

Actual:
```
chunks=2   unitsOut=408   emojiPreserved=false
  [0] units=399   "aaa…a"
  [1] units=9     "tail text"
```

**3 units vanish (the emoji + the following space).** No `U+FFFD` is produced — the code
correctly refuses to split the surrogate pair, but then **throws the remainder away** instead of
carrying it into the next chunk.

With `overlap=50` it happens to survive (the overlap re-includes it), which is why this was
missed. Silent content loss at ANY setting is unacceptable.

**Required fix.** Wherever a cut is shortened to avoid splitting a code point, the bytes that
were not emitted MUST be carried forward into the next chunk. No input character may ever be
absent from the output.

Concretely: audit every place a chunk boundary is computed — including `utf8SafeCut` usage and
the handling of pieces returned by `RecursiveCharacterTextSplitter`. If a piece is trimmed or
shortened, the remainder becomes the head of the next piece. `utf8SafeCut` itself may still
truncate as a LAST resort for the absolute byte ceiling, but callers must not silently discard
what it removed — they must re-chunk it.

**Invariant to guarantee:** for any input, concatenating the emitted chunk texts (after removing
any deliberate overlap) contains every non-whitespace character of the input, in order.

## Bug 2 (test defect) — the emoji assertion can never pass

`scripts/validateChunking.ts`, in `runEmojiTest`:

```ts
if (c.text.includes("")) {     // <-- EMPTY STRING
```

The intended U+FFFD literal was lost when the file was written. Every string contains the empty
string, so this assertion fires unconditionally and the test fails no matter what the code does.

Replace it with an escape sequence that cannot be mangled:

```ts
const REPLACEMENT_CHAR = "�";
...
if (c.text.includes(REPLACEMENT_CHAR)) {
```

Use the `"�"` escape — never paste the literal glyph.

## Bug 3 (test gap) — nothing asserts content preservation

Add to `runEmojiTest`, and run it for BOTH `overlap = 0` and `overlap = 50`:

1. The emoji survives: `chunks.some((c) => c.text.includes("\u{1F600}"))`.
2. No chunk contains `"�"`.
3. Every chunk round-trips: `Buffer.from(t, "utf8").toString("utf8") === t`.
4. No chunk contains a lone surrogate:
   `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t) === false`.
5. **Content preservation**: strip all whitespace from the input and from the concatenated
   chunk texts; assert every character of the stripped input appears in the stripped output.
   (Overlap may duplicate content — that is fine here; loss is not.)

Also add a `runContentPreservationTest` that runs a mixed document (prose + a table + a heading +
multi-byte characters `😀 · − é`) through `splitMarkdownAware` at several sizes
(`[100, 400, 1500]`) with `overlap = 0`, asserting the same content-preservation invariant each
time.

## Constraints
- `npx tsc --noEmit` clean; `npx eslint scripts/` clean for touched files; no `any`.
- Do NOT weaken or delete any existing test or assertion.
- Do NOT run `npm run seed` or write to the live database.

## Done when
- `npx tsx scripts/validateChunking.ts` exits **0** with all assertions passing, including the
  new emoji and content-preservation ones.
- The reproduce case above returns chunks whose concatenation still contains `\u{1F600}` at
  `overlap = 0`.
