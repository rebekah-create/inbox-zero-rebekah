---
phase: 09-email-calendar-reconciliation
plan: 02
subsystem: calendar-reconciliation
tags: [pure-functions, matching, similarity, signature, tdd]
requires:
  - apps/web/utils/calendar/upcoming-events-types.ts (NormalizedCalendarEvent shape)
provides:
  - titleSimilarity (whitespace-token Dice 0..1)
  - normalizeTitle + eventSignature (sha256 hex)
  - decideOutcome (MATCHED | CREATED | AMBIGUOUS) + ReconcileOutcome type
affects:
  - Consumed by 09-03 (extract), 09-05 (persist), 09-06 (orchestrator)
tech-stack:
  added: []
  patterns:
    - "Pure-function TDD module: zero I/O, zero third-party deps beyond node:crypto"
    - "Whitespace-token Dice (not character bigrams from string-similarity)"
key-files:
  created:
    - apps/web/utils/calendar/reconciliation/dice.ts
    - apps/web/utils/calendar/reconciliation/dice.test.ts
    - apps/web/utils/calendar/reconciliation/signature.ts
    - apps/web/utils/calendar/reconciliation/signature.test.ts
    - apps/web/utils/calendar/reconciliation/match.ts
    - apps/web/utils/calendar/reconciliation/match.test.ts
  modified: []
decisions:
  - "decideOutcome reads NormalizedCalendarEvent fields { id, title, start, isAllDay } directly (start is a string per Phase 8 contract, not the { dateTime, date } object the plan's interfaces sketch suggested)."
  - "signature.ts is an IMMUTABLE contract post-merge — D-14 unique constraint depends on hash stability."
  - "Whitespace-token Dice chosen over string-similarity (RESEARCH §6 Option B): character bigrams produce false positives on substring overlap between unrelated titles."
metrics:
  test_cases: 20
  duration_minutes: ~12
  files_created: 6
  files_modified: 0
---

# Phase 09 Plan 02: Pure-function reconciliation helpers — Summary

Three TDD-built pure helpers (`titleSimilarity`, `normalizeTitle` + `eventSignature`, `decideOutcome`) that form the deterministic core for Phase 9 email→calendar reconciliation. RED→GREEN cycles produced 6 atomic commits; 20 unit tests pass under vitest.

## One-liner per artifact

- **dice.ts** — Whitespace-token Dice coefficient on lowercased, trimmed input. Pure, no deps.
- **signature.ts** — `normalizeTitle` + `eventSignature` (sha256 hex). Node `createHash` only; immutable contract per D-14.
- **match.ts** — `decideOutcome` four-step decision tree (MATCHED → AMBIGUOUS-reschedule → AMBIGUOUS-near → CREATED) with D-08 all-day fast path.

## Commits (TDD pairs)

| Step | Hash | Subject |
|------|------|---------|
| Task 1 RED  | `4f2c98ca7` | `test(09-02): add failing tests for titleSimilarity (RED)` |
| Task 1 GREEN| `047603d6d` | `feat(09-02): implement titleSimilarity Dice coefficient (GREEN)` |
| Task 2 RED  | `2596bdfe2` | `test(09-02): add failing tests for eventSignature (RED)` |
| Task 2 GREEN| `88bd689db` | `feat(09-02): implement normalizeTitle + eventSignature (GREEN)` |
| Task 3 RED  | `7a6c7e8a9` | `test(09-02): add failing tests for decideOutcome (RED)` |
| Task 3 GREEN| `a7790710f` | `feat(09-02): implement decideOutcome D-06 decision tree (GREEN)` |

## Test results

```
Test Files  3 passed (3)
Tests       20 passed (20)
Duration    ~520ms
```

Breakdown: 7 dice + 6 signature + 7 match.

## decideOutcome decision-tree summary

```
candidate.isAllDay
  ├─ true  → MATCHED iff existing.start[0..10] == cand.start[0..10] AND sim ≥ 0.7
  │         else CREATED
  └─ false →
       Step 1: sim ≥ 0.7 AND |Δt| ≤ 60min  → MATCHED
       Step 2: sim ≥ 0.7 (anywhere in window) → AMBIGUOUS (reschedule, REC-06)
       Step 3: same-day AND 0.4 ≤ sim < 0.7 → AMBIGUOUS (near-match)
       Step 4: otherwise → CREATED
```

Thresholds left at `STRONG_SIM = 0.7`, `WEAK_SIM = 0.4`, `TIME_WINDOW_MS = 60 * 60 * 1000` per CONTEXT.md — **no tuning required**.

## Signature contract (D-13 / D-14)

```ts
eventSignature(title, startISO) = sha256(normalizeTitle(title) + "|" + startISO).hex
normalizeTitle(s)               = s.toLowerCase().trim().replace(/\s+/g, " ")
```

**This is an immutable contract.** D-14 unique-constraint dedupe persists `eventSignature` values to the database; bumping the algorithm or input shape silently breaks dedupe for historical rows. Any future change requires a one-off backfill migration that recomputes signatures for all existing rows under the new contract. The `signature.ts` file's docstring carries this warning.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] NormalizedCalendarEvent shape differs from plan's interfaces sketch**

