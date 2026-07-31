# Re-review request: blocker remediation before destructive re-seed

You (Codex) reviewed this branch on 2026-07-29 and returned NO-GO on the
destructive re-seed with 5 BLOCKER / 3 MAJOR / 1 MINOR findings. Four commits
now remediate the blockers + the MINOR. Adversarially review ONLY those
commits and give a fresh verdict.

## Commits to review (in order)
- 257f589 — chunker: BLOCKERs 1–2
- f7f5966 — lifecycle: BLOCKERs 3–4 + BLOCKER 5 partial mitigation
- e9bf686 — follow-ups: duplicate-aware count assertion; poll robustness
- 7a36871 — validator: MINOR finding 9

Use `git show <sha>` / read the files. Do NOT review unrelated pre-existing code
except where it interacts with these changes.

## Original findings → claimed remediation map
1. Table byte-ceiling raw-cut zero-progress hang (markdownChunker.ts ~529):
   canAddHeader now requires header ≤ MAX_CHUNK_BYTES − 64
   (MIN_ROW_CONTENT_BUDGET_BYTES); explicit forward-progress guard flips
   header-prepending off permanently for a piece if a cut fails to shrink the
   header-less remainder. Claim: provably terminating for any input.
2. 8,000-byte invariant breakable + remainder discard (chunking.ts ~76):
   split-not-truncate. `splitOversizedText` pre-splits parent/child text into
   pieces that each fit with the (possibly capped) prefix; `capPrefix`
   guarantees ≥1024-byte chunk budget; `enforceDocByteLimit` is now a THROWING
   backstop, never truncates. Each split piece gets own _id/embedding.
3. Swallowed drops (collection.ts): `dropCollectionVerified` — post-drop
   listCollections verification, 5 retries w/ backoff, THROWS if survivor.
4. Creation neither retried nor post-verified: `createCollectionWithRetry`
   (4 attempts, transient detection, 60s materialization poll tolerant of
   flaky listCollections) + full-config post-verify (dimension, metric,
   lexical.enabled, rerank.enabled) on every path incl. already-exists;
   one verified drop+recreate cycle on mismatch, then throw.
5. Non-atomic in-place rebuild: PARTIAL mitigation only (deliberate design
   decision, not full staging-collection redesign): summary now returns
   failedUrls/skippedUrls/attemptedRecords/recordsDuplicated; end-of-run
   count assertion recordsAdded === attempted − skipped − duplicated;
   exitCode 1 on failed URLs or mismatch; final exit respects exitCode.
9. Validator: truncation carve-out REMOVED; strict numbered-marker
   COUNT+ORDER coverage; giant-header hang regression test under a 30s
   timeout; oversized-prefix test through createParentChildChunks asserting
   ≤8000-byte stored content and tail-marker survival; trailing whitespace
   fixed.

## Deliberately OUT of scope (state whether each blocks re-seed)
- MAJOR 6: retry triage classifies only the aggregate CollectionInsertManyError
  message (first cause); recordsAdded may undercount writes committed by a
  timed-out attempt. Note: insertedCountOf() reads err.insertedIds().length —
  partially addressed already.
- MAJOR 7: parent _id hashes unprefixed text — cross-source identical text
  collides. Pre-existing on main.
- MAJOR 8 (env.ts): destructive mode + 1536 dims not fail-fast invariants
  locally. The re-seed runs via the GitHub workflow which sets
  ALLOW_COLLECTION_RECREATE=true and EMBEDDING_DIMENSIONS=1536 explicitly.

## Verification already done (do not re-run, but challenge if suspicious)
- validateChunking exit 0; tsc --noEmit clean; eslint 0 errors;
  git diff --check clean.
- Executor repro: ~7,990-byte header + multibyte row terminated in 2ms;
  exact hang-trigger shape (header at MAX_CHUNK_BYTES−10) terminated;
  oversized prefix+chunk split into 2 parents/2 children, tail marker
  survived, max stored content exactly 8000 bytes.
- Live accuracy gate (_accuracy.ts new, temp collection) re-running now.

## Verdict needed
GO or NO-GO for the destructive re-seed via the GitHub workflow path, plus any
NEW blockers introduced by these four commits. Be adversarial: hunt for
regressions these fixes could introduce (infinite loops, changed return
semantics, count double-counting, thrown errors on previously-tolerated paths
that would abort a 2-hour seed mid-run).
