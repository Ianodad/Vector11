// Standalone validation for markdown-aware chunking. Builds realistic fake
// Understat-style documents in memory and asserts the chunker never
// separates table rows from their header/season context, never drops
// content, never duplicates rows, and never mis-stamps section metadata.
// Touches nothing — no DB, no network. Run with: npx tsx scripts/validateChunking.ts
import { createParentChildChunks, MAX_DOCUMENT_BYTES } from "./lib/utils/chunking.js";
import { splitMarkdownAware, MAX_CHUNK_BYTES } from "./lib/utils/markdownChunker.js";
import { isLowValueContent } from "./lib/scrapers/contentFilter.js";

type Failures = string[];

const TEAMS = [
  "Arsenal", "Man City", "Liverpool", "Chelsea", "Newcastle",
  "Man United", "Tottenham", "Aston Villa", "Brighton", "West Ham",
  "Crystal Palace", "Brentford", "Fulham", "Wolves", "Everton",
  "Bournemouth", "Nottingham Forest", "Leicester", "Ipswich", "Southampton",
];

const TABLE_HEADER = "| Pos | Team | MP | W | D | L | GF | GA | GD | Pts | xG | xGA | xGD | xPts |";
const TABLE_SEP = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";

const buildStandingsDoc = (): string => {
  const rows = TEAMS.map((team, idx) => {
    const pos = idx + 1;
    const pts = 85 - idx * 3;
    return `| ${pos} | ${team} | 38 | 20 | 5 | 13 | 60 | 40 | 20 | ${pts} | 58.2 | 41.1 | 17.1 | ${pts - 2}.4 |`;
  });

  return [
    "# Premier League · 2025/26 · League Table",
    "",
    "> **Type:** League standings  |  **League:** Premier League  |  **Season:** 2025/26  |  **Matchday:** ~38  |  **Source:** https://understat.com/league/EPL",
    "",
    "## Column Key",
    "",
    "Pos = Position, MP = Matches Played, W = Wins, D = Draws, L = Losses,",
    "GF = Goals For, GA = Goals Against, GD = Goal Difference, Pts = Points,",
    "xG = Expected Goals, xGA = Expected Goals Against, xGD = Expected Goal Difference,",
    "xPts = Expected Points.",
    "",
    "## Standings",
    "",
    TABLE_HEADER,
    TABLE_SEP,
    ...rows,
    "",
  ].join("\n");
};

// Fix A: the real Understat scraper concatenates standings + player stats +
// fixtures into ONE document, each with its own `> **Type:** ...` line, while
// League/Season are only stated once at the top. This must not let one
// section's metadata bleed onto another's chunks, and the fields the section
// omits must still resolve via fallback.
const buildThreeSectionDoc = (): string => {
  return [
    "# EPL Combined Page",
    "",
    "> **League:** Premier League | **Season:** 2025/26",
    "",
    "## Standings",
    "",
    "> **Type:** League standings",
    "",
    "| Pos | Team | Pts | MP |",
    "|---|---|---|---|",
    "| 1 | Arsenal | 85 | 38 |",
    "| 2 | Man City | 82 | 38 |",
    "| 3 | Liverpool | 78 | 38 |",
    "| 4 | Chelsea | 70 | 38 |",
    "",
    "## Player Stats",
    "",
    "> **Type:** Player stats",
    "",
    "| Player | Team | Goals | Assists |",
    "|---|---|---|---|",
    "| Saka | Arsenal | 12 | 9 |",
    "| Haaland | Man City | 20 | 5 |",
    "| Salah | Liverpool | 18 | 11 |",
    "| Palmer | Chelsea | 14 | 8 |",
    "",
    "## Fixtures",
    "",
    "> **Type:** Fixture list",
    "",
    "| Match Date | Home Team | Away Team | Kickoff |",
    "|---|---|---|---|",
    "| 2026-08-01 | Arsenal | Man City | 15:00 |",
    "| 2026-08-02 | Chelsea | Liverpool | 17:30 |",
    "| 2026-08-08 | Man City | Chelsea | 15:00 |",
    "| 2026-08-09 | Liverpool | Arsenal | 16:30 |",
    "",
  ].join("\n");
};

const runStandingsTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const doc = buildStandingsDoc();
  const sizes = { parentMaxSize: 1500, parentOverlap: 200, childMaxSize: 400, childOverlap: 50 };

  const result = await createParentChildChunks(
    doc, sizes, "Understat EPL", "https://understat.com/league/EPL", "stats", isLowValueContent,
  );

  if (!result) {
    failures.push("createParentChildChunks returned null — no chunks produced at all.");
    return failures;
  }

  const { parentDocs, childTexts } = result;
  console.log(`\n=== Standings: parents=${parentDocs.length} children=${childTexts.length} ===`);

  // 1 & 2: every row appears at least once, and never more than once, in the
  // CHILD set — children are what retrieval actually queries.
  for (const team of TEAMS) {
    const marker = `| ${team} |`;
    const count = childTexts.filter((c) => c.includes(marker)).length;
    if (count === 0) {
      failures.push(`team "${team}": missing from CHILD set — unreachable by retrieval`);
    } else if (count > 1) {
      failures.push(`team "${team}": appears in ${count} child chunks — duplicated`);
    }
  }

  // 3: every child chunk containing a data row also contains the header row
  // for its table.
  childTexts.forEach((chunk, idx) => {
    const hasDataRow = TEAMS.some((team) => chunk.includes(`| ${team} |`));
    const hasHeader = chunk.includes("| Pos | Team |");
    if (hasDataRow && !hasHeader) {
      failures.push(`child ${idx}: has a table row but not the "| Pos | Team |" header`);
    }
  });

  // No chunk should be a bare header with no data rows.
  [...parentDocs.map((p) => p.content), ...childTexts].forEach((chunk, idx) => {
    const hasHeader = chunk.includes("| Pos | Team |");
    const hasDataRow = TEAMS.some((team) => chunk.includes(`| ${team} |`));
    if (hasHeader && !hasDataRow) {
      failures.push(`chunk ${idx}: has the table header but no data rows`);
    }
  });

  // 4: every chunk carries Season: and the correct Type: for its section.
  [...parentDocs.map((p) => p.content), ...childTexts].forEach((chunk, idx) => {
    if (!chunk.includes("Season: 2025/26")) {
      failures.push(`chunk ${idx}: missing "Season: 2025/26"`);
    }
    if (!chunk.includes("Type: League standings")) {
      failures.push(`chunk ${idx}: missing "Type: League standings"`);
    }
  });

  return failures;
};

const runThreeSectionMetaTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const doc = buildThreeSectionDoc();
  const sizes = { parentMaxSize: 1000, parentOverlap: 100, childMaxSize: 300, childOverlap: 30 };

  const result = await createParentChildChunks(
    doc, sizes, "Understat EPL Combined", "https://understat.com/league/EPL", "stats", isLowValueContent,
  );

  if (!result) {
    failures.push("three-section doc: createParentChildChunks returned null");
    return failures;
  }

  const allChunks = [...result.parentDocs.map((p) => p.content), ...result.childTexts];
  console.log(
    `\n=== Three-section meta: parents=${result.parentDocs.length} children=${result.childTexts.length} ===`,
  );

  const expectations: Array<{ marker: string; type: string }> = [
    { marker: "| Arsenal | 85 |", type: "Type: League standings" },
    { marker: "| Saka |", type: "Type: Player stats" },
    { marker: "| 2026-08-01 |", type: "Type: Fixture list" },
  ];

  for (const { marker, type } of expectations) {
    const matching = allChunks.filter((c) => c.includes(marker));
    if (matching.length === 0) {
      failures.push(`three-section doc: no chunk found containing "${marker}"`);
      continue;
    }
    for (const chunk of matching) {
      if (!chunk.includes(type)) {
        failures.push(
          `three-section doc: chunk with "${marker}" does not carry "${type}" — wrong/missing section Type`,
        );
      }
      if (!chunk.includes("Season: 2025/26")) {
        failures.push(
          `three-section doc: chunk with "${marker}" missing "Season: 2025/26" (league/season fallback failed)`,
        );
      }
    }
  }

  const distinctTypesSeen = new Set(
    allChunks.flatMap((c) => {
      const m = c.match(/Type: ([^|\n]+)/);
      return m ? [m[1].trim()] : [];
    }),
  );
  for (const expectedType of ["League standings", "Player stats", "Fixture list"]) {
    if (!distinctTypesSeen.has(expectedType)) {
      failures.push(`three-section doc: Type "${expectedType}" never appears on any chunk`);
    }
  }

  return failures;
};

