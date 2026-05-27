---
phase: 11-calendar-reconciliation-v2
plan: 11-06
subsystem: calendar-reconciliation / eval-harness
tags: [reconciliation, eval, ai-tests, cost-projection]
requires: [11-02 (overlap.ts), 11-03 (arbitrate.ts four-outcome schema)]
provides:
  - "Arbitration eval corpus (5 fixtures + README) under apps/web/__tests__/fixtures/reconciliation/arbitration/"
  - "RUN_AI_TESTS-gated live arbitrate eval (arbitrate.ai.test.ts)"
  - "Extended cost-projection covering extract + arbitrate combined cost"
affects:
  - "Future Phase 11 regressions on Piano-vs-Math semantics — fixture 01 pins the correct behavior"
  - "Future cost-cap drift — cost-projection asserts <= \$0.01/msg + <= \$2/mo at pessimistic volume"
tech-stack:
  added: []
  patterns:
    - "describe.runIf(RUN_AI_TESTS) gate copied verbatim from extract.ai.test.ts"
    - "saveAiUsage vi.spyOn pattern reused from cost-projection.test.ts extract block"
    - "findIntervalOverlaps pre-check as the validation gate for shouldCallArbiter: false fixtures"
key-files:
  created:
    - apps/web/__tests__/fixtures/reconciliation/arbitration/01-music-class-collision.json
    - apps/web/__tests__/fixtures/reconciliation/arbitration/02-math-vs-piano-disambiguation.json
    - apps/web/__tests__/fixtures/reconciliation/arbitration/03-camping-future-date.json
    - apps/web/__tests__/fixtures/reconciliation/arbitration/04-true-reschedule.json
    - apps/web/__tests__/fixtures/reconciliation/arbitration/05-marketing-skip.json
    - apps/web/__tests__/fixtures/reconciliation/arbitration/README.md
    - apps/web/utils/calendar/reconciliation/arbitrate.ai.test.ts
  modified:
    - apps/web/utils/calendar/reconciliation/cost-projection.test.ts
decisions:
  - "Fixture format extends the labeled/ shape with daySchedule + expectedArbitration blocks (per plan interfaces)"
  - "shouldCallArbiter: false fixtures (02 + 03) validated via the pure findIntervalOverlaps pre-check, NOT via live arbiter calls — keeps RUN_AI_TESTS cost at ~\$0.01/run"
  - "Cost-projection per-message ceiling = max-extract + max-arbitrate (worst case both fire on same message); monthly = avgExtract * 200 + avgArbitrate * 200 * 0.3 (30% arbitration rate)"
  - "Fixture 04 (RESCHEDULE) models the OLD event on the same calendar day as the NEW candidate so the overlap pre-check fires — simplifies the eval harness while preserving the body-wording-driven RESCHEDULE signal"
metrics:
  duration: "single session"
  tasks_completed: 3
  files_created: 7
  files_modified: 1
  test_runs: 0  # hardware constraint — runners forbidden locally
  completed_date: "2026-05-26"
---

# Phase 11 Plan 06: Eval-corpus extension + cost-projection harness Summary

One-liner: Extend the Phase 9 reconciliation eval corpus with 5 Phase 11
arbitration fixtures (music-class collision, math/piano disambig, camping
future-date, true RESCHEDULE, marketing SKIP), add a RUN_AI_TESTS-gated
live arbiter eval, and extend cost-projection.test.ts to cover the
combined extract + arbitrate per-message and monthly ceilings.

## What shipped

### Task 1 — 5 arbitration fixtures + README (commit `92af8d0a1`)

Five JSON fixtures under
`apps/web/__tests__/fixtures/reconciliation/arbitration/`:

| # | Slug | shouldCallArbiter | Expected verdict | Purpose |
|---|------|-------------------|------------------|---------|
| 01 | music-class-collision | true | SAME | Regression pin for the 2026-05-26 Piano-vs-Math AMBIGUOUS incident |
| 02 | math-vs-piano-disambiguation | false | n/a | Validates 11-02 substrate dodges the false-positive without burning Haiku |
| 03 | camping-future-date | false | n/a | >14-day-out CREATE path (no overlap) |
| 04 | true-reschedule | true | RESCHEDULE | Body-wording-driven RESCHEDULE verdict |
| 05 | marketing-skip | true | SKIP | Keyword-backstop false positive safety valve |

README documents the schema, the difference between `labeled/` and
`arbitration/` corpora, how `shouldCallArbiter: false` cases are
validated (overlap pre-check, not live API call), and the RUN_AI_TESTS
gate semantics. All 5 fixtures validated as JSON via Node.

### Task 2 — `arbitrate.ai.test.ts` (commit `02c83f211`)

RUN_AI_TESTS-gated live eval. For each fixture:

1. Pure `findIntervalOverlaps` pre-check (validates 11-02 substrate).
   `shouldCallArbiter: false` fixtures short-circuit here — overlaps
   must equal `[]`, no live API call.
