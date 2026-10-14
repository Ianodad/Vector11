// app/lib/season.ts
// Shared by the chat route (system prompt) and the retrieval module (planner prompt, hints).

export const getSeasonContext = (date: Date = new Date()) => {
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
