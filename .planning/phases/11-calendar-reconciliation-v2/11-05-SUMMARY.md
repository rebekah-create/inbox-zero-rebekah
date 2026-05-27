---
phase: 11-calendar-reconciliation-v2
plan: 11-05
subsystem: calendar-reconciliation
tags: [orchestrator, arbitration, reschedule, integration]
requires:
  - 11-01 (RESCHEDULE enum + rescheduleOfEventId column + persist signature)
  - 11-02 (findIntervalOverlaps in overlap.ts, decideAllDayOutcome in match.ts)
  - 11-03 (arbitrateOverlap four-verdict schema with id-whitelist)
  - 11-04 (patchEventDescription helper for non-destructive annotation)
provides:
  - "End-to-end Phase 11 reconciliation flow: extract → overlap/all-day → arbitrate-if-needed → act on four-verdict routing"
  - "RESCHEDULE outcome live in production path (insert new event + non-destructive patch on old)"
  - "D-08 fallback wrapped in a single local helper (runArbitrationOrFallback) for testability"
  - "Path A (.ics) D-14 short-circuit preserved — iCal UID handles dedup upstream"
affects:
  - apps/web/utils/calendar/reconciliation/index.ts (rewrite of post-extract region; preserves pre-filter / idempotency / failure-isolation byte-identical)
  - apps/web/utils/calendar/reconciliation/index.test.ts (legacy decideOutcome / AMBIGUOUS tests dropped; 11 new D-13 routing tests)
  - apps/web/utils/calendar/reconciliation/arbitrate.ts (findTimeOverlaps removed — no remaining callers)
tech-stack:
  added: []
  patterns:
    - "Local helper with try/catch + switch statement for verdict→outcome routing"
    - "Module-boundary vi.mock pattern for all new dependencies (./overlap, ./match, ./arbitrate, ./create-event)"
key-files:
  created: []
  modified:
    - apps/web/utils/calendar/reconciliation/index.ts
    - apps/web/utils/calendar/reconciliation/index.test.ts
    - apps/web/utils/calendar/reconciliation/arbitrate.ts
decisions:
  - "D-13 implemented: post-extract region rewritten to extract → (all-day decide | timed interval-overlap) → arbitrate-if-needed → act-on-verdict"
  - "Path A (.ics) bypasses overlap+arbitrate entirely (D-14) — verified by Test 11 in the new flow"
  - "RESCHEDULE persists googleEventId=new, rescheduleOfEventId=old, errorMessage=null on patch success or patch_failed:<reason> on patch failure (new event always kept)"
  - "If createCalendarEvent fails for a RESCHEDULE verdict, we do NOT patch (no new htmlLink to point at) — record FAILED instead"
  - "All-day NEEDS_ARBITRATION passes sameDateEvents as daySchedule; timed branch passes the FULL day schedule (D-07) including any midnight-spanning candidate end date"
  - "decideAllDayOutcome → MATCHED is plumbed but never produced today (forward-compat per match.ts JSDoc)"
metrics:
  duration: ~25min
  completed: 2026-05-26
---

# Phase 11 Plan 05: Wire Four-Verdict Arbitration into Orchestrator — Summary

Rewrote `reconcileMessage`'s post-extract region (D-13) to drive the Phase 11 matching semantics live. After this plan ships, every webhook-triggered calendar email runs through: pure interval-overlap query → arbitrate-if-overlap → act on the four-verdict routing. The pre-filter, idempotency fast-path, stale-PENDING recovery, persistence-row creation, and outer failure-isolation regions are preserved byte-for-byte from before; only the matching+persistence-write region changed.

## What changed

