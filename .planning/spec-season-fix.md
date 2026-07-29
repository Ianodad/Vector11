# SPEC — Correct the season semantics (follow-up fix)

Edit ONE file: `/data/Documents/vector11/app/api/chat/route.ts`. Nothing else. Do not commit.

## What is wrong

The previous spec (which you implemented correctly) had a **logic error in the requirements**.
It conflated "the season that just finished" with "a season that has not started yet".

Today is **2026-07-29** (off-season). The true state of the world:

| Season  | Status                                             |
|---------|----------------------------------------------------|
| 2024-25 | Finished a year ago. Old.                          |
| 2025-26 | **COMPLETE — finished May 2026. This is the newest season with data.** |
| 2026-27 | Has NOT kicked off (starts ~mid-August 2026).      |

`getCurrentEuropeanSeason` with `month >= 8` returns `2025-26` — **that part is correct**,
it is the newest season that has data. The bug is everything built on top of it:

- `previousSeason` (`2024-25`) is being presented to the model as "the most recent prior season"
- `seasonLikelyStarted: false` is being applied to `2025-26`, so the prompt tells the model
  **"the 2025-26 season has not kicked off yet"** — which is false; it has finished.

Result: the model reports **2024-25** data when complete **2025-26** data exists in the DB.
Verified live: 4 of 6 test queries returned 2024-25 tables.

The database definitely contains complete 2025-26 data (all 20 teams at MP 38, match results
through 24 May 2026, and a `# Premier League · 2025/26 · League Table` chunk).

## TASK — Replace the season context

**1.** Replace the whole `getSeasonContext` helper with:

```ts
const getSeasonContext = (date: Date = new Date()) => {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  // The season that is either currently in progress or has most recently finished.
  const startYear = month >= 8 ? year : year - 1;
  const fmt = (start: number) =>
    `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  const latestSeason = fmt(startYear);
  const nextSeason = fmt(startYear + 1);
  // Europe's top leagues run August -> May. June, July and very early August are off-season.
  const inOffSeason = month === 6 || month === 7 || (month === 8 && day < 8);
  return { latestSeason, nextSeason, inOffSeason };
};
```

**2.** Update every consumer. `season.currentSeason` becomes `season.latestSeason`
(this applies to the LLM planner prompt and to `buildRetrievalHints` — both should
search against `latestSeason`, since that is the season the stored data actually covers).
`season.previousSeason` and `season.seasonLikelyStarted` no longer exist; remove all uses.

**3.** Replace the `Date context:` block and the `Season rules (IMPORTANT):` block in the
system prompt `template` with exactly this:

```ts
`Date context:
- Today (UTC): ${todayIso}
- Latest season with data: ${season.latestSeason}${season.inOffSeason ? " — this season is COMPLETE (it has finished)" : " — currently in progress"}${season.inOffSeason ? `\n- The ${season.nextSeason} season has NOT kicked off yet.` : ""}

Season rules (IMPORTANT):
- "current", "latest", "now" and "this season" all mean ${season.latestSeason}.
- Report ${season.latestSeason} figures and label them clearly (e.g. "${season.latestSeason} final table").${season.inOffSeason ? `
- ${season.latestSeason} is FINISHED, not upcoming. Never describe it as "not started" or "not yet kicked off".
- You have NO ${season.nextSeason} data. Mention ${season.nextSeason} only to note it has not begun, and only if it is relevant.` : ""}
- Prefer the newest season present in the retrieved context. Do not fall back to an older
  season when a newer one is available in the context.
- NEVER refuse to answer solely because an even newer season has no data yet.
- Only say data is unavailable if the retrieved context contains NOTHING relevant to the question.`
```

Keep the existing `- If user provides a historical table...` rule.

## Constraints
- `npx tsc --noEmit` must pass.
- Change nothing else — leave the hybrid retrieval, category, and cold-start work exactly as is.

## Definition of done
- The strings `previousSeason`, `seasonLikelyStarted` and `currentSeason` no longer appear.
- Append a short "Season fix" section to `/data/Documents/vector11/.planning/executor-report.md`.
