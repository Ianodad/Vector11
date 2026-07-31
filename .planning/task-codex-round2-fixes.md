# Task: Fix Codex round-2 findings 2 (MAJOR) and 3 (MINOR)

Repo: /data/Documents/vector11 (branch fix/retrieval-season-hybrid — work in place)

## Hard rules
- Do NOT run any git commands.
- Touch ONLY: `scripts/lib/utils/chunking.ts` and `scripts/validateChunking.ts`.
- Match existing code style.

## Finding 2 (MAJOR) — capped/uncapped prefix disagreement can throw and abort a seed

In `scripts/lib/utils/chunking.ts`:
- `splitOversizedText` (~line 115) makes its "does it fit?" decision with the
  UNCAPPED prefix: `const full = prependPrefix(text, prefix)`. When `text`
  already begins with the prefix's first line, `prependPrefix` dedups and
  returns `text` unchanged, which can pass the ≤8000 check → returns `[text]`
  unsplit.
- `enforceDocByteLimit` (~line 98) then CAPS the prefix first
  (`capPrefix`), whose first line may differ from the original (byte-cut can
  land mid-first-line), so `prependPrefix` no longer dedups → it prepends the
  capped prefix onto text that still carries the original prefix content →
  exceeds 8000 bytes → THROWS. Codex reproduced this. The throw happens in
  `createParentChildChunks` BEFORE the per-URL try/catch in loadDb.ts, so one
  pathological doc aborts the entire (post-drop!) seed run.

Fix — make both functions agree by capping FIRST, everywhere:
- In `splitOversizedText`, compute `const usablePrefix = capPrefix(prefix, source, url)`
  at the top and use `usablePrefix` for BOTH the initial
  `prependPrefix(text, usablePrefix)` fit check AND the budget (it already
  uses it for the budget). The uncapped `prefix` must not be used anywhere in
  the function after that point.
- `capPrefix` is idempotent (already-capped input is returned unchanged), so
  `enforceDocByteLimit`'s internal `capPrefix` then produces the identical
  string and the dedup decision matches. Verify this reasoning holds by
  reading `capPrefix` + `prependPrefix` carefully; if you find any remaining
  path where the two functions can disagree on the final prefix string, fix
  that too (one shared capped value is the goal).
- Note: `capPrefix` warns on every call when the prefix is pathological; with
  it now called in split + enforce for the same doc, dedupe the warning if
  trivial (e.g. only warn in capPrefix via a module-level Set keyed on
  source+url, or accept the duplicate warn if non-trivial — your call, note it
  in the report).

## Finding 3 (MINOR) — giant-header validator timeout cannot catch a synchronous hang

In `scripts/validateChunking.ts` (~line 503): `withTimeout(splitMarkdownAware(...), 30_000, ...)`
evaluates the promise argument first; the table path of `splitMarkdownAware`
is CPU-synchronous, so a regressed infinite loop would block the event loop
and the 30s timer would never fire — the test can't catch the exact hang it
exists for.

Fix — process isolation:
- Extract the giant-header input construction into a small exported helper or
  duplicate it in a tiny standalone runner script (put the runner at
  `scripts/lib/utils/__giantHeaderProbe.ts` or a similarly-named sibling —
  it must live in the repo since CI runs the validator; keep it minimal: build
  the doc, run `splitMarkdownAware`, print the resulting chunks as JSON to
  stdout, exit 0).
- In the validator, run it via `spawnSync(process.execPath, ["node_modules/.bin/tsx" or use "npx tsx", ...], { timeout: 30_000 })`
  — use whatever invocation provably works locally (`npx tsx <file>` with
  `timeout` and `killSignal: "SIGKILL"` is fine). A timeout/kill or non-zero
  exit → push a failure ("giant-header table hung or crashed"). On success,
  parse the JSON chunks from stdout and run the SAME assertions as now
  (≤8000 bytes, UTF-8 round-trip, no U+FFFD, marker coverage).
- Keep the existing in-process `withTimeout` helper only if still used
  elsewhere; remove it if now dead code.

## Verification (run all; report results)
- `npx tsx scripts/validateChunking.ts` → exit 0 (and confirm the
  giant-header test now visibly runs through the subprocess — mention its
  runtime).
- Regression bite-check: temporarily (in a THROWAWAY copy under
  /tmp/claude-1000/-data-Documents-vector11/4b2b3f24-e0b1-498b-8293-7f8b5fd7c105/scratchpad/, NOT the repo) reproduce Codex's finding-2 scenario:
  craft a doc whose text starts with the prefix's first line while the prefix
  is pathological (>6976 bytes) and confirm that WITH your fix
  `createParentChildChunks` returns records all ≤8000 bytes with no throw
  (and without the fix it threw — you can demonstrate by reasoning from the
  old code path if reverting is impractical, but a live passing repro of the
  fixed path is REQUIRED).
- `npx tsc --noEmit` → clean. `npx eslint scripts/` → 0 errors.
- `git diff --check` → clean.

## Report format (short)
DONE/BLOCKED · what changed per finding · repro results · verification outputs.
