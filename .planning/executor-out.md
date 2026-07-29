All four tasks are implemented in `app/api/chat/route.ts`, `npx tsc --noEmit` passes, and no other files were touched or committed.

**Summary of what changed:**
1. **Season handling** — season flips in August now, plus a `getSeasonContext()` helper that tells the model whether the new season has actually started and what the last real season was, so it stops refusing to answer in the summer gap.
2. **Categories** — aligned to what's actually in the DB (dropped the zero-doc `playerPerformance`, added `reference`/`soccerwayForm`/`rss`), with a normalizer so any legacy `playerPerformance` value gets mapped to `stats`.
3. **Retrieval** — swapped the old cosine-similarity + additive-boost + LLM-rerank pipeline for Astra's native `findAndRerank` hybrid search, ranked purely by the reranker's score. The old pure-vector path is kept intact as a fallback if hybrid search errors for any non-cold-start reason.
4. **Cold start** — retry window widened to ~15s across 6 attempts, error detection now catches both cold-start failure stages, and a cold DB now returns an honest 503 instead of a confident answer built on empty context.

One deliberate deviation worth flagging: since the hybrid and fallback paths score documents differently (`rerank` vs. `rank`/`lexical`), I unified them under one `ScoredDoc` type with optional fields rather than duplicating the parent-fetch/JSON-assembly code — noted in the report at `.planning/executor-report.md` along with everything else.
