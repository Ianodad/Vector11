Done. Summary:

- Replaced `getSeasonContext` in `app/api/chat/route.ts` with the corrected version (`latestSeason`/`nextSeason`/`inOffSeason`), fixing the bug where the just-finished 2025-26 season was being mislabeled as "not started" and the model was pointed at stale 2024-25 data instead.
- Updated both consumers (LLM planner prompt, `buildRetrievalHints`) to use `season.latestSeason`; also renamed a same-named local parameter so no trace of `currentSeason`/`previousSeason`/`seasonLikelyStarted` remains.
- Replaced the `Date context:`/`Season rules:` blocks in the system prompt exactly per spec.
- `npx tsc --noEmit` passes; grep confirms the forbidden strings are gone. Appended a "Season fix" section to `.planning/executor-report.md`. No commit made, no other files touched.
