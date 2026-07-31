# Task: Fix the three source gaps found in the first live API seed (run 30625125601)

Repo: /data/Documents/vector11, branch: create work directly on `main`'s
checkout? NO — the orchestrator has checked out branch `fix/source-gaps` for
you (verify with `git status`; do not run any other git command).

## Hard rules
- No git commands (except read-only `git status` once).
- Files: `scripts/lib/scrapers/apiFetchers.ts`, `scripts/validateSources.ts` ONLY.
- Live fetches allowed (zero-key + the .env football-data key) for verification.
- No new deps. Match style.

## Gap 1 — Wikipedia: all 18 entries "empty/short" on GitHub Actions
Local fetches work; the runner's datacenter IP + missing User-Agent is the
known Wikimedia failure mode (their robot policy REQUIRES a descriptive UA;
default/undefined UA from cloud IPs gets errors/empty).
Fix: `fetchJson` gains an optional headers param already? It has `headers?` —
ensure EVERY call from `fetchWikipediaArticle` (and ideally all fetchers)
sends `User-Agent: vector11-rag-seed/1.0 (https://github.com/Ianodad/Vector11; contact ianodad@gmail.com)`
plus `Api-User-Agent` with the same value for Wikimedia specifically.
Centralize: a DEFAULT_HEADERS constant merged into every fetchJson call.
Verification: live-fetch one article and confirm content; you cannot
reproduce the runner's IP reputation locally — state that explicitly; the
UA policy fix is the documented remedy.

## Gap 2 — football-data.org free tier: 10 requests/min, FL1+CL rate-limited
Six competitions ran back-to-back (~3 API calls each within seconds) —
requests 11+ returned 429/empty → FL1 and CL skipped.
Fix in `fetchFootballDataOrg`:
- Add a module-level pacing gate: a minimum interval of ~6500ms between
  consecutive football-data.org requests (async mutex/last-call timestamp —
  simple `await` on a shared promise chain is fine).
- On a 429 response (fetchJson must expose status or detect the 429 body),
  wait 65s and retry ONCE, then give up (null).
- validateSources: unit-test the pacing helper (e.g. exported
  `paceFootballData()` returning elapsed >= interval on consecutive calls —
  keep the test fast by making the interval injectable; do NOT slow the
  suite by 6.5s per call).

## Gap 3 — openfootball en.1 (EPL) produced content but zero chunks survived
Its 4 sibling leagues inserted fine. Reproduce locally:
`fetchOpenfootball("en.1","Premier League",2026)` (falls back to 2025) →
run the result through `createParentChildChunks` with the same params
loadDb uses for API stats sources (see loadDb.ts chunk-size selection; the
isLowValueContent predicate comes from loadDb — read how it's constructed)
and find WHY every chunk is filtered. Fix at the appropriate level:
- If `isLowValueContent` false-positives on the EPL fixture list (e.g. the
  ticker-noise heuristic), adjust the MARKDOWN the converter emits (e.g.
  richer table headers/section text) rather than touching loadDb's predicate
  (loadDb is out of scope this round). The other four leagues' output is the
  reference — diff en.1's markdown against es.1's to find the discriminating
  feature.
- Add a validateSources fixture capturing the failing shape, asserting the
  converter output passes whatever structural property fixed it.
Report the root cause explicitly.

## Verification
- tsc clean; eslint 0 errors; validateSources/validateChunking/validatePrompts exit 0.
- Live: (a) Wikipedia article fetch with new UA — show 5 lines; (b)
  football-data.org: fetch ALL SIX competitions sequentially with pacing —
  expect 6/6 non-null (show one line each: code + season + rows count);
  (c) openfootball en.1 → chunks survive (show parent/child counts).

## Report: DONE/BLOCKED · root cause per gap · live outputs · gates.
