// Retrieval eval: runs the REAL production pipeline (app/lib/retrieval.ts) against the live
// collection and checks that known facts reach the model's context. READ-ONLY.
//
// Ground truth = the DB's own Understat snapshot (newest scrape of each league's
// current-season page), so the eval measures retrieval, not data freshness.
//
//   ./node_modules/.bin/tsx scripts/evalRetrieval.ts [--set precomputed|planner|all]
//        [--runs N] [--min R] [--compare <eval-json-file>]
//
// Exit codes: 0 ok | 1 recall below --min, no facts parsed at all, or fatal error.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { DataAPIClient } from "@datastax/astra-db-ts";
import { retrieveContext, DbResumingError } from "../app/lib/retrieval";
import { RETRIEVAL_PLANS } from "../app/lib/retrievalPlans";
import { getSeasonContext } from "../app/lib/season";
import { withDbResumeRetry } from "../app/lib/astraResume";

type Bucket = "PASS" | "WRONG_SEASON" | "MISS" | "ERROR";
type SetName = "precomputed" | "planner";

interface Fact {
  league: string;
  slug: string;
  kind: "leader" | "scorer";
  entity: string;
  value: string;
  label: string;
}
interface RunResult {
  bucket: Bucket;
  ms: number;
  searchCalls: number;
  plannerMs?: number;
  embedMs?: number;
  searchMs?: number;
  parentMs?: number;
  precomputed: boolean;
  line?: string;
  matchedUrl?: string;
  error?: string;
}
interface Row {
  set: SetName;
  league: string;
  kind: string;
  question: string;
  expected: string;
  runs: RunResult[];
}

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SET = (arg("--set") ?? "all") as "precomputed" | "planner" | "all";
if (!["precomputed", "planner", "all"].includes(SET)) {
  console.error(`--set must be precomputed|planner|all (got "${SET}")`);
  process.exit(2);
}
const numArg = (name: string, fallback: number, ok: (n: number) => boolean, hint: string): number => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || !ok(n)) {
    console.error(`${name} must be ${hint} (got "${raw}")`);
    process.exit(2);
  }
  return n;
};
const RUNS = numArg("--runs", 1, (n) => Number.isInteger(n) && n >= 1, "an integer >= 1");
const MIN = numArg("--min", 0, (n) => n >= 0 && n <= 1, "a number between 0 and 1");
const COMPARE = arg("--compare");

// ---------- config ----------
const LEAGUES = [
  { name: "Premier League", slug: "EPL" },
  { name: "La Liga", slug: "La_liga" },
  { name: "Serie A", slug: "Serie_A" },
  { name: "Bundesliga", slug: "Bundesliga" },
];

// Exact RETRIEVAL_PLANS keys per league/fact. A missing key means that row is skipped (and reported).
const PRECOMPUTED_KEYS: Record<string, { leader?: string; scorer?: string }> = {
  "Premier League": {
    leader: "What are the current EPL standings with points and goal difference?",
    scorer: "Who are the top scorers in the EPL this season?",
  },
  "La Liga": { leader: "What are the current La Liga standings this season?" },
  "Serie A": { leader: "What are the current Serie A standings this season?" },
  Bundesliga: { leader: "What are the current Bundesliga standings this season?" },
};

const plannerQuestion = (league: string, kind: "leader" | "scorer") =>
  kind === "leader"
    ? `What is the current ${league} table?`
    : `Who is the top scorer in ${league} this season?`;

// ---------- env / db (read-only) ----------
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
};
const client = new DataAPIClient(need("ASTRA_DB_APPLICATION_TOKEN"), {
  timeoutDefaults: { requestTimeoutMs: 20000, generalMethodTimeoutMs: 60000 },
});
const db = client.db(need("ASTRA_DB_API_ENDPOINT"), { keyspace: need("ASTRA_DB_NAMESPACE") });
const collection = db.collection(need("ASTRA_DB_COLLECTION"));

// ---------- ground truth ----------
interface GtParent { id: string; content: string; scrapedAt: string }

// The current-season page accumulates one set of parents PER re-seed (content-hash _ids), so old
// scrapes (even last season's final table) sit next to the newest. Always use the newest scrape
// that actually contains the fact.
const newestMatch = (parents: GtParent[], re: RegExp): { parent: GtParent; m: RegExpMatchArray } | null => {
  let best: { parent: GtParent; m: RegExpMatchArray } | null = null;
  for (const parent of parents) {
    const m = parent.content.match(re);
    if (m && (!best || parent.scrapedAt > best.parent.scrapedAt)) best = { parent, m };
  }
  return best;
};

