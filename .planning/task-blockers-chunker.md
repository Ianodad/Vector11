# Task: Fix Codex BLOCKERs 1–2 — chunker liveness + 8000-byte invariant

Repo: /data/Documents/vector11 (branch fix/retrieval-season-hybrid — already checked out; work in place)

## Hard rules
- Do NOT run any git commands. No commits, no staging. Leave edits in the working tree.
- Touch ONLY: `scripts/lib/utils/markdownChunker.ts` and `scripts/lib/utils/chunking.ts`.
  Another agent is editing `scripts/lib/database/*` and `scripts/loadDb.ts` concurrently — do not open/edit those.
- Do NOT edit `scripts/validateChunking.ts` (a later task strengthens it).
- Match existing code style/comment density.

## BLOCKER 1 — zero-progress loop in table raw-cut (`markdownChunker.ts` ~line 529)

Current code (raw-cut branch for a single oversized table row):

```ts
let rem = tPiece;
while (rem.length > 0) {
  if (byteLen(rem) <= MAX_CHUNK_BYTES) { ...push; break; }
  const { cut, remainder } = utf8SafeCut(rem, MAX_CHUNK_BYTES);
  ...push cut...
  if (remainder.length === 0) break;
  rem = canAddHeader ? headPrefix + remainder : remainder;
}
```

Failure: when `headPrefix` is nearly MAX_CHUNK_BYTES (e.g. ~7,999 bytes), the cut
budget leaves no room for even one multibyte code point of the real remainder.
`utf8SafeCut` backs off to the code-point boundary, so `cut == headPrefix` and
`remainder` is unchanged → `rem = headPrefix + remainder` recreates the exact
same input → infinite loop (Codex reproduced a hang). A hang mid-seed is
catastrophic.

Required fix (both parts):
1. Tighten `canAddHeader`: only re-prepend the header when it leaves meaningful
   room, e.g. `headPrefixBytes <= MAX_CHUNK_BYTES - 64` (pick a named constant
   with a short comment: room for at least a few code points of row content).
2. Explicit forward-progress guarantee (belt and braces): each iteration must
   strictly shrink the un-emitted, header-less remainder. Track the previous
   remainder (the part WITHOUT the prepended header); if an iteration fails to
   consume at least one byte of it, stop prepending the header for subsequent
   iterations of this piece and continue raw-cutting the bare remainder. The
   loop must be provably terminating for ANY input (any header size, any
   multibyte content).

Content must never be dropped; header re-prepending is best-effort context, not
worth a hang or loss.

## BLOCKER 2 — 8,000-byte invariant breakable + silent content discard (`chunking.ts` ~line 76)

Current `enforceDocByteLimit(prefix, chunk, ...)` truncates the chunk to fit
`MAX_DOCUMENT_BYTES` (8000) after the prefix. Two proven failures:
- Unbounded prefix: if the prefix alone is ≥ 8000 bytes, budget clamps to 0,
  `cut` is empty, and the returned string is the full oversized prefix →
  8,074-byte records were reproduced. Invariant broken.
- The truncated remainder of the chunk is DISCARDED — Codex's adversarial
  marker vanished from all parents and children. Silent content loss.

Required fix — split, don't truncate:
1. Replace the truncation semantics with a helper that returns `string[]`:
   every returned piece is `prefix + slice-of-chunk` and every piece is
   ≤ MAX_DOCUMENT_BYTES bytes. Use `utf8SafeCut` in a loop over the chunk
   portion (never split a code point; reuse the progress-safe pattern from
   Blocker 1). ALL chunk content must appear across the pieces — nothing
   dropped.
2. Pathological prefix cap: if the prefix itself exceeds
   `MAX_DOCUMENT_BYTES - 1024`, `utf8SafeCut` the PREFIX down to that bound
   first and `console.warn` loudly (prefix metadata tail lost is acceptable
   and logged; chunk content loss is not). This guarantees ≥ 1024 bytes of
   chunk budget per piece, so the split loop terminates.
3. Wire the call sites in `createParentChildChunks`:
   - Parent: if `enforce...` returns N > 1 pieces for `parent.text`, emit N
     parent records. Each extra parent gets its own `_id`
     (`md5(piece-content)` — hash the piece, mirroring the existing
     hash-of-text approach) and the SAME children flow: derive children from
     each piece's un-prefixed slice? — NO: keep it simpler and safer:
     split `parent.text` BEFORE record creation. I.e., after
     `filteredParents`, expand each parent whose `prefix + text` would exceed
     the ceiling into multiple parent entries (cutting `parent.text` with the
     helper's budget logic), each carrying the same `meta`. Then the existing
     per-parent loop (record + children derivation) runs unchanged on
     already-fitting parents, and `enforceDocByteLimit` becomes a true
     never-triggers backstop that may THROW if it would ever need to split
     (making the invariant fail-fast instead of silent).
   - Child: same approach — expand oversized children into multiple child
     texts (each gets its own embedding), same parentId.
   Choose the cleanest implementation consistent with the above; the
   non-negotiables are: (a) no stored field ever exceeds 8000 bytes,
   (b) no chunk content is ever silently dropped, (c) parent-child linkage
   stays correct, (d) no infinite loops for any input.

## Verification (run all; report results)
- `npx tsx scripts/validateChunking.ts` → must exit 0.
- `npx tsc --noEmit` → clean.
- `npx eslint scripts/` → 0 errors (4 pre-existing htmlScraper warnings OK).
- Write a THROWAWAY repro at `/tmp/claude-1000/-data-Documents-vector11/4b2b3f24-e0b1-498b-8293-7f8b5fd7c105/scratchpad/repro-blockers.ts` (NOT in the repo) that:
  1. Feeds the table path a synthetic doc whose table header is ~7,990 bytes
     with a multi-KB single row of multibyte chars (·, −, 😀) — assert it
     terminates (wrap in a 30s timeout) and every output ≤ 8000 bytes.
  2. Calls `createParentChildChunks` with a doc engineered to produce
     prefix+chunk > 8000 bytes containing a unique marker string in the tail —
     assert every parent/child content ≤ 8000 bytes AND the marker survives in
     at least one record.
  Run it with `npx tsx` and include the output in your report.

## Report format (short)
DONE/BLOCKED · files changed · what you changed for each blocker (3–5 lines) ·
verification outputs (validator exit, tsc, eslint, repro results). No file dumps.