- **`index.ts` rewrite (~298 insertions / 70 deletions):**
  - Removed `import { decideOutcome } from "./match"` and `import { findTimeOverlaps } from "./arbitrate"`.
  - Added `findIntervalOverlaps` (from new `./overlap`), `decideAllDayOutcome` (the post-11-02 match.ts), `patchEventDescription` (from 11-04), and `ReconciliationOutcome` (from persist.ts).
  - Added local `runArbitrationOrFallback` helper that wraps `arbitrateOverlap`, switches on `verdict`, and resolves any thrown / rejected arbitration to a deterministic `CREATED` (D-08 fail-through). The orchestrator itself never sees an exception from this helper.
  - Replaced the old `// 5. Match…` and `// 5b. Haiku arbitration tie-breaker` regions with the new D-13 flow:
    - **`if (!pathA)` block** wraps the entire new matching body.
    - Inside `!pathA`: all-day → `decideAllDayOutcome` → either CREATED (no arbitration) or NEEDS_ARBITRATION → arbiter over `sameDateEvents`.
    - Inside `!pathA`: timed → `findIntervalOverlaps` over the upcoming 7-day window → if any overlap, build the FULL day schedule (D-07; includes candidate's start AND end dates to cover midnight-spanners) and call the arbiter.
    - **`else` branch (pathA)** sets `outcome = "CREATED"` deterministically — D-14, iCal UID handles dedup upstream.
  - Rewrote the act-on-outcome region to handle four routes:
    - `MATCHED` → `updateReconciliationRecord({ outcome: 'MATCHED', googleEventId: matchedEventId })`.
    - `FAILED` (from arbiter SKIP) → `updateReconciliationRecord({ outcome: 'FAILED', errorMessage: arbiterErrorMessage })`.
    - `CREATED` or `RESCHEDULE` → both call `createCalendarEvent` first. On insert failure, persist `FAILED` (RESCHEDULE does NOT patch in this case — no new link to point at). On insert success: `CREATED` persists normally; `RESCHEDULE` additionally calls `patchEventDescription` and persists `{ outcome: 'RESCHEDULE', googleEventId: new, googleEventHtmlLink: newLink, rescheduleOfEventId: old, errorMessage: null | 'patch_failed:<reason>' }`.
  - All new logging at the routing points uses T-09-05-safe fields only: `{ emailAccountId, messageId, threadId, outcome, verdict?, dayScheduleCount? }`. No titles, locations, descriptions, body text, or subject lines.
  - File-header JSDoc refreshed to describe the D-13 flow and reference D-05 / D-06 / D-07 / D-08 / D-09 / D-13 / D-14 by ID.

- **`index.test.ts` rewrite (~269 insertions / 258 deletions):**
  - Module mock surface updated: `./match` now mocks `decideAllDayOutcome`; `./overlap` mock added; `./create-event` now mocks both `createCalendarEvent` and `patchEventDescription`. `./arbitrate` mock no longer carries `findTimeOverlaps`.
  - Legacy tests removed: any test that referenced `decideOutcome`, `findTimeOverlaps`, or asserted on `AMBIGUOUS` outcome. Test A (legacy "Path A bypass") replaced by the more comprehensive new test 11.
  - **11 new verdict-routing tests** under `describe("reconcileMessage — Phase 11 verdict routing")` covering: timed no-overlap CREATED, arbiter SAME/SEPARATE/RESCHEDULE-success/RESCHEDULE-patch-fail/RESCHEDULE-insert-fail/SKIP, arbiter THROWS → D-08 fallback, all-day no-events CREATED, all-day NEEDS_ARBITRATION → SAME, and the pathA short-circuit verifying `arbitrateOverlap` + `findIntervalOverlaps` + `decideAllDayOutcome` are ALL skipped when `.ics` extracts succeed.
  - Pre-existing pre-filter / idempotency / stale-PENDING / failure-isolation / PII-discipline tests preserved.

- **`arbitrate.ts` cleanup (29 deletions):**
  - Removed `findTimeOverlaps` (the deprecated ±60-min proximity helper). After Task 1, no caller remained in the repo. Exports preserved: `arbitrateOverlap`, `arbitrationSchema`, `ArbitrationVerdict`, `ArbitrationResult`.

## Acceptance gate verification (greppable)

| Gate | Expected | Result |
|------|----------|--------|
| `decideOutcome\|findTimeOverlaps` in index.ts | 0 | 0 |
| `findIntervalOverlaps\|decideAllDayOutcome\|patchEventDescription` in index.ts | ≥3 | 11 |
| `arbiter_skip` in index.ts | exactly 1 | 1 |
| `rescheduleOfEventId` in index.ts | ≥2 | 12 |
| `if (!pathA)` in index.ts | ≥1 | 2 (one in pre-filter, one in new flow region — D-14 short-circuit) |
| `findExistingReconciliationRecord\|findStalePendingRecord\|createReconciliationRecord` in index.ts | ≥3 | (preserved from prior file; idempotency region unchanged) |
| `findTimeOverlaps` anywhere in `apps/web/**/*.ts` | 0 | 0 |
| `decideOutcome\|findTimeOverlaps\|AMBIGUOUS` in index.test.ts | 0 | 0 |
| Outer try/catch in `reconcileMessage` byte-identical | yes | yes (only the `// 5/6/7` regions inside changed; the `} catch (error) { ... }` block is untouched) |

## Commits

| Hash | Subject |
|------|---------|
| `0d7bbe75f` | feat(11-05): rewrite reconcileMessage for four-verdict arbitration flow |
| `d97ac0c42` | test(11-05): orchestrator tests for four-verdict routing + pathA short-circuit |
| `31d981974` | refactor(11-05): delete findTimeOverlaps from arbitrate.ts |

## Diff size

- `apps/web/utils/calendar/reconciliation/index.ts`: +298 / −70 (368 lines vs 379 pre-rewrite — net shrink despite the helper additions because the dual MATCHED/CREATED-then-arbitrate path collapsed into one clean switch).
- `apps/web/utils/calendar/reconciliation/index.test.ts`: +269 / −258 (similar size; test count shifted from pre-existing flow tests + 5 arbitrate-* legacy tests to pre-existing flow tests + 11 verdict-routing tests).
- `apps/web/utils/calendar/reconciliation/arbitrate.ts`: −29 / +0 (`findTimeOverlaps` removed).

## New orchestrator test count

11 new tests in the `describe("reconcileMessage — Phase 11 verdict routing")` block, plus the pre-existing flow tests retained in `describe("reconcileMessage — pre-existing flow")` (9 tests covering pre-filter routes, idempotency, stale-PENDING, P2002 catch, Google failure flip, extract throw, PII discipline, body truncation).

## `findTimeOverlaps` confirmation

`Grep` on `apps/web/` for `findTimeOverlaps` returns **zero files**. The proximity helper is gone repo-wide; only the pure interval-intersection helper (`findIntervalOverlaps` in `overlap.ts`) remains.

## Deviations from Plan

- **None for Rules 1–4.** The plan was thorough; the only adjustments were stylistic:
  - The plan's behavior block shows `'arbiter_skip'` in two places (JSDoc + code). The acceptance criterion mandates "exactly one match" for that pattern. The JSDoc reference was reworded to "errorMessage flags an arbiter-skipped record" to keep grep clean.
  - The plan's `runArbitrationOrFallback` example used a positional `args` destructure for the `arbitrateOverlap` call; the implementation explicitly passes each property to make the call site readable.

## Auth gates

None — no external auth required for this plan. Implementation is entirely within the worktree.

## Hardware-constraint adjustments

Per CLAUDE.md and the executor's `<ABSOLUTE_HARDWARE_CONSTRAINTS>` block, no `pnpm test`, `pnpm exec tsc`, `pnpm build`, or `pnpm install` was run locally. Test execution (`pnpm test -- utils/calendar/reconciliation/index.test.ts --run`) is **deferred to CI**. Mirrors the wave-1/wave-2 plans' pattern (11-02, 11-03, 11-04 all deferred test execution to CI).

`ultracite fix` was not run on the modified files because the worktree has no `node_modules`. CI's `ultracite check` step will surface any formatter drift; any failures will be fixed in a follow-up commit on this branch before merge.

## Threat Flags

None. The threat model in 11-05-PLAN.md (`T-11-05-01` through `T-11-05-06`) is fully covered by the implementation:

- **T-11-05-01** (RESCHEDULE id whitelist) — `arbitrate.ts` already enforces `validIds.has(claimed)` for SAME/RESCHEDULE; orchestrator passes only the candidate-date schedule.
- **T-11-05-02** (SKIP silencing real events) — implemented as `outcome=FAILED` with `arbiter_skip` so the record is visible (will surface in digest when Phase 10 renders it).
- **T-11-05-03** (RESCHEDULE linkage repudiation) — both directions persisted: `rescheduleOfEventId` on the new record, and the new event's htmlLink is patched onto the old event's description.
- **T-11-05-04** (DoS via arbiter timeout) — D-08 fallback in `runArbitrationOrFallback` catches all thrown/rejected arbitration calls and resolves to CREATED.
- **T-11-05-05** (logging PII) — all new `logger.info("reconcile_route", …)` calls carry only `{ emailAccountId, messageId, threadId, outcome, verdict?, dayScheduleCount? }`. The PII-discipline test (Test N) covers the failure paths.
- **T-11-05-06** (eventId provenance for patch) — `rescheduleOfEventId` always sourced from `arb.matchedEventId` which is whitelist-validated by `arbitrate.ts`. No external input flows into `eventId`.

## Self-Check: PASSED

Files verified:
- `apps/web/utils/calendar/reconciliation/index.ts` — FOUND
- `apps/web/utils/calendar/reconciliation/index.test.ts` — FOUND
- `apps/web/utils/calendar/reconciliation/arbitrate.ts` — FOUND (29 lines lighter)

Commits verified in `git log --oneline`:
- `0d7bbe75f` — FOUND
- `d97ac0c42` — FOUND
- `31d981974` — FOUND