const loadGroundTruth = async () => {
  const facts: Fact[] = [];
  const missing: string[] = [];
  const usedIds = new Set<string>();
  let maxScrapedAt = "";
  for (const lg of LEAGUES) {
    const url = `https://understat.com/league/${lg.slug}`;
    const rows = await withDbResumeRetry(() =>
      collection
        .find({ type: "parent", url }, { projection: { content: 1, scrapedAt: 1 } })
        .toArray(),
    );
    const parents: GtParent[] = rows.map((r) => ({
      id: String(r._id),
      content: String(r.content ?? ""),
      scrapedAt: r.scrapedAt instanceof Date ? r.scrapedAt.toISOString() : String(r.scrapedAt ?? ""),
    }));
    const found: Fact[] = [];
    const leader = newestMatch(parents, /-\s*\*\*Leader:\*\*\s*(.+?)\s+—\s+(\d+)\s*pts/);
    if (leader) {
      found.push({
        league: lg.name, slug: lg.slug, kind: "leader", entity: leader.m[1].trim(), value: leader.m[2],
        label: `${leader.m[1].trim()} = ${leader.m[2]} pts`,
      });
      usedIds.add(leader.parent.id);
      if (leader.parent.scrapedAt > maxScrapedAt) maxScrapedAt = leader.parent.scrapedAt;
    }
    const scorer = newestMatch(parents, /\*\*Top scorers:\*\*\s*([^(|]+)\(([^,]+),\s*(\d+)G\)/);
    if (scorer) {
      found.push({
        league: lg.name, slug: lg.slug, kind: "scorer", entity: scorer.m[1].trim(), value: scorer.m[3],
        label: `${scorer.m[1].trim()} = ${scorer.m[3]}G`,
      });
      usedIds.add(scorer.parent.id);
      if (scorer.parent.scrapedAt > maxScrapedAt) maxScrapedAt = scorer.parent.scrapedAt;
    }
    if (found.length === 0) missing.push(lg.name);
    facts.push(...found);
  }
  return { facts, missing, parentIds: [...usedIds].sort(), maxScrapedAt };
};

// ---------- scoring ----------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UNDERSTAT = /^https?:\/\/understat\.com\//i;
const stripSlash = (u: string) => u.replace(/\/+$/, "").toLowerCase();

// A probe passes only if ONE LINE contains BOTH the entity and its exact whole number
// ("27" must not match "27.71"). Lines from Understat /<year> pages are a different season.
const classify = (
  parents: Array<{ url: string; content: string }>,
  entity: string,
  value: string,
  slug: string,
): { bucket: Bucket; line?: string; matchedUrl?: string } => {
  const valRe = new RegExp(`(?<![\\d.])${esc(value)}(?![\\d.])`);
  let wrongSeason = false;
  for (const p of parents) {
    const url = stripSlash(String(p.url ?? ""));
    const current = `https://understat.com/league/${slug}`.toLowerCase();
    const yearPage = url.startsWith(current + "/") && /^\d{4}$/.test(url.slice(current.length + 1));
    const eligible = !UNDERSTAT.test(url) || url === current;
    // Other leagues' Understat pages (any year) never count.
    if (!eligible && !yearPage) continue;
    for (const line of String(p.content ?? "").split("\n")) {
      if (!line.includes(entity)) continue;
      if (valRe.test(line)) {
        if (eligible) return { bucket: "PASS", line: line.trim().slice(0, 140), matchedUrl: p.url };
        wrongSeason = true;
      } else if (yearPage && /\d/.test(line)) {
        wrongSeason = true;
      }
    }
  }
  return { bucket: wrongSeason ? "WRONG_SEASON" : "MISS" };
};

// ---------- running ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runOnce = async (question: string, fact: Fact): Promise<RunResult> => {
  const season = getSeasonContext();
  const origLog = console.log;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log = () => {}; // retrieval logs are noisy; the report is the output
    const t0 = Date.now();
    try {
      const r = await retrieveContext({
        chatMessages: [{ role: "user", content: question }],
        lastMessage: question,
        season,
      });
      console.log = origLog;
      const c = classify(r.parents, fact.entity, fact.value, fact.slug);
      return {
        ...c,
        ms: r.stats.ms,
        searchCalls: r.stats.searchCalls,
        plannerMs: r.stats.plannerMs,
        embedMs: r.stats.embedMs,
        searchMs: r.stats.searchMs,
        parentMs: r.stats.parentMs,
        precomputed: r.plan.precomputed,
      };
    } catch (e) {
      console.log = origLog;
      if (e instanceof DbResumingError && attempt < 3) {
        console.log("  (database waking, retrying in 30s)");
        await sleep(30000);
        continue;
      }
      return {
        bucket: "ERROR", ms: Date.now() - t0, searchCalls: 0, precomputed: false,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      };
    }
  }
  return { bucket: "ERROR", ms: 0, searchCalls: 0, precomputed: false, error: "unreachable" };
};

