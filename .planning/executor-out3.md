All 5 fixes are done, verified, and documented. Summary:

1. **Season boundary bug** — `getSeasonContext` now uses one shared boundary (Aug 8 kickoff) for both `latestSeason`/`nextSeason` and `inOffSeason`, so Aug 1–7 is consistent.
2. **Reranker vs DB-resume misclassification** — added `isRerankerError` guard so reranker failures fall back to vector search instead of surfacing a false "database waking up" error.
3. **Retry budget** — `withDbResumeRetry` defaults now `attempts=8`, `baseDelayMs=1500`, cap `8000`, giving ~38.5s of retry budget to span both cold-start stages.
4. **Untretried reads** — parent fetch now wrapped in `withDbResumeRetry`; diagnostic block wrapped in retry + its own swallowing `try/catch` so it never fails the request.
5. **Lint cleanup** — deleted the dead `getCurrentEuropeanSeason`, and removed both `any` casts by typing `hybridSearch`'s collection param as `Collection<SomeDoc>`.

`npx tsc --noEmit` and `npx eslint app/api/chat/route.ts` both pass clean. Only `app/api/chat/route.ts` and `.planning/executor-report.md` were touched; nothing committed.
