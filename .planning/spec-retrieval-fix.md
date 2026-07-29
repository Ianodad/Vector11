# SPEC — Vector11 retrieval + season fixes (no re-seed required)

You are editing ONE file: `/data/Documents/vector11/app/api/chat/route.ts`
Branch is already created and checked out: `fix/retrieval-season-hybrid`.
Do NOT touch any other file. Do NOT re-seed the database. Do NOT run `git commit`.

## Context (already verified — treat as fact, do not re-investigate)

- Astra collection `vector11gpt`: 10,209 docs (3,121 parent / 7,088 child), 1536-dim, `dot_product`.
- The collection **already has `lexical` and `rerank` enabled** (NVIDIA `llama-3.2-nv-rerankqa-1b-v2`).
- `$lexical` is **NOT populated** on existing docs, so BM25 contributes nothing today
  (`$bm25Rank: null`). Hybrid still works and the reranker still runs — that is the win.
- Verified working call shape (tested live, returns 8/12/20 hits in 0.8–4.3s, `parentId` survives projection):

```ts
await collection.findAndRerank(
  { type: "child" },
  {
    sort: { $hybrid: { $vector: vec, $lexical: queryText } },
    limit: 12,
    hybridLimits: 80,
    rerankOn: "content",
    rerankQuery: <the user's original question>,
    includeScores: true,
    projection: { parentId: 1, content: 1, source: 1, url: 1, category: 1, scrapedAt: 1 },
  },
).toArray();
// each row: { document: {...}, scores: { $rerank, $vector, $vectorRank, $bm25Rank, $rrf } }
```

- Measured discrimination on "Premier League 2025/26 league table standings":
  correct 2025/26 table → `$rerank = +20.48`; wrong 2024/25 table → `$rerank = -0.78`.
  (Cosine gave 0.899 vs 0.884 — indistinguishable. This is why we switch.)
- Actual `category` values present in the DB:
  `reference`(1567), `fixtures`(1719), `stats`(1990), `teams`(4539), `news`(64),
  `soccerwayForm`(214), `analysis`(28), `rss`(88).
  **`playerPerformance` has ZERO documents** — the current code filters on it constantly.
- Cold start is TWO stages: (1) ~19s of HTTP 400 `"resuming from hibernation"`,
  (2) then reads fail with `UNAVAILABLE_DATABASE` / `"not enough replicas ... LOCAL_QUORUM"`.
  Current `isDbResumingError` matches stage 1 only and the total retry budget is 9s.

---

## TASK 1 — Season handling

**1a.** Change `getCurrentEuropeanSeason` so the season flips in **August, not July**:
replace `month >= 7` with `month >= 8`.

**1b.** Add a helper next to it:

```ts
const getSeasonContext = (date: Date = new Date()) => {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const currentSeason = getCurrentEuropeanSeason(date);
  const [startYearStr] = currentSeason.split("-");
  const startYear = Number(startYearStr);
  const previousSeason = `${startYear - 1}-${String(startYear % 100).padStart(2, "0")}`;
  // Top-5 European leagues kick off in the first half of August.
  const seasonLikelyStarted = month > 8 || (month === 8 && day >= 8);
  return { currentSeason, previousSeason, seasonLikelyStarted };
};
```

**1c.** In `POST`, replace the `currentEuropeanSeason` local with
`const season = getSeasonContext();` and use `season.currentSeason` everywhere the old
variable was used (the planner prompt and `buildRetrievalHints`).

**1d.** In the system prompt `template`, REPLACE this block:

```
Date context:
- Today (UTC): ${todayIso}
- Current European season baseline: ${currentEuropeanSeason}
```
...and the two rules `- Default to CURRENT season...` and
`- When current-season data is unavailable, say it is unavailable instead of guessing.`

WITH:

```
Date context:
- Today (UTC): ${todayIso}
- Season baseline: ${season.currentSeason}
- Most recent prior season: ${season.previousSeason}
- Has the ${season.currentSeason} season started yet? ${season.seasonLikelyStarted ? "Yes" : "No — it has not kicked off yet."}

Season rules (IMPORTANT):
- If the ${season.currentSeason} season has NOT started, treat ${season.previousSeason} as the latest real data.
- When the user says "current", "latest", "now", or "this season", answer using the most recent season
  that actually appears in the retrieved context.
- ALWAYS label which season you are reporting (e.g. "2025-26 final table").
- NEVER refuse to answer solely because the newest season has no data yet. Give the most recent
  season you have, clearly labelled, and add one short line noting the newer season has not started.
- Only say data is unavailable if the retrieved context contains NOTHING relevant to the question.
```

Keep the existing `- If user provides a historical table...` rule as-is.

---

## TASK 2 — Category alignment

**2a.** Replace `VALID_CATEGORIES` with the categories that actually exist:

```ts
const VALID_CATEGORIES = new Set([
  "news", "stats", "fixtures", "analysis", "teams", "reference", "soccerwayForm", "rss",
]);
```

**2b.** Replace `CATEGORY_FALLBACKS` with:

```ts
const CATEGORY_FALLBACKS: Record<string, string[]> = {
  analysis: ["stats", "reference"],
  teams: ["stats", "analysis"],
  fixtures: ["stats", "soccerwayForm"],
  news: ["rss", "analysis"],
  stats: ["reference", "analysis"],
  reference: ["stats"],
  soccerwayForm: ["fixtures", "stats"],
  rss: ["news"],
};
```

**2c.** In `inferRetrievalCategories`, the player-stats branch currently pushes
`"playerPerformance"` (zero docs). Change that line to push `"stats"` instead
(Understat player tables are stored under `category: "stats"`).

**2d.** Map any legacy `playerPerformance` coming from a precomputed plan or the LLM planner
to `"stats"`. Add this normaliser and apply it to `plan.category` right after the plan is
resolved (both the precomputed branch and the LLM branch):

```ts
const normalizeCategory = (c: string | null): string | null =>
  c === "playerPerformance" ? "stats" : c;
```

**2e.** In the LLM planner system prompt, change the category enum line from
`"news"|"stats"|"playerPerformance"|"fixtures"|"analysis"|"teams"` to
`"news"|"stats"|"fixtures"|"analysis"|"teams"|"reference"` and change the
`Use "playerPerformance" for individual player stats, top scorers, assists.` line to
`Use "stats" for individual player stats, top scorers, assists, xG (player tables live under "stats").`

---

## TASK 3 — Hybrid retrieval with native reranking

Replace the current retrieval (the `searchFilters` fan-out + `rerankEvidenceWithLLM`) with
Astra hybrid search. **Keep the old pure-vector path as a fallback.**

**3a.** Add `export const maxDuration = 60;` at the top of the file (after the imports).
The cold-start retry in Task 4 needs headroom; the Vercel default (10–15s) is too short.

**3b.** Write a new function that runs hybrid search for one query:

```ts
interface HybridHit {
  parentId: string;
  doc: Record<string, unknown>;
  rerank: number;
  similarity: number;
}

const hybridSearch = async (
  collection: ReturnType<typeof db.collection>,
  filter: Record<string, unknown>,
  vec: number[],
  lexicalQuery: string,
  rerankQuery: string,
): Promise<HybridHit[]> => {
  const rows = await (collection as any)
    .findAndRerank(filter, {
      sort: { $hybrid: { $vector: vec, $lexical: lexicalQuery } },
      limit: 12,
      hybridLimits: 80,
      rerankOn: "content",
      rerankQuery,
      includeScores: true,
      projection: {
        parentId: 1, content: 1, source: 1, url: 1, category: 1, scrapedAt: 1,
      },
    })
    .toArray();

  return rows
    .map((r: any) => ({
      parentId: String(r.document?.parentId ?? ""),
      doc: r.document ?? {},
      rerank: Number(r.scores?.$rerank ?? 0),
      similarity: Number(r.scores?.$vector ?? 0),
    }))
    .filter((h: HybridHit) => h.parentId);
};
```

**3c.** In `POST`, inside the existing vector-search `try` block, replace the
`searchFilters` construction + `withDbResumeRetry(Promise.all(...))` + merge loop with:

- Build filters: one `{ type: "child", category }` per entry in `retrievalCategories`
  (cap at 2), plus one unfiltered `{ type: "child" }`. Same idea as before, fewer rounds.
