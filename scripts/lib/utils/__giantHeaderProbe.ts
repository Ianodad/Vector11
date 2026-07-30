// Standalone process-isolation probe for the giant-header table regression
// (Codex round-2 finding 3): the table path of splitMarkdownAware is
// CPU-synchronous, so an in-process Promise.race timeout can never actually
// interrupt a regressed infinite loop — it would just block the event loop
// forever and the timer would never fire. Running this file as its own
// subprocess (spawnSync with a real `timeout`, killed with SIGKILL) is the
// only way to make the "did it hang?" assertion enforceable.
//
// Deliberately minimal: build the same giant-header doc used by
// validateChunking.ts's giant-header-table test, run splitMarkdownAware, and
// print the resulting chunks as JSON to stdout. Exit 0 on success; any
// uncaught error naturally exits non-zero. No imports from validateChunking.ts
// (kept a tiny standalone sibling, per spec) — the doc-building logic here is
// intentionally duplicated from validateChunking.ts's buildGiantHeaderTableDoc.
import { splitMarkdownAware, MAX_CHUNK_BYTES, type Chunk } from "./markdownChunker.js";

const GIANT_HEADER_ROW_COUNT = 5;
const giantHeaderRowMarkers: string[] = Array.from(
  { length: GIANT_HEADER_ROW_COUNT },
  (_, i) => `ROW-${String(i + 1).padStart(3, "0")}`,
);

const buildGiantHeaderTableDoc = (): string => {
  const header = "| " + "H".repeat(7890) + " |"; // ~7,900 bytes — already over MAX_CHUNK_BYTES alone.
  const separator = "|---|";
  const glyphCycle = ["·", "−", "😀"];
  const rows = giantHeaderRowMarkers.map((tag: string) => {
    let filler = "";
    let gi = 0;
    while (filler.length < 3000) {
      filler += glyphCycle[gi % glyphCycle.length];
      gi += 1;
    }
    return `| ${tag} ${filler} |`;
  });
  return [header, separator, ...rows].join("\n");
};

const main = async () => {
  const input = buildGiantHeaderTableDoc();
  const chunks: Chunk[] = await splitMarkdownAware(input, MAX_CHUNK_BYTES + 1000, 0);
  process.stdout.write(JSON.stringify(chunks));
};

main().catch((err: unknown) => {
  console.error("giantHeaderProbe crashed:", err);
  process.exit(1);
});