2. Live `arbitrateOverlap` call. Asserts `result.verdict ===
   expected.verdict` and (for SAME / RESCHEDULE) `result.matchedEventId
   === <whitelisted day-schedule id>`.

Default `pnpm test` (no RUN_AI_TESTS) runs zero tests from this file via
`describe.runIf(RUN)`. Per-run cost: ~$0.01 across the 3 fixtures that
actually invoke Haiku. File header JSDoc documents the manual run
command and cost estimate.

### Task 3 — extended cost-projection (commit `cd6204b06`)

Added a second `describe.runIf(RUN)` block to
`cost-projection.test.ts`. Existing extract block preserved
byte-identical (extract assertion against `COST_BUDGET_PER_MONTH=1.0`
unchanged at lines 174–175).

New arbitration block:

1. Pass A: re-run the labeled corpus through `extractCandidateEvent`,
   capture per-call cost from `saveAiUsage` spy.
2. Pass B: run the 3 callable arbitration fixtures through
   `arbitrateOverlap`, capture per-call cost.
3. Compute:
   - `worstCasePerMessageCost = maxExtract + maxArbitrate`
   - `projectedMonthlyCost = avgExtract * 200 + avgArbitrate * 200 * 0.30`
     (PESSIMISTIC_VOLUME × ARBITRATION_RATE)
4. Assertions:
   - `worstCasePerMessageCost <= 0.01` (`PER_MESSAGE_COST_CEILING`)
   - `projectedMonthlyCost <= 2.00` (`COMBINED_MONTHLY_BUDGET`)

Pricing constants pulled from the existing top-of-file source of truth
(Haiku 4.5 snapshot 2026-05-22). No second pricing constant introduced.

## Hardware-constraint deviations

Per the executor prompt's `ABSOLUTE_HARDWARE_CONSTRAINTS`:

- **Did NOT run `pnpm test`, `vitest`, `pnpm exec tsc`, or any local
  test runner.** Plan acceptance criteria for Tasks 2 and 3 called for
  `pnpm test -- ... --run` to confirm the gate is active. Skipped as
  documented in the executor's hardware-constraint section — verification
  deferred to CI. The gate semantics (`describe.runIf(RUN)` with
  `RUN = process.env.RUN_AI_TESTS === "true"`) are copied verbatim from
  `extract.ai.test.ts`, which already runs green on CI without
  `RUN_AI_TESTS`.
- **Did NOT run `RUN_AI_TESTS=true` live evals.** Those cost real money
  and the executor's mandate is to ship the test files; the manual
  RUN_AI_TESTS=true validation is owned by the user when convenient.
- **Did NOT install / modify node_modules.** Used the existing
  `npx --no-install ultracite fix` to format the two test files (no
  install, just runs from the existing workspace install).

## Self-check

Static checks performed:

- All 5 JSON fixtures parse via `node -e "JSON.parse(...)"`.
- `grep` confirms `arbitrateOverlap` import + 1 call site in
  `cost-projection.test.ts` (and 1 in `arbitrate.ai.test.ts`).
- `grep` confirms `findIntervalOverlaps` import + call in
  `arbitrate.ai.test.ts` (overlap pre-check is in place).
- `grep` confirms `<= 0.01` and `<= 2.00` literal patterns appear next
  to the two new assertions (acceptance criterion 3 for Task 3).
- `grep` confirms `describe.runIf(RUN)` appears in both new test files.
- Existing extract assertions (`expect(projectedMonthly)... COST_BUDGET_PER_MONTH`
  and `expect(projectedPessimistic)... COST_BUDGET_PER_MONTH`) preserved
  at lines 174–175.
- Ultracite-formatted cleanly (1 file fixed — cosmetic spacing only).

Self-Check: PASSED

## Commits

| # | Hash | Message |
|---|------|---------|
| 1 | `92af8d0a1` | test(11-06): add 5 arbitration eval fixtures + README |
| 2 | `02c83f211` | test(11-06): add RUN_AI_TESTS-gated arbitrate.ai live eval |
| 3 | `cd6204b06` | test(11-06): extend cost-projection to cover extract + arbitrate |

## What lands at CI / next user touchpoint

- CI runs `pnpm test` (no `RUN_AI_TESTS`). All `describe.runIf(RUN)`
  blocks emit zero tests — should be a green no-op.
- User can manually run `RUN_AI_TESTS=true pnpm test-ai --
  utils/calendar/reconciliation/arbitrate.ai` to validate the 5
  fixtures against the live Haiku arbiter (~$0.01 spend).
- User can manually run `RUN_AI_TESTS=true pnpm test-ai --
  utils/calendar/reconciliation/cost-projection` to validate the cost
  ceilings empirically (~$0.05 + $0.01 ≈ $0.06 spend).