- **Found during:** Task 3 (match.ts)
- **Issue:** Plan `<interfaces>` block described the type as `{ id; summary; start: { dateTime, date }; end: { dateTime, date } }`. The actual type in `apps/web/utils/calendar/upcoming-events-types.ts` (Phase 8's canonical contract) is `{ id; title; start: string; end: string; isAllDay: boolean; ... }` — `start` is an RFC3339 string for timed events and a `"YYYY-MM-DD"` string for all-day events, governed by the `isAllDay` flag (per D-02 of Phase 8). The field is named `title` not `summary`.
- **Fix:** Implemented `match.ts` against the real type. All-day detection uses `e.isAllDay` (rather than checking which sub-field is non-null). Date extraction is `e.start.slice(0, 10)` which works for both timed (RFC3339 prefix) and all-day ("YYYY-MM-DD" already) values. Test fixtures construct the real shape directly.
- **Files modified:** apps/web/utils/calendar/reconciliation/match.ts, match.test.ts
- **Commit:** `7a6c7e8a9` (tests) + `a7790710f` (impl)
- **Note for downstream plans (09-03, 09-05, 09-06):** When constructing the `candidate` argument to `decideOutcome`, `candidate.startISO` should be RFC3339 for timed and `YYYY-MM-DD` for all-day, matching the same convention. The `slice(0, 10)` extraction is the canonical "get date portion regardless of variant" idiom.

### Environment-only adjustments (not code deviations)

- The agent worktree lacks an installed `node_modules`, so `pnpm test -- ...` failed with `cross-env: command not found`. Linked `node_modules` and `apps/web/node_modules` from the main repo via Windows directory junctions (read-only consumption — no installs). Test runs invoked vitest directly: `node node_modules/vitest/vitest.mjs --run utils/calendar/reconciliation/<file>`. CI (which runs the full `pnpm test`) is unaffected.
- Commits used `--no-verify` per `~/.claude/memory/feedback_lint_ci_only.md` (husky pre-commit hook can't spawn on this Windows shell; lint is CI-only).

## Pure-function discipline verification

Grep for forbidden imports across the three source files:

```
grep -E 'from "string-similarity"|from "@/utils/prisma"|from "ai"|from "@ai-sdk|from "@/utils/calendar/client"|from "crypto-js"'
  apps/web/utils/calendar/reconciliation/{dice,signature,match}.ts
→ 0 matches
```

Allowed imports observed:

- `dice.ts` — none (pure)
- `signature.ts` — `createHash` from `node:crypto` (Node built-in)
- `match.ts` — `titleSimilarity` from `./dice`, `NormalizedCalendarEvent` type from `@/utils/calendar/upcoming-events-types`

## Threat coverage (STRIDE)

| Threat ID | Mitigation status |
|-----------|-------------------|
| T-09-07 (eventSignature determinism / tampering) | **Mitigated.** Pure sha256 over normalized inputs; unit-tested for determinism across calls (signature.test.ts Test 6). Immutability warning embedded in source docstring. |

No new threat-surface introduced. No `threat_flag:` notes for the verifier.

## Known Stubs

None. All three modules are fully implemented; no placeholder values, no TODOs.

## Self-Check

- [x] FOUND: apps/web/utils/calendar/reconciliation/dice.ts
- [x] FOUND: apps/web/utils/calendar/reconciliation/dice.test.ts
- [x] FOUND: apps/web/utils/calendar/reconciliation/signature.ts
- [x] FOUND: apps/web/utils/calendar/reconciliation/signature.test.ts
- [x] FOUND: apps/web/utils/calendar/reconciliation/match.ts
- [x] FOUND: apps/web/utils/calendar/reconciliation/match.test.ts
- [x] FOUND commit: 4f2c98ca7 (dice RED)
- [x] FOUND commit: 047603d6d (dice GREEN)
- [x] FOUND commit: 2596bdfe2 (signature RED)
- [x] FOUND commit: 88bd689db (signature GREEN)
- [x] FOUND commit: 7a6c7e8a9 (match RED)
- [x] FOUND commit: a7790710f (match GREEN)
- [x] All 20 vitest cases pass
- [x] Grep gate: 0 forbidden imports

## Self-Check: PASSED

## TDD Gate Compliance

| Plan task | RED commit | GREEN commit | REFACTOR | Status |
|-----------|------------|--------------|----------|--------|
| Task 1 (dice)      | `4f2c98ca7` | `047603d6d` | (not needed) | ✅ compliant |
| Task 2 (signature) | `2596bdfe2` | `88bd689db` | (not needed) | ✅ compliant |
| Task 3 (match)     | `7a6c7e8a9` | `a7790710f` | (not needed) | ✅ compliant |

Each task observed test(...) RED before feat(...) GREEN. No REFACTOR commits were necessary — the implementations match RESEARCH §6 Option B / §E contracts verbatim.