// ---------- reporting ----------
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p95 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const rowResult = (row: Row): string => {
  const n = row.runs.length;
  if (n === 1) return row.runs[0].bucket;
  const counts = new Map<Bucket, number>();
  for (const r of row.runs) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);
  const pass = counts.get("PASS") ?? 0;
  const others = [...counts.entries()].filter(([b]) => b !== "PASS").map(([b, c]) => `${b}:${c}`);
  return `PASS ${pass}/${n}${others.length ? ` (${others.join(" ")})` : ""}`;
};
const setStats = (rows: Row[]) => {
  const runs = rows.flatMap((r) => r.runs);
  const pass = runs.filter((r) => r.bucket === "PASS").length;
  return {
    rows: rows.length,
    runs: runs.length,
    pass,
    recall: runs.length ? pass / runs.length : 0,
    avgMs: avg(runs.map((r) => r.ms)),
    p95Ms: p95(runs.map((r) => r.ms)),
    avgSearchCalls: avg(runs.map((r) => r.searchCalls)),
    avgPlannerMs: avg(runs.map((r) => r.plannerMs ?? 0)),
    avgEmbedMs: avg(runs.map((r) => r.embedMs ?? 0)),
    avgSearchMs: avg(runs.map((r) => r.searchMs ?? 0)),
    avgParentMs: avg(runs.map((r) => r.parentMs ?? 0)),
    plannerUsed: runs.filter((r) => !r.precomputed && r.bucket !== "ERROR").length,
    precomputedUsed: runs.filter((r) => r.precomputed).length,
  };
};

