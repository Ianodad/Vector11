# SPEC — Fix 5 issues found in code review

Edit ONE file: `/data/Documents/vector11/app/api/chat/route.ts`. Nothing else. Do not commit.

An independent reviewer found 5 real bugs in the current uncommitted changes. All 5 were
verified. Fix them all.

---

## FIX 1 (High) — August 1–7 selects the wrong season

`getSeasonContext` flips `startYear` on **August 1**, but treats **August 1–7** as off-season.
Those two boundaries disagree.

Failure: on `2026-08-01` it yields `latestSeason = 2026-27`, `inOffSeason = true`,
`nextSeason = 2027-28` — so the prompt announces that 2026-27 is *complete* (it hasn't even
started) and never mentions 2025-26, the actual latest season with data.

The season boundary must be **one** value used by both. Replace the body of `getSeasonContext`:

```ts
const getSeasonContext = (date: Date = new Date()) => {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  // Europe's top leagues kick off in the first half of August and finish in May.
  // A new season only becomes "the latest season" once it has actually kicked off.
  const newSeasonHasKickedOff = month > 8 || (month === 8 && day >= 8);
  const startYear = newSeasonHasKickedOff ? year : year - 1;
  const fmt = (start: number) =>
    `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  const latestSeason = fmt(startYear);
  const nextSeason = fmt(startYear + 1);
  // June, July and the first week of August sit between two seasons.
  const inOffSeason = month === 6 || month === 7 || (month === 8 && day < 8);
  return { latestSeason, nextSeason, inOffSeason };
};
```

Required behaviour (add no tests, just make these true):

| Date       | latestSeason | nextSeason | inOffSeason |
|------------|--------------|------------|-------------|
| 2026-05-01 | 2025-26      | 2026-27    | false       |
| 2026-07-29 | 2025-26      | 2026-27    | true        |
| 2026-08-01 | 2025-26      | 2026-27    | true        |
| 2026-08-10 | 2026-27      | 2027-28    | false       |
| 2027-01-15 | 2026-27      | 2027-28    | false       |

---

## FIX 2 (High) — Reranker/service errors must NOT be treated as "database waking up"

`isDbResumingError` matches any message containing `503`, `starting`, or `initializ`. The
NVIDIA reranker is a *separate service*; when it fails the message looks like:

```
Reranking provider server error: Provider: nvidia; HTTP Status: 503; Error Message: null.
```

(A real `HTTP Status: 500` from this provider was already observed in local testing.)

Failure: a reranker 503 is classified as a DB resume, so it is rethrown past the vector
fallback and the user gets "the stats database is waking up" — when the database is fine and
plain vector search would have answered.

Add a guard **above** `isDbResumingError` and use it:

```ts
// The NVIDIA reranker is a separate service from the database. Its failures must fall back
// to plain vector search, not be reported to the user as a hibernating database.
const isRerankerError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /rerank/i.test(msg);
};

const isDbResumingError = (err: unknown): boolean => {
  if (isRerankerError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /resum|hibernat|503|not (yet )?ready|starting|initializ|unavailable_database|not enough (nodes|replicas)|refused to start processing|quorum|safe to retry/i
    .test(msg);
};
```

Because the hybrid `catch` rethrows only when `isDbResumingError(err)` is true, a reranker
failure now correctly falls through to the pure-vector fallback. Verify that is what the
code does; if the hybrid catch tests anything else, change it to test `isDbResumingError`.

---

## FIX 3 (High) — Retry budget is too short to span both cold-start stages

Current: `attempts = 6`, delay `min(1000 * i, 6000)` → sleeps of 1+2+3+4+5 = 15s. Stage one
alone was measured at **18.7s**, so every attempt can be consumed before stage two even begins.

Change the defaults of `withDbResumeRetry` to `attempts = 8` and `baseDelayMs = 1500`, and cap
the delay at `8000`:

```ts
const withDbResumeRetry = async <T>(
  op: () => Promise<T>,
  attempts = 8,
  baseDelayMs = 1500,
): Promise<T> => {
```
and inside, `const delayMs = Math.min(baseDelayMs * i, 8000);`

That gives sleeps of 1.5+3+4.5+6+7.5+8+8 = 38.5s, which spans both stages and still fits
inside `maxDuration = 60`.

---

## FIX 4 (High) — Parent fetch and diagnostic reads are not retried

`withDbResumeRetry` wraps only the search. The parent fetch (`collection.find({ _id: { $in: parentIds } })`)
and the `bestByParent.size === 0` diagnostic block (`countDocuments` + sample `find`) run bare.

Failure: the search succeeds while Astra is mid-transition, then the parent fetch hits
`UNAVAILABLE_DATABASE` / `LOCAL_QUORUM` and the user gets a 503 even though one retry would
have worked.

Wrap **both** in `withDbResumeRetry(() => ...)`:
- the parent fetch, and
- the diagnostic `countDocuments` / sample `find` calls.

For the diagnostic block only, if it still fails, swallow the error (it is logging only —
it must never be the reason a request fails). Wrap that one in its own `try/catch` that logs
and continues.

---

## FIX 5 (Medium) — File fails ESLint

`npx eslint app/api/chat/route.ts` currently reports 2 errors + 1 warning:

- `44:7  warning  'getCurrentEuropeanSeason' is assigned a value but never used`
- `323:37 error  Unexpected any`
- `338:14 error  Unexpected any`

**5a.** Delete the now-unused `getCurrentEuropeanSeason` function entirely. `getSeasonContext`
is self-contained and no longer calls it.

**5b.** Remove both `any` casts. `findAndRerank` **is** properly typed on `Collection` — the
casts are unnecessary. The real signatures are:

```ts
findAndRerank<T extends SomeDoc = RSchema, TRaw extends T = T>(
  filter: CollectionFilter<WSchema>,
  options?: CollectionFindAndRerankOptions,
): CollectionFindAndRerankCursor<RerankedResult<T>, TRaw>;

class RerankedResult<TRaw> {
  readonly document: TRaw;
  readonly scores: Record<string, number>;
}
```

So type `hybridSearch`'s `collection` parameter as `Collection<SomeDoc>` (import `Collection`
and `SomeDoc` from `@datastax/astra-db-ts`) and let the `.map()` callback infer, reading
`r.document` and `r.scores.$rerank` / `r.scores.$vector` without casts. Keep the runtime
behaviour identical — `$rerank` remains the score key used for ranking.

If a cast is genuinely unavoidable somewhere, use a narrow named type or `unknown` +
validation, never `any`.

---

## Constraints
- `npx tsc --noEmit` must pass.
- `npx eslint app/api/chat/route.ts` must exit clean: **0 errors, 0 warnings**.
- Do not change retrieval behaviour beyond what is written above. The hybrid path still ranks
  purely by `$rerank`; the fallback path keeps its original additive cosine boosts.
- Do not touch any other file.

## Definition of done
1. `npx tsc --noEmit` passes.
2. `npx eslint app/api/chat/route.ts` reports zero problems.
3. All five fixes are present.
4. Append a "Review fixes" section to `/data/Documents/vector11/.planning/executor-report.md`
   stating what you changed for each of the 5, and flag anything you disagreed with.
