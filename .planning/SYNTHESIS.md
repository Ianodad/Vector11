# Synthesis — 2026-07-30 — vector11 retrieval/season/chunking branch: blockers cleared, re-seed shipped

## What was built (all on `fix/retrieval-season-hybrid`, pushed to origin)

| Commit | What |
|---|---|
| 257f589 | Chunker liveness (progress-guarded table cuts) + 8000-byte invariant (split-not-truncate, capped prefix, throwing backstop) — Codex blockers 1–2 |
| f7f5966 | Collection lifecycle: verified drops, retried + config-verified creation, seed failure rails — blockers 3–5 |
| e9bf686 | Duplicate-aware count assertion; poll tolerates flaky listCollections |
| 7a36871 | Validator: strict marker COUNT+ORDER coverage, no truncation carve-out, giant-header + oversized-prefix regression tests — finding 9 |
| 363c256 | Cap prefix before split-fit check (round-2 MAJOR); subprocess-isolated hang test (round-2 MINOR) |
| 7e07953 + dc38f1a | update-db.yml: explicit per-run `force_recreate` dispatch input, no repo-var fallback — round-2 BLOCKER + round-3 finding |
| b4db0e3 | **Field-index canary probe** after create — catches partial materialization invisible to definition checks (born from live incident, see below) |

Also on `main` (deploy plumbing only, no app code): 679a722 empty redeploy commit, 9178e91 `prod-smoke.yml` workflow.

## Outcomes (all verified live, not from reports)
- **Option A**: prod redeployed with EMBEDDING_DIMENSIONS=1536 (via empty commit
  to main — local network firewalls all of *.vercel.*). Smoke test green.
- **Option B**: all 5 Codex blockers + MINOR fixed; review chain
  NO-GO → NO-GO(narrow) → **GO** → SOUND across 4 Codex passes.
- **Accuracy gate 4/4** (vs 3/4 baseline) — re-measured after every change wave.
- **Re-seed done** (attempt 2, run 30540848893): 300 URLs processed,
  24 skipped, **0 failed**, 15,089 records, 537 dup-tolerated, 0 oversized,
  count assertion passed, exit 0. Collection config + field indexes verified;
  prod smoke returns fresh 2025/26 data (Arsenal 85 pts).

## Incident during execution (and what it hardened)
Seed attempt 1 (run 30529868065): `createCollection` hit Astra's PT30S
server-side timeout; the collection materialized with a CLEAN definition but
NO field indexes → all filtered queries failed (`CORRUPTED_COLLECTION_SCHEMA`),
which would have left prod retrieval down. Detected via direct probing (~50 min
into flat insert counts), run cancelled, `probeFieldIndexes` canary added
(b4db0e3, Codex: SOUND), attempt 2 clean. Lesson: Astra definition checks
CANNOT see index state; only a filtered query proves a collection usable.

## Divergences from spec / accepted risks (disclosed to Codex, ruled non-blocking)
- Blocker 5 (non-atomic in-place rebuild): cheap rails only (failedUrls,
  count assertion, exitCode) — staging-collection redesign deliberately not done.
- MAJOR 6 (aggregate-error triage) and MAJOR 7 (parent `_id` hashes unprefixed
  text; cross-source collision) remain open, pre-existing on main.
- Worktree isolation for parallel workers replaced by disjoint-file dispatch +
  workers forbidden from git (node_modules cost); no conflicts occurred.
- Scraper decay: 24 URLs skipped (blocked/dead) — replacement sources researched
  in `.planning/research-sources.md`, not yet implemented.

## Open flag — the one remaining decision (user's)
Production still runs OLD app code against the NEW collection (works, proven).
The branch's API improvements (season semantics, hybrid retrieval, cold-start
handling) ship only when `fix/retrieval-season-hybrid` merges to main and prod
redeploys. Merge is NOT done — per standing rule, no merge to main without
explicit user instruction.