// Fix B: a table with a header row and data rows but NO separator line must
// neither drop nor duplicate rows, and the chunker must not invent a
// separator line that was never in the source.
const runNoSeparatorTableTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const input = "| H1 | H2 |\n| a1 | a2 |\n| b1 | b2 |\n| c1 | c2 |";
  const pieces = (await splitMarkdownAware(input, 35, 35)).map((c) => c.text);

  console.log(`\n=== No-separator table: ${pieces.length} piece(s) ===`);
  pieces.forEach((p: string, idx: number) => console.log(`  [${idx}] ${JSON.stringify(p)}`));

  const rowMarkers = ["| a1 |", "| b1 |", "| c1 |"];
  for (const marker of rowMarkers) {
    const count = pieces.filter((p: string) => p.includes(marker)).length;
    if (count === 0) failures.push(`no-separator table: row "${marker}" dropped`);
    if (count > 1) failures.push(`no-separator table: row "${marker}" duplicated across ${count} pieces`);
  }
  for (const piece of pieces) {
    const hasDataRow = rowMarkers.some((m: string) => piece.includes(m));
    if (hasDataRow && !piece.includes("| H1 | H2 |")) {
      failures.push(`no-separator table: piece missing header — ${JSON.stringify(piece)}`);
    }
  }
  for (const piece of pieces) {
    if (/^\s*\|[\s:|-]+\|\s*$/m.test(piece)) {
      failures.push(`no-separator table: a separator line was invented — ${JSON.stringify(piece)}`);
    }
  }

  return failures;
};

// Fix C: heading-only content (no following block) must not vanish.
const runHeadingOnlyTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const pieces = (await splitMarkdownAware("# One\n\n## Two\n", 20, 5)).map((c) => c.text);

  console.log(`\n=== Heading-only doc: ${pieces.length} piece(s) ===`);
  pieces.forEach((p: string, idx: number) => console.log(`  [${idx}] ${JSON.stringify(p)}`));

  if (pieces.length === 0) {
    failures.push("heading-only doc: produced zero chunks — content dropped entirely");
  }
  const combined = pieces.join("\n");
  if (!combined.includes("# One")) failures.push('heading-only doc: "# One" text vanished');
  if (!combined.includes("## Two")) failures.push('heading-only doc: "## Two" text vanished');

  return failures;
};

// Fix E: two tables with no blank line between them must not merge — the
// second table's header/separator must not be swallowed as data rows of the
// first, and pieces must not repeat the wrong header over the wrong rows.
const runAdjacentTablesTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const input = [
    "| A1 | A2 |",
    "|---|---|",
    "| a1 | a2 |",
    "| a3 | a4 |",
    "| B1 | B2 |",
    "|---|---|",
    "| b1 | b2 |",
    "| b3 | b4 |",
  ].join("\n");

  const pieces = (await splitMarkdownAware(input, 500, 0)).map((c) => c.text);
  console.log(`\n=== Adjacent tables: ${pieces.length} piece(s) ===`);
  pieces.forEach((p: string, idx: number) => console.log(`  [${idx}] ${JSON.stringify(p)}`));

  for (const marker of ["| a1 |", "| a3 |", "| b1 |", "| b3 |"]) {
    const count = pieces.filter((p: string) => p.includes(marker)).length;
    if (count === 0) failures.push(`adjacent tables: row "${marker}" dropped`);
    if (count > 1) failures.push(`adjacent tables: row "${marker}" duplicated across ${count} pieces`);
  }

  const bRowsWithAHeader = pieces.some(
    (p: string) => (p.includes("| b1 |") || p.includes("| b3 |")) && p.includes("| A1 | A2 |"),
  );
  if (bRowsWithAHeader) {
    failures.push("adjacent tables: table B's rows carry table A's header — tables merged");
  }
  const aRowsWithBHeader = pieces.some(
    (p: string) => (p.includes("| a1 |") || p.includes("| a3 |")) && p.includes("| B1 | B2 |"),
  );
  if (aRowsWithBHeader) {
    failures.push("adjacent tables: table A's rows carry table B's header — tables merged");
  }

  const hasAHeaderWithARows = pieces.some(
    (p: string) => p.includes("| A1 | A2 |") && (p.includes("| a1 |") || p.includes("| a3 |")),
  );
  const hasBHeaderWithBRows = pieces.some(
    (p: string) => p.includes("| B1 | B2 |") && (p.includes("| b1 |") || p.includes("| b3 |")),
  );
  if (!hasAHeaderWithARows) failures.push("adjacent tables: no piece pairs table A's header with A's own rows");
  if (!hasBHeaderWithBRows) failures.push("adjacent tables: no piece pairs table B's header with B's own rows");

  return failures;
};

