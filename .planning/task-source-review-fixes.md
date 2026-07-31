# Task: Fix review findings on the source-migration commits (26734bc, 8769dfc)

Repo: /data/Documents/vector11, branch `feat/source-migration` (checked out — work in place).

## Hard rules
- Do NOT run any git commands.
- Files you may modify: `scripts/lib/scrapers/apiFetchers.ts`,
  `scripts/validateSources.ts`, `scripts/lib/utils/promptGenerator.ts`,
  `scripts/lib/scrapers/evaluators/statsEvaluator.ts`,
  `scripts/lib/config/dataSources.ts`.
- Live fetches allowed for verification (zero-key endpoints only).
- No new dependencies. Match existing code style.

## Findings to fix

1. **BLOCKER — rowspan/colspan misalignment in `wikipediaHtmlToMarkdown`.**
   Current per-<tr> cell extraction ignores rowspan/colspan; live-verified on
   the `UEFA_Champions_League` article: rowspanned label cells vanish and all
   subsequent cells shift left, padded with trailing "-" — silently WRONG data.
   Fix: proper grid expansion. Parse each cell's `rowspan`/`colspan`
   attributes; maintain a carry-over grid so a rowspanned cell's text is
   REPEATED into the same column of the following rows it spans, and a
   colspanned cell is repeated (or padded) across its columns. After
   expansion all rows must have equal width WITHOUT positional shifts.
   If a table is malformed beyond this model (mismatched widths after
   expansion), SKIP that table and emit an HTML comment-free one-line note
   (e.g. `*[table omitted: complex layout]*`) rather than shipping shifted
   data. Add a validateSources test with a fixture table using BOTH rowspan
   and colspan asserting the expanded grid puts the right text in the right
   columns (assert a specific cell value at a specific column index, not just
   column counts). Re-verify live against the UEFA_Champions_League article
   and show the previously-broken table region in your report.

2. **MAJOR — single-year titles get current-season fallback.**
   `deriveSeasonFromTitle` only matches range titles ("2025–26 …"); "2025
   Africa Cup of Nations" fell through to the CURRENT season → labeled
   2026/27, a full-year mislabel. Fix: add a second pattern — a standalone
   4-digit year Y (1900–2100) in the title → `seasonString(Y)` (AFCON 2025 →
   "2025/26", correct: tournament ran Dec 2025–Jan 2026). Range pattern takes
   precedence. validateSources test for both patterns + the no-year fallback.

3. **MAJOR — key-gated converters can throw and kill a seed run.**
   `footballDataOrgStandingsToMarkdown`/`ScorersToMarkdown` (and any similar
   spots in `apiFootballStandingsToMarkdown`) dereference nested fields
   (`row.team.name`, `s.player.name`) without optional chaining. Fix:
   (a) defensive `?.`/`??` throughout, skipping malformed rows with a warn;
   (b) enforce the module's "never throws" contract mechanically — wrap each
   exported `fetch*` function's convert step in try/catch → warn + return
   null; (c) `footballDataOrgStandingsToMarkdown` currently renders only the
   first TOTAL group — loop ALL standings groups (like the ESPN/API-Football
   converters do), emitting one `## <group>` section each.
   validateSources: add a malformed-fixture test per key-gated converter
   (null team, missing player) asserting no throw and either a row-skip or
   null return.

4. **MINOR — openfootball 404 window at season rollover.** After July 1 the
   new season's GitHub file may not exist yet → null → zero fixture content.
   Fix inside `fetchOpenfootball`: on a 404/null for `startYear`, retry
   `startYear - 1` once (log one line: falling back to previous season);
   the returned markdown must carry the PREVIOUS season's Season header (it
   describes that data). Test with fixtures (mock fetch not required — factor
   the fallback decision so it's testable, e.g. a pure helper choosing the
   candidate years).

5. **MINOR — `normalizeLeagueName` lacks "CAF Champions League".** Add the
   mapping (`"caf champions league"` → `"CAF Champions League"`) in
   promptGenerator.ts and a validateSources/validatePrompts assertion that
   the api-football CAF entry's leagueName maps.

6. **MINOR — API stats sources don't get stats chunk sizing.** Update
   `statsEvaluator.ts`'s `isStatsSite` to also match `site.api.espn.com`,
   `api.football-data.org`, `v3.football.api-sports.io` so their standings
   tables get STATS_CHUNK_SIZE like Understat does. Confirm from loadDb that
   `isStatsSite` receives the entries' url strings (it does — the display
   urls contain those hosts; verify and state it).

7. **MINOR — 40k truncation can cut mid-row.** In the Wikipedia converter,
   truncate at the last newline at or before MAX_WIKI_CHARS instead of a raw
   slice.

## Verification (run all; report outputs)
- `npx tsc --noEmit` → clean. `npx eslint scripts/` → 0 errors.
- `npx tsx scripts/validateSources.ts` → exit 0 (with the NEW tests shown).
- `npx tsx scripts/validateChunking.ts` and `validatePrompts.ts` → exit 0.
- Live re-verification of finding 1 on the real UEFA_Champions_League page —
  show the fixed table region (the qualifying-round access list) in the report.

## Report format (short)
DONE/BLOCKED · what changed per finding · fixed-table live snippet · gate outputs.
