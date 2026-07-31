# Task: Strengthen validateChunking per Codex finding 9 (MINOR, but gate-critical)

Repo: /data/Documents/vector11 (branch fix/retrieval-season-hybrid — work in place)

## Hard rules
- Do NOT run any git commands.
- Touch ONLY `scripts/validateChunking.ts`.
- The chunker fixes for Codex blockers 1–2 are ALREADY APPLIED in
  `scripts/lib/utils/markdownChunker.ts` and `scripts/lib/utils/chunking.ts`
  (split-not-truncate: oversized prefix+chunk is split into multiple ≤8000-byte
  records, content never discarded; table raw-cut loop has a guaranteed
  forward-progress fix). Read both files first to understand the NEW behavior —
  the validator must assert it.
- Match existing code style.

## Codex finding 9 (why the validator passed while 5 blockers existed)
- The byte-ceiling test at ~line 376 contains the carve-out "truncation is
  allowed" — it only asserts the wide row appears SOMEWHERE, so total content
  loss of everything but one fragment still passes.
- Checks are presence-only: no order or count assertions, so dropped or
  duplicated middle content passes.
- Trailing whitespace at lines ~395 and ~589 fails `git diff --check`.

## Required changes
1. REMOVE the truncation allowance. Content preservation must be strict:
   for each synthetic test document, every content unit (each table row, each
   prose sentence/marker) must appear in the union of output chunks. Build the
   test docs with NUMBERED markers (e.g. `ROW-017`, `MARK-042`) so the
   validator can assert: (a) COUNT — all N markers present, (b) ORDER — markers
   appear in non-decreasing document order when chunks are walked in emission
   order (allow overlap-induced repeats; order check is on first occurrence),
   (c) NO DUPLICATE LOSS — no marker missing.
2. Add two regression tests for the fixed blockers:
   - Giant-header table: header line ~7,900 bytes + several multi-KB rows with
     multibyte chars (·, −, 😀). Assert: terminates (wrap the call in a
     Promise.race 30s timeout → failure, not hang), every chunk ≤ 8000 bytes,
     every row marker survives, UTF-8 round-trip clean.
   - Oversized prefix+content through `createParentChildChunks`: engineer
     metadata + chunk so prefix+text exceeds 8000 bytes with a unique marker in
     the final 100 bytes. Assert: every parent AND child content ≤ 8000 bytes
     (byte check on the actual stored `content` strings), the tail marker
     survives in at least one parent and one child, and (if the split produced
     multiple parents) every parent id is unique.
3. Keep ALL existing tests (they may only be strengthened, never weakened or
   deleted). The suite must still exit non-zero on any failure and print the
   same per-test summary style.
4. Remove trailing whitespace throughout the file; `git diff --check` must be
   clean for this file.

## Verification (run all; report results)
- `npx tsx scripts/validateChunking.ts` → exit 0 against the FIXED chunker.
- Sanity: temporarily break the chunker in ONE trivial way in memory to prove
  the new checks bite — do this by writing a THROWAWAY copy of the relevant
  test into `/tmp/claude-1000/-data-Documents-vector11/4b2b3f24-e0b1-498b-8293-7f8b5fd7c105/scratchpad/` that feeds a deliberately-lossy chunk list into your
  marker-check helper and asserting it FAILS. Do NOT modify the real chunker
  files.
- `npx tsc --noEmit` → clean. `npx eslint scripts/` → 0 errors.
- `git diff --check` → no whitespace errors in validateChunking.ts.

## Report format (short)
DONE/BLOCKED · what you strengthened (bullets) · proof the new checks can fail
(throwaway test result) · verification outputs. No file dumps.