- Run `hybridSearch` for **every (filter × embedding) pair**, wrapped in ONE
  `withDbResumeRetry(() => Promise.all([...]))`.
  - `lexicalQuery` = the plan query string that produced that embedding.
  - `rerankQuery` = `lastMessage` (the user's actual question) for ALL calls.
- Merge into `bestByParent`, keeping the **highest `rerank`** per `parentId`.
- Apply the existing `fixtureLikeRequest && isLikelyTickerNoise(content)` skip.
- Rank purely by `rerank` descending. **Do NOT apply the old
  `lexical/leagueBoost/teamBoost/seasonBoost/statsBoost` additive scoring in this path** —
  those constants are calibrated for 0–1 cosine and would be noise against rerank scores
  that span roughly −10 to +25. The reranker already handles this.
- Take the top 12 parentIds.
- **Delete the `rerankEvidenceWithLLM` call and the whole `rerankEvidenceWithLLM` function**
  (the native reranker replaces it). Also delete the now-unused `RerankCandidate` interface.
  Leave `precomputed.skipRerank` in the type but stop reading it.

**3d.** Fallback. Wrap the hybrid block in its own `try/catch`. If hybrid throws for any
reason **other than a DB-resuming error**, log
`console.log("[chat] hybrid search failed, falling back to vector search", err)` and run the
ORIGINAL pure-vector path (the existing `collection.find({...}, { sort: { $vector }, ... })`
fan-out **with** the original additive boost scoring, which you should keep intact for this
path). A DB-resuming error must propagate so Task 4 handles it.

**3e.** Keep Steps 2 and 3 (parent fetch + `docContent` assembly) working. The
`rankByParentId` map now carries `{ rerank, similarity }` — update the emitted JSON to use
`rerank` in place of the old `rank`/`lexical` fields, and keep `similarity`.

**3f.** Keep the existing "fallback: using child content" branch and the `bestByParent.size === 0`
collection-check logging.

---

## TASK 4 — Cold start: retry longer, match both stages, stop failing silently

**4a.** Widen `isDbResumingError` to catch BOTH stages:

```ts
const isDbResumingError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /resum|hibernat|503|not (yet )?ready|starting|initializ|unavailable_database|not enough (nodes|replicas)|refused to start processing|quorum|safe to retry/i
    .test(msg);
};
```

**4b.** Change `withDbResumeRetry` defaults to `attempts = 6, baseDelayMs = 1000` and make the
delay `baseDelayMs * i` capped at 6000 (so sleeps are 1s+2s+3s+4s+5s ≈ 15s, plus request time —
comfortably inside `maxDuration = 60`).

**4c.** **Stop answering with empty context on retrieval failure.** This is the important part.
In the `catch` around the vector search, distinguish the two cases:

```ts
} catch (error) {
  console.log("Error querying vector search:", error);
  if (isDbResumingError(error)) {
    return Response.json(
      {
        error:
          "The stats database is waking up from sleep. Give it about 30 seconds and ask again.",
      },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
  docContent = "";
}
```

So a cold DB now returns an honest 503 instead of a confident answer built on nothing.

**4d.** In the outer `catch` at the bottom of `POST`, keep returning 500 but log the error:
change `} catch {` to `} catch (error) {` and add
`console.log("[chat] request failed:", error);` before the response.

---

## Constraints

- TypeScript must compile. Run `npx tsc --noEmit` and fix any errors you introduce.
- Do not add dependencies.
- Do not change `app/lib/retrievalPlans.ts`, the scrapers, or the seed scripts.
- Do not reformat untouched code.
- Preserve all existing `console.log("[chat] ...")` telemetry, and add
  `console.log("[chat] hybrid results", { uniqueParents, topRerank })` after the merge.

## Definition of done

1. `npx tsc --noEmit` passes.
2. `rerankEvidenceWithLLM` is gone; `findAndRerank` is used on the primary path.
3. `playerPerformance` no longer appears in any filter sent to Astra.
4. A cold DB produces a 503 "waking up" response, never a context-free answer.
5. Write a short report to `/data/Documents/vector11/.planning/executor-report.md`:
   what you changed, anything you deviated on, and anything you could not do.
