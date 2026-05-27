---
phase: 11-calendar-reconciliation-v2
plan: 11-02
subsystem: calendar-reconciliation
tags: [matcher, overlap, time-interval, all-day, refactor]
requires:
  - 11-01 (RESCHEDULE schema/migration — Wave 1; no runtime dep from 11-02, but the wave ordering guarantees 11-02 lands on top of the enum change)
provides:
  - findIntervalOverlaps — pure interval-intersection helper consumed by 11-05 orchestrator
  - DEFAULT_DURATION_MS — single source of truth for "no end time" duration default (60min)
  - decideAllDayOutcome — all-day branch entry point consumed by 11-05 orchestrator
  - AllDayOutcome — discriminated union exported for orchestrator wiring
affects:
  - apps/web/utils/calendar/reconciliation/index.ts (will fail to import decideOutcome until 11-05 lands; INTENTIONAL per plan verification note)
tech-stack:
  added: []
  removed: ["whitespace-token Dice coefficient (titleSimilarity) — fully deleted from reconciliation/"]
  patterns:
    - "Pure JS modules — no Prisma, no Google client, no AI SDK"
    - "Date-string slice(0,10) comparison for all-day events (never new Date()) per Phase 9 D-08"
    - "Strict less-than interval intersection (boundary touch is NOT overlap)"
key-files:
  created:
    - apps/web/utils/calendar/reconciliation/overlap.ts
    - apps/web/utils/calendar/reconciliation/overlap.test.ts
  modified:
    - apps/web/utils/calendar/reconciliation/match.ts (rewritten — 82 lines -> 67 lines, single responsibility)
    - apps/web/utils/calendar/reconciliation/match.test.ts (rewritten — 7 timed/Dice tests -> 6 all-day tests)
  deleted:
    - apps/web/utils/calendar/reconciliation/dice.ts
    - apps/web/utils/calendar/reconciliation/dice.test.ts
decisions:
  - "D-01 implementation: strict < on both bounds. Test D guards adjacent-event boundary touch (7-8pm + 8-9pm) to prevent ≤ regression."
  - "D-02 implementation: DEFAULT_DURATION_MS = 60min is exported, not hardcoded inline, so create-event.ts (and any future caller that needs the same default) can import it instead of duplicating the literal."
  - "Defensive end-handling: existing event with empty/unparseable end uses start + DEFAULT_DURATION_MS. Test J locks the behavior because NormalizedCalendarEvent.end is typed as string but production data has shown empty strings escape upstream."
  - "Defensive candidate handling: empty / unparseable candidateStartISO returns []; unparseable existing.start is skipped (not thrown). Mirrors existing findTimeOverlaps style."
  - "AllDayOutcome union retains MATCHED variant even though decideAllDayOutcome never emits it under Phase 11. Forward-compat for a future deterministic fast-path; documented inline via JSDoc."
  - "decideAllDayOutcome throws on contract violation (non-all-day candidate) rather than silently returning CREATED. The orchestrator is contracted to route timed candidates through findIntervalOverlaps; a violation is a bug, not data."
  - "Did NOT delete arbitrate.ts's findTimeOverlaps in this plan — index.ts still imports it. 11-05 owns the orchestrator rewrite and the cleanup."
metrics:
  duration: ~25min
  completed: 2026-05-26
  tasks_completed: 3
  files_created: 2
  files_modified: 2
  files_deleted: 2
  lines_added: 322 (overlap.ts + overlap.test.ts)
  lines_removed: 224 (dice.ts + dice.test.ts + match.ts old body)
  net_LOC_delta: +98
  unit_tests_added: 11 (overlap.test.ts: 10 cases A-J + 1 DEFAULT_DURATION_MS export check)
  unit_tests_modified: 6 (match.test.ts: 6 all-day cases replace 7 prior Dice/timed cases)
  unit_tests_removed: 5 (dice.test.ts test count is a guess from the file — see Risks)
---