const main = async () => {
  console.log(`Retrieval eval  set=${SET}  runs(planner)=${RUNS}  min=${MIN}\n`);

  const gt = await loadGroundTruth();
  const docCount = await withDbResumeRetry(() => collection.estimatedDocumentCount());

  console.log("GROUND TRUTH (newest Understat scrape stored in the DB)");
  for (const f of gt.facts) console.log(`  ${pad(f.league, 15)} ${pad(f.kind, 7)} ${f.label}`);
  for (const m of gt.missing) console.log(`  ${pad(m, 15)} MISSING FROM DB (no leader/scorer parsed)`);
  console.log(`  freshness: newest ground-truth scrape ${gt.maxScrapedAt || "n/a"} | collection ~${docCount} docs\n`);

  if (gt.facts.length === 0) {
    console.error("FATAL: 0 ground-truth facts parsed from the DB. Eval cannot run (Understat format changed or collection empty).");
    process.exit(1);
  }

  const rows: Row[] = [];
  const skipped: string[] = [];

  if (SET !== "planner") {
    for (const f of gt.facts) {
      const key = PRECOMPUTED_KEYS[f.league]?.[f.kind];
      if (!key || !RETRIEVAL_PLANS.has(key)) {
        skipped.push(`precomputed ${f.league} ${f.kind}: no RETRIEVAL_PLANS key`);
        continue;
      }
      rows.push({
        set: "precomputed", league: f.league, kind: f.kind, question: key, expected: f.label,
        runs: [await runOnce(key, f)],
      });
      console.log(`  precomputed  ${pad(f.league, 15)} ${pad(f.kind, 7)} ${rowResult(rows[rows.length - 1])}`);
    }
  }
  if (SET !== "precomputed") {
    for (const f of gt.facts) {
      const q = plannerQuestion(f.league, f.kind);
      const runs: RunResult[] = [];
      for (let i = 0; i < RUNS; i++) runs.push(await runOnce(q, f));
      rows.push({ set: "planner", league: f.league, kind: f.kind, question: q, expected: f.label, runs });
      console.log(`  planner      ${pad(f.league, 15)} ${pad(f.kind, 7)} ${rowResult(rows[rows.length - 1])}`);
    }
  }

  // --- table ---
  console.log("\n" + "=".repeat(110));
  console.log(
    `${pad("SET", 12)}${pad("LEAGUE", 16)}${pad("FACT", 8)}${pad("EXPECTED", 30)}${pad("RESULT", 24)}${pad("AVG ms", 9)}CALLS`,
  );
  console.log("-".repeat(110));
  for (const r of rows) {
    console.log(
      `${pad(r.set, 12)}${pad(r.league, 16)}${pad(r.kind, 8)}${pad(r.expected, 30)}${pad(rowResult(r), 24)}${pad(String(Math.round(avg(r.runs.map((x) => x.ms)))), 9)}${avg(r.runs.map((x) => x.searchCalls)).toFixed(1)}`,
    );
    const err = r.runs.find((x) => x.error);
    if (err) console.log(`             ERROR: ${err.error}`);
  }
  console.log("=".repeat(110));
  for (const s of skipped) console.log(`SKIPPED: ${s}`);

  const summary: Record<string, ReturnType<typeof setStats>> = {};
  for (const name of ["precomputed", "planner"] as SetName[]) {
    const subset = rows.filter((r) => r.set === name);
    if (subset.length === 0) continue;
    summary[name] = setStats(subset);
    const s = summary[name];
    console.log(
      `${pad(name.toUpperCase(), 12)} recall ${s.pass}/${s.runs} = ${(s.recall * 100).toFixed(0)}%  | avg ${Math.round(s.avgMs)}ms p95 ${Math.round(s.p95Ms)}ms | avg searchCalls ${s.avgSearchCalls.toFixed(1)} | plan: ${s.precomputedUsed} precomputed / ${s.plannerUsed} planner`,
    );
    console.log(
      `${pad("", 12)} phases avg: planner ${Math.round(s.avgPlannerMs)}ms embed ${Math.round(s.avgEmbedMs)}ms search ${Math.round(s.avgSearchMs)}ms parent ${Math.round(s.avgParentMs)}ms`,
    );
  }
  summary.all = setStats(rows);
  console.log(
    `${pad("OVERALL", 12)} recall ${summary.all.pass}/${summary.all.runs} = ${(summary.all.recall * 100).toFixed(0)}%  | avg ${Math.round(summary.all.avgMs)}ms p95 ${Math.round(summary.all.p95Ms)}ms | avg searchCalls ${summary.all.avgSearchCalls.toFixed(1)}`,
  );

  // --- snapshot + JSON ---
  const snapshot = { docCount, groundTruthParentIds: gt.parentIds, maxScrapedAt: gt.maxScrapedAt };
  const out = {
    timestamp: new Date().toISOString(),
    args: { set: SET, runs: RUNS, min: MIN },
    snapshot,
    facts: gt.facts,
    missingLeagues: gt.missing,
    skipped,
    rows,
    summary,
  };
  const logsDir = path.join(__dirname, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, `eval-${out.timestamp.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);

  // --- compare ---
  if (COMPARE) {
    const prev = JSON.parse(fs.readFileSync(path.resolve(COMPARE), "utf8")) as typeof out;
    const sameSnapshot =
      prev.snapshot.docCount === snapshot.docCount &&
      prev.snapshot.maxScrapedAt === snapshot.maxScrapedAt &&
      JSON.stringify(prev.snapshot.groundTruthParentIds) === JSON.stringify(snapshot.groundTruthParentIds);
    console.log(`\nCOMPARE vs ${COMPARE} (${prev.timestamp})`);
    if (!sameSnapshot) {
      console.log("!".repeat(70));
      console.log("!! SNAPSHOT DIFFERS - deltas not comparable (DB content changed between runs)");
      console.log(`!!   docCount ${prev.snapshot.docCount} -> ${snapshot.docCount}; maxScrapedAt ${prev.snapshot.maxScrapedAt} -> ${snapshot.maxScrapedAt}`);
      console.log("!".repeat(70));
    }
    const fmt = (n: number, d = 0) => (n >= 0 ? "+" : "") + n.toFixed(d);
    for (const name of ["precomputed", "planner", "all"]) {
      const a = prev.summary[name];
      const b = summary[name];
      if (!a || !b) continue;
      console.log(
        `  ${pad(name, 12)} recall ${(a.recall * 100).toFixed(0)}% -> ${(b.recall * 100).toFixed(0)}% (${fmt((b.recall - a.recall) * 100)}pp) | avg ms ${Math.round(a.avgMs)} -> ${Math.round(b.avgMs)} (${fmt(b.avgMs - a.avgMs)}) | searchCalls ${a.avgSearchCalls.toFixed(1)} -> ${b.avgSearchCalls.toFixed(1)}`,
      );
    }
    const key = (r: Row) => `${r.set}|${r.league}|${r.kind}`;
    const prevRows = new Map(prev.rows.map((r) => [key(r), r]));
    let changed = 0;
    for (const r of rows) {
      const p = prevRows.get(key(r));
      if (!p) { console.log(`  NEW ${key(r)}: ${rowResult(r)}`); changed++; continue; }
      if (rowResult(p) !== rowResult(r)) {
        console.log(`  CHANGED ${key(r)}: ${rowResult(p)} -> ${rowResult(r)}`);
        changed++;
      }
    }
    if (changed === 0) console.log("  no per-row changes");
  }

  // --- gate ---
  if (summary.all.recall < MIN) {
    console.error(`\nFAIL: recall ${(summary.all.recall * 100).toFixed(0)}% < --min ${(MIN * 100).toFixed(0)}%`);
    process.exit(1);
  }
  process.exit(0);
};

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