// Astra hard limits (FIX K–N): rejects any indexed String field (content,
// $lexical) over 8,000 BYTES, not characters — and this corpus is full of
// multi-byte glyphs (·, −, é, ö, –). A pathologically wide table row (e.g. a
// stray long note or URL crammed into one cell) must never produce a chunk
// Astra would reject outright, since that would abort the entire seed run.
const buildWideRowDoc = (): string => {
  const glyphs = "·−";
  let wideCell = "";
  while (wideCell.length < 20000) wideCell += glyphs;
  wideCell = wideCell.slice(0, 20000);

  return [
    "# Wide Row Test",
    "",
    "> **Type:** League standings  |  **League:** Premier League  |  **Season:** 2025/26  |  **Source:** https://understat.com/league/EPL",
    "",
    "| Pos | Team | Notes |",
    "|---|---|---|",
    `| 1 | Arsenal | ${wideCell} |`,
    "| 2 | Man City | steady |",
    "",
  ].join("\n");
};

const runByteCeilingTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const doc = buildWideRowDoc();
  const sizes = { parentMaxSize: 1500, parentOverlap: 200, childMaxSize: 400, childOverlap: 50 };

  const result = await createParentChildChunks(
    doc, sizes, "Understat EPL", "https://understat.com/league/EPL", "stats", isLowValueContent,
  );

  if (!result) {
    failures.push("byte-ceiling: createParentChildChunks returned null — no chunks produced at all");
    return failures;
  }

  const { parentDocs, childTexts } = result;
  const allChunks = [...parentDocs.map((p) => p.content), ...childTexts];
  console.log(`\n=== Byte ceiling: parents=${parentDocs.length} children=${childTexts.length} ===`);

  // 1 & 2: every chunk (parent AND child, prefix included) must be <= 8000
  // bytes, and must round-trip cleanly through UTF-8 (no split code point).
  allChunks.forEach((chunk, idx) => {
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (bytes > MAX_DOCUMENT_BYTES) {
      failures.push(`byte-ceiling: chunk ${idx} is ${bytes} bytes, exceeds the ${MAX_DOCUMENT_BYTES}-byte ceiling`);
    }
    if (Buffer.from(chunk, "utf8").toString("utf8") !== chunk) {
      failures.push(`byte-ceiling: chunk ${idx} does not round-trip through UTF-8 — a multi-byte character was split`);
    }
    if (chunk.includes("�")) {
      failures.push(`byte-ceiling: chunk ${idx} contains a U+FFFD replacement character`);
    }
  });

  // 3: the wide row's content must still appear somewhere — split across
  // several chunks is fine (truncation is allowed), total loss is not — and
  // every piece of it must still carry the table header.
  const wideRowChunks = allChunks.filter((c) => c.includes("·") || c.includes("−"));
  if (wideRowChunks.length === 0) {
    failures.push("byte-ceiling: the wide row's content is completely absent from every chunk");
  }
  for (const chunk of wideRowChunks) {
    if (!chunk.includes("| Pos | Team | Notes |")) {
      failures.push(`byte-ceiling: a piece of the wide row is missing its table header — ${JSON.stringify(chunk.slice(0, 80))}`);
    }
  }

  return failures;
};

const runEmojiTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const REPLACEMENT_CHAR = "\uFFFD";
  
  // Test with overlap = 0 first (the bug case)
  const input = "a".repeat(399) + "\u{1F600}" + " tail text";
  const chunksZeroOverlap = await splitMarkdownAware(input, 400, 0);

  console.log(`\n=== Emoji test (overlap=0): ${chunksZeroOverlap.length} chunk(s) ===`);
  chunksZeroOverlap.forEach((c, idx) => console.log(`  [${idx}] length=${c.text.length}, bytes=${Buffer.byteLength(c.text, "utf8")}`));

  // Content preservation: emoji must survive
  const emojiSurvivesZero = chunksZeroOverlap.some((c) => c.text.includes("\u{1F600}"));
  if (!emojiSurvivesZero) {
    failures.push("emoji test (overlap=0): emoji \\u{1F600} not found in any chunk — content was lost");
  }

  // No chunk should contain replacement character
  for (const c of chunksZeroOverlap) {
    if (c.text.includes(REPLACEMENT_CHAR)) {
      failures.push(`emoji test (overlap=0): chunk contains U+FFFD replacement character — ${JSON.stringify(c.text.slice(0, 80))}`);
    }
  }

  // Every chunk must round-trip cleanly
  for (const c of chunksZeroOverlap) {
    if (Buffer.from(c.text, "utf8").toString("utf8") !== c.text) {
      failures.push(`emoji test (overlap=0): chunk does not round-trip through UTF-8 — ${JSON.stringify(c.text.slice(0, 80))}`);
    }
  }

  // No lone surrogates
  const loneSurrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const c of chunksZeroOverlap) {
    if (loneSurrogatePattern.test(c.text)) {
      failures.push(`emoji test (overlap=0): chunk contains a lone surrogate — ${JSON.stringify(c.text.slice(0, 80))}`);
    }
  }

  // Content preservation invariant: strip whitespace, concatenate, and check all characters are present
  const strippedInput = input.replace(/\s+/g, "");
  const concatenatedOutput = chunksZeroOverlap.map((c) => c.text).join("").replace(/\s+/g, "");
  for (const char of strippedInput) {
    if (!concatenatedOutput.includes(char)) {
      failures.push(`emoji test (overlap=0): character "${char}" (${char.codePointAt(0)?.toString(16)}) is missing from output — content loss`);
      break;
    }
  }

  // Now test with overlap = 50 (should still work)
  const chunksWithOverlap = await splitMarkdownAware(input, 400, 50);
  console.log(`\n=== Emoji test (overlap=50): ${chunksWithOverlap.length} chunk(s) ===`);
  chunksWithOverlap.forEach((c, idx) => console.log(`  [${idx}] length=${c.text.length}, bytes=${Buffer.byteLength(c.text, "utf8")}`));

  const emojiSurvivesOverlap = chunksWithOverlap.some((c) => c.text.includes("\u{1F600}"));
  if (!emojiSurvivesOverlap) {
    failures.push("emoji test (overlap=50): emoji \\u{1F600} not found in any chunk — content was lost");
  }

  for (const c of chunksWithOverlap) {
    if (c.text.includes(REPLACEMENT_CHAR)) {
      failures.push(`emoji test (overlap=50): chunk contains U+FFFD replacement character — ${JSON.stringify(c.text.slice(0, 80))}`);
    }
    if (Buffer.from(c.text, "utf8").toString("utf8") !== c.text) {
      failures.push(`emoji test (overlap=50): chunk does not round-trip through UTF-8 — ${JSON.stringify(c.text.slice(0, 80))}`);
    }
    if (loneSurrogatePattern.test(c.text)) {
      failures.push(`emoji test (overlap=50): chunk contains a lone surrogate — ${JSON.stringify(c.text.slice(0, 80))}`);
    }
  }

  // Content preservation for overlap=50 as well
  const concatenatedOutputOverlap = chunksWithOverlap.map((c) => c.text).join("").replace(/\s+/g, "");
  for (const char of strippedInput) {
    if (!concatenatedOutputOverlap.includes(char)) {
      failures.push(`emoji test (overlap=50): character "${char}" (${char.codePointAt(0)?.toString(16)}) is missing from output — content loss`);
      break;
    }
  }

  return failures;
};

const runProseMultiSectionTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const input = [
    "> **Type:** Alpha  |  **League:** EPL  |  **Season:** 2025/26",
    "",
    "Alpha section prose about the first topic, long enough to stand as its own chunk of text.",
    "",
    "> **Type:** Beta  |  **League:** EPL  |  **Season:** 2025/26",
    "",
    "Beta section prose about the second topic, also long enough to stand as its own chunk.",
  ].join("\n");

  const chunks = await splitMarkdownAware(input, 200, 0);

  console.log(`\n=== Prose multi-section: ${chunks.length} chunk(s) ===`);
  chunks.forEach((c, idx) => console.log(`  [${idx}] docType=${c.meta.docType}, text="${c.text.slice(0, 60)}..."`));

  const alphaChunks = chunks.filter((c) => c.text.includes("Alpha section prose"));
  const betaChunks = chunks.filter((c) => c.text.includes("Beta section prose"));

  for (const c of alphaChunks) {
    if (c.meta.docType !== "Alpha") {
      failures.push(`prose multi-section: chunk with Alpha prose has docType="${c.meta.docType}", expected "Alpha"`);
    }
  }

  for (const c of betaChunks) {
    if (c.meta.docType !== "Beta") {
      failures.push(`prose multi-section: chunk with Beta prose has docType="${c.meta.docType}", expected "Beta"`);
    }
  }

  const distinctDocTypes = new Set(chunks.map((c) => c.meta.docType));
  if (distinctDocTypes.size < 2) {
    failures.push(`prose multi-section: expected at least 2 distinct docType values, got ${distinctDocTypes.size}: ${JSON.stringify([...distinctDocTypes])}`);
  }

  return failures;
};

const runOversizedHeaderTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const header = "| " + "H".repeat(8000) + " |";
  const input = [
    header,
    "|---|",
    "| a |",
    "| b |",
    "| c |",
  ].join("\n");

  const chunks = await splitMarkdownAware(input, MAX_CHUNK_BYTES + 1000, 0);

  console.log(`\n=== Oversized header: ${chunks.length} chunk(s) ===`);
  chunks.forEach((c, idx) => console.log(`  [${idx}] bytes=${Buffer.byteLength(c.text, "utf8")}`));

  if (chunks.length === 0) {
    failures.push("oversized header: produced zero chunks — content dropped entirely");
  }

  for (const c of chunks) {
    const bytes = Buffer.byteLength(c.text, "utf8");
    if (bytes > MAX_CHUNK_BYTES) {
      failures.push(`oversized header: chunk is ${bytes} bytes, exceeds MAX_CHUNK_BYTES (${MAX_CHUNK_BYTES})`);
    }
  }

  return failures;
};

const runRowCoverageTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const rows: string[] = [];
  for (let i = 1; i <= 25; i++) {
    rows.push(`| ${i} | Row${i} |`);
  }

  const table = [
    "| Pos | Team |",
    "|---|---|",
    ...rows,
    "",
  ].join("\n");

  const sizes = { parentMaxSize: 1500, parentOverlap: 200, childMaxSize: 400, childOverlap: 50 };
  const result = await createParentChildChunks(
    table, sizes, "Test Doc", "https://test.com", "stats", isLowValueContent,
  );

  if (!result) {
    failures.push("row coverage: createParentChildChunks returned null");
    return failures;
  }

  const { childTexts } = result;
  console.log(`\n=== Row coverage: ${childTexts.length} child chunk(s) ===`);

  for (let i = 1; i <= 25; i++) {
    const marker = `| ${i} |`;
    const count = childTexts.filter((c) => c.includes(marker)).length;

    if (count === 0) {
      failures.push(`row coverage: row ${i} missing from child chunks`);
    } else if (count > 1) {
      failures.push(`row coverage: row ${i} appears ${count} times in child chunks (duplicated)`);
    }
  }

  return failures;
};