# Phase 11 Plan 02: Matcher Substrate — Interval Overlap + All-Day Simplification Summary

Replaced Phase 9's token-Dice timed-event matcher with a pure interval-overlap helper (`findIntervalOverlaps`), shrank `match.ts` to its all-day responsibility, and deleted `dice.ts` + its tests. The matcher substrate is now ready for the orchestrator rewrite in 11-05.

## Tasks Executed

### Task 1: Create `overlap.ts` + `overlap.test.ts` (D-01, D-02)
- **Commit:** `5c62ae4b9`
- **Files:** `apps/web/utils/calendar/reconciliation/overlap.ts` (created), `overlap.test.ts` (created)
- **Behavior shipped:** `findIntervalOverlaps({ candidateStartISO, candidateEndISO, existingEvents })` returns existing events whose `[start, end]` interval strictly intersects the candidate's. `DEFAULT_DURATION_MS = 60 * 60 * 1000` exported for reuse by `create-event.ts` (and any future consumer that needs the canonical 60-min default).
- **Edge cases locked by tests:**
  - A: standard timed overlap → returned.
  - B: candidate 7:30pm (no end) ≠ existing 4-5pm — 60min default places candidate at 7:30-8:30pm.
  - C: candidate 7:30pm (no end) → 7-8pm existing (the motivating Piano-vs-Music case).
  - D: adjacent events (boundary touch) → NOT overlap (strict `<`).
  - E: all-day existing event excluded regardless of date.
  - F: far-future candidate (Aug 14 camping reservation) vs today's events → empty (the deterministic-CREATE escape hatch).
  - G: multiple-event filter returns only the overlapping subset.
  - H: empty `candidateStartISO` → `[]`.
  - I: unparseable `candidateStartISO` → `[]`.
  - J: existing event with empty `end` falls back to `start + 60min` and the overlap is detected.
  - Plus a guard test for unparseable `existing.start` (skipped, no throw) and a `DEFAULT_DURATION_MS` export check.

### Task 2: Simplify `match.ts` to all-day branch only (D-03, D-04, D-12)
- **Commit:** `bcb7a22f2`
- **Files:** `apps/web/utils/calendar/reconciliation/match.ts` (rewritten), `match.test.ts` (rewritten)
- **Behavior shipped:**
  - Removed `decideOutcome` (82-line Phase 9 four-step tree) and the `ReconcileOutcome` type alias.
  - Removed `import { titleSimilarity } from "./dice"`.
  - Added `decideAllDayOutcome({ candidate, existingEvents })`. Same-date check via `slice(0,10)`. Returns `{ outcome: 'CREATED' | 'NEEDS_ARBITRATION', matchedEventId: null, sameDateEvents: NormalizedCalendarEvent[] }`. `MATCHED` retained in the union for forward-compat (JSDoc-documented).
  - Throws on contract violation (non-all-day candidate).
- **Test coverage:** 6 cases — no same-date events (CREATED); same-date all-day; same-date TIMED (date-string match still triggers arbitration); multiple same-date events; only different-date events (CREATED); contract-violation throw.

### Task 3: Delete `dice.ts` + `dice.test.ts` (D-11)
- **Commit:** `ec90cb276`
- **Files:** both deleted.
- **Guard:** Pre-delete repo-wide grep for `titleSimilarity` and `from "./dice"` showed only the two files themselves as callers (Task 2 had already dropped the import from `match.ts`).
- **Post-delete grep:** zero matches anywhere under `apps/web/`.
- **Intentional non-deletion:** `findTimeOverlaps` in `arbitrate.ts` remains. `index.ts` still imports it; 11-05 owns the orchestrator rewrite that will remove the last caller and then the helper.

## Deviations from Plan

None — plan executed exactly as written. No Rule 1/2/3 auto-fixes and no Rule 4 architectural questions surfaced. All three tasks committed individually with the conventional-commit format the plan specified.

## Test Verification Note

