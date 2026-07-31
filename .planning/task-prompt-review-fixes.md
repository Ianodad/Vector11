# Task: Fix review findings on commit a924aca (suggested-prompts feature)

Repo: /data/Documents/vector11, branch `feat/weekly-prompt-refresh` (checked out — work in place).

## Hard rules
- Do NOT run any git commands. No live Astra calls.
- Touch ONLY: `scripts/loadDb.ts`, `scripts/lib/utils/promptGenerator.ts`,
  `app/api/prompts/route.ts`, and a NEW file `scripts/validatePrompts.ts`.
- Match existing code style.

## Findings to fix (from independent review)

1. **MAJOR — Champions League gating dead.** The real corpus tags CL docs via a
   slug round-trip that yields the string "Uefa Champions League" (title-cased
   acronym), which `LEAGUE_DISPLAY_TO_CODE` doesn't contain, so
   `normalizeLeagueName` passes it through and `championsLeaguePrompts` never
   fires. Fix: make `normalizeLeagueName` case-INsensitive (lowercase the key
   into a lowercased map) and add entries for "uefa champions league",
   "champions league", "uefa europa league" → "Europa League", plus the
   existing names. Keep output codes exactly as `promptGenerator` expects.
2. **MAJOR — AFCON gating dead.** AFCON sources (URLs matching
   /africa-cup-of-nations|afcon/i — soccerway, BBC, Wikipedia variants) never
   produce League metadata. Fix IN `loadDb.ts`'s capture block only (do not
   touch scraper files): after the `docMeta.league` handling, if the URL
   matches that regex, `leaguesSeen.add("AFCON")`.
3. **MINOR — upsert not retried.** Wrap the `collection.replaceOne` call in
   the repo's existing `withRetry` helper (already imported in loadDb.ts),
   modest settings (e.g. 3 attempts). Keep the outer try/catch warn-only
   semantics — retry exhaustion still only warns.
4. **MINOR — fallback cached too long.** In `app/api/prompts/route.ts`, the
   FALLBACK response should use `Cache-Control: public, s-maxage=300,
   stale-while-revalidate=3600` (success response keeps the 3600/86400).
5. **MINOR — no regression tests.** NEW `scripts/validatePrompts.ts`
   (mirroring `validateChunking.ts`'s standalone style: run assertions, print
   per-test lines, exit non-zero on failure) covering at least:
   - `normalizeLeagueName`: "Uefa Champions League" → "Champions League";
     "Premier League" → "EPL"; case-insensitivity ("premier league").
   - `captureUnderstatFacts` on a small synthetic combined Understat markdown
     (Standings + Rankings + Fixtures sections with **Remaining:** 0): champion
     + top scorer + goals extracted; and with **Remaining:** 5 → NO champion.
   - `generatePrompts`: leagues gating (CL prompts appear only when
     "Champions League" in leagues; AFCON likewise); no "undefined" substring
     in any prompt for both full-facts and minimal-facts inputs; non-empty and
     de-duplicated output.
   Export the needed helpers from loadDb.ts ONLY if required — prefer moving
   `normalizeLeagueName`/`captureUnderstatFacts`/`LEAGUE_DISPLAY_TO_CODE` +
   related small helpers into `scripts/lib/utils/promptGenerator.ts` (they are
   prompt-domain logic) and importing them back into loadDb.ts, so the test
   imports from a lib module rather than the seed entrypoint.
6. **NIT — leaguesSeen noise.** Drop obviously generic/unusable league strings
   from `leaguesSeen` (e.g. the literal "Football"); keep unknown-but-specific
   ones as-is.
7. **NIT** — failure log in `app/api/prompts/route.ts` should be
   `console.error`.

## Verification (run all; report outputs)
- `npx tsc --noEmit` → clean.
- `npx eslint scripts/ app/` → 0 errors.
- `npx tsx scripts/validatePrompts.ts` → exit 0, and show its output.
- `npx tsx scripts/validateChunking.ts` → exit 0 (regression).
- `npx next build` → succeeds.

## Report format (short)
DONE/BLOCKED · what changed per finding · validatePrompts output · gate outputs.