const runContentPreservationTest = async (): Promise<Failures> => {
  const failures: Failures = [];
  const REPLACEMENT_CHAR = "\uFFFD";
  
  // Mixed document with prose + table + heading + multi-byte characters
  const mixedDoc = [
    "# Test Document · 2025/26",
    "",
    "> **Type:** Mixed  |  **League:** Test  |  **Season:** 2025/26",
    "",
    "This is a test paragraph with multi-byte characters: 😀 · − é. The quick brown fox jumps over the lazy dog. Testing content preservation across chunk boundaries.",
    "",
    "## Sample Table",
    "",
    "| Name | Score | Notes |",
    "|---|---|---|",
    "| Alice | 95 | Excellent · é |",
    "| Bob | 87 | Good − é |",
    "| Charlie 😀 | 92 | Has emoji |",
    "",
    "More text with special characters: 😀 another emoji · middle dot − minus sign é accent.",
  ].join("\n");

  const sizes = [100, 400, 1500];
  const loneSurrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  for (const size of sizes) {
    console.log(`\n=== Content preservation test (maxSize=${size}, overlap=0) ===`);
    const chunks = await splitMarkdownAware(mixedDoc, size, 0);
    console.log(`  Produced ${chunks.length} chunk(s)`);

    // 1. Emoji must survive
    const emojiSurvives = chunks.some((c) => c.text.includes("\u{1F600}"));
    if (!emojiSurvives) {
      failures.push(`content preservation (size=${size}): emoji \\u{1F600} not found in any chunk`);
    }

    // 2. No chunk should contain replacement character
    for (const c of chunks) {
      if (c.text.includes(REPLACEMENT_CHAR)) {
        failures.push(`content preservation (size=${size}): chunk contains U+FFFD — ${JSON.stringify(c.text.slice(0, 80))}`);
      }
    }

    // 3. Every chunk must round-trip cleanly
    for (const c of chunks) {
      if (Buffer.from(c.text, "utf8").toString("utf8") !== c.text) {
        failures.push(`content preservation (size=${size}): chunk does not round-trip through UTF-8 — ${JSON.stringify(c.text.slice(0, 80))}`);
      }
    }

    // 4. No lone surrogates
    for (const c of chunks) {
      if (loneSurrogatePattern.test(c.text)) {
        failures.push(`content preservation (size=${size}): chunk contains a lone surrogate — ${JSON.stringify(c.text.slice(0, 80))}`);
      }
    }

    // 5. Content preservation invariant: strip whitespace, concatenate, check all characters present
    const strippedInput = mixedDoc.replace(/\s+/g, "");
    const concatenatedOutput = chunks.map((c) => c.text).join("").replace(/\s+/g, "");
    for (const char of strippedInput) {
      if (!concatenatedOutput.includes(char)) {
        failures.push(`content preservation (size=${size}): character "${char}" (${char.codePointAt(0)?.toString(16)}) is missing from output`);
        break;
      }
    }

    // Verify specific multi-byte characters
    const multiByteChars = ["😀", "·", "−", "é"];
    for (const char of multiByteChars) {
      if (!concatenatedOutput.includes(char)) {
        failures.push(`content preservation (size=${size}): multi-byte character "${char}" is missing from output`);
      }
    }
  }

  return failures;
};

const main = async () => {
  const allFailures: Failures = [];

  allFailures.push(...(await runStandingsTest()).map((f: string) => `[standings] ${f}`));
  allFailures.push(...(await runThreeSectionMetaTest()).map((f: string) => `[three-section-meta] ${f}`));
  allFailures.push(...(await runNoSeparatorTableTest()).map((f: string) => `[no-separator-table] ${f}`));
  allFailures.push(...(await runHeadingOnlyTest()).map((f: string) => `[heading-only] ${f}`));
  allFailures.push(...(await runAdjacentTablesTest()).map((f: string) => `[adjacent-tables] ${f}`));
  allFailures.push(...(await runByteCeilingTest()).map((f: string) => `[byte-ceiling] ${f}`));
  allFailures.push(...(await runEmojiTest()).map((f: string) => `[emoji] ${f}`));
  allFailures.push(...(await runContentPreservationTest()).map((f: string) => `[content-preservation] ${f}`));
  allFailures.push(...(await runProseMultiSectionTest()).map((f: string) => `[prose-multi-section] ${f}`));
  allFailures.push(...(await runOversizedHeaderTest()).map((f: string) => `[oversized-header] ${f}`));
  allFailures.push(...(await runRowCoverageTest()).map((f: string) => `[row-coverage] ${f}`));

  console.log(`\n=== Assertions ===`);
  if (allFailures.length > 0) {
    console.error(`FAILED (${allFailures.length} issue(s)):`);
    for (const f of allFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("All assertions passed.");
  process.exit(0);
};

main().catch((err: unknown) => {
  console.error("validateChunking crashed:", err);
  process.exit(1);
});