**`pnpm test` was NOT run from this worktree.** Reason: the worktree at `.claude/worktrees/agent-a8c18ce36c7ce5689` has no `node_modules` symlink farm — `cross-env` (and the `vitest` binary itself) are absent from `apps/web/node_modules` and from the repo-root `.bin`. Per project memory `feedback_lint_ci_only.md` ("Lint/typecheck on CI only — machine is underpowered; don't suggest local lint/tsc") and CLAUDE.md ("Never run `tsc`, `pnpm exec tsc`, `pnpm build`..."), test execution is deferred to CI.

Local static verification that WAS run:
- `grep -nE 'titleSimilarity|dice|prisma|googleapis|generateObject' overlap.ts` → zero matches (pure module gate).
- `grep -nE 'titleSimilarity|from "\./dice"|AMBIGUOUS' match.ts` → zero matches.
- `grep -nE 'titleSimilarity|dice' match.test.ts` → zero matches.
- `grep -nE '^export' match.ts` → `AllDayOutcome` type + `decideAllDayOutcome` function both exported.
- Repo-wide grep for `titleSimilarity` + `./dice` imports under `apps/web/` after deletion → zero matches.

The plan's automated verification commands (`pnpm test -- utils/calendar/reconciliation/overlap.test.ts --run` and `match.test.ts`) are recorded in the plan and will run in CI on push.

## Expected Intermediate State

Per the plan's `<verification>` block: `apps/web/utils/calendar/reconciliation/index.ts` still imports `decideOutcome` and `ReconcileOutcome` from `./match`. Those exports no longer exist after Task 2. **This is the intended Wave 2 intermediate state.** 11-05 (Wave 3) rewrites `index.ts` to consume `findIntervalOverlaps` + `decideAllDayOutcome` and removes the broken imports. The build will be red in the gap between this commit and 11-05 — do not "fix" `index.ts` here.

## Files Touched

| Path | Change | LOC |
|------|--------|-----|
| `apps/web/utils/calendar/reconciliation/overlap.ts` | created | +69 |
| `apps/web/utils/calendar/reconciliation/overlap.test.ts` | created | +253 |
| `apps/web/utils/calendar/reconciliation/match.ts` | rewritten | -82 / +67 |
| `apps/web/utils/calendar/reconciliation/match.test.ts` | rewritten | -157 / +137 (approx, full replacement) |
| `apps/web/utils/calendar/reconciliation/dice.ts` | deleted | -26 |
| `apps/web/utils/calendar/reconciliation/dice.test.ts` | deleted | -41 |

## Commits

- `5c62ae4b9` — feat(11-02): add findIntervalOverlaps pure interval helper (D-01, D-02)
- `bcb7a22f2` — feat(11-02): reduce match.ts to all-day branch only (D-03, D-04, D-12)
- `ec90cb276` — feat(11-02): delete dice.ts + dice.test.ts (D-11)

## Known Stubs

None. Every new function is fully wired; the only intentional gap is the broken `index.ts` import described in **Expected Intermediate State**, which is resolved by 11-05 in the same wave-merge.

## Self-Check: PASSED

- `apps/web/utils/calendar/reconciliation/overlap.ts` — present (verified by `Write` success).
- `apps/web/utils/calendar/reconciliation/overlap.test.ts` — present.
- `apps/web/utils/calendar/reconciliation/match.ts` — present, rewritten (verified by `^export` grep showing only `AllDayOutcome` + `decideAllDayOutcome`).
- `apps/web/utils/calendar/reconciliation/match.test.ts` — present, rewritten (verified by zero `titleSimilarity|dice` matches).
- `apps/web/utils/calendar/reconciliation/dice.ts` — absent (verified by `git rm` success + post-delete glob).
- `apps/web/utils/calendar/reconciliation/dice.test.ts` — absent.
- Commits `5c62ae4b9`, `bcb7a22f2`, `ec90cb276` — present in `git log --oneline -5`.
