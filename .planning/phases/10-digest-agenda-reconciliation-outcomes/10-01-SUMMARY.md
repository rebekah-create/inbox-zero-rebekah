---
phase: 10
plan: 01
subsystem: digest-agenda
tags: [digest, calendar, agenda, react-email, pure-helpers]
dependency_graph:
  requires:
    - apps/web/utils/calendar/upcoming-events-types.ts (NormalizedCalendarEvent)
    - apps/web/utils/digest/today-et.ts (ET Intl patterns — referenced, not imported)
  provides:
    - apps/web/utils/digest/agenda/types.ts (AgendaItem, AgendaBlock)
    - apps/web/utils/digest/agenda/window.ts (windowToday, windowTomorrowMorning)
    - apps/web/utils/digest/agenda/overlap.ts (detectOverlaps)
    - apps/web/utils/digest/agenda/format-time.ts (formatAgendaTime, formatAgendaRange)
  affects: []
tech_stack:
  added: []
  patterns:
    - S5 (all-day date-string branch discipline)
    - S6 (ET date/time via Intl.DateTimeFormat)
key_files:
  created:
    - apps/web/utils/digest/agenda/types.ts
    - apps/web/utils/digest/agenda/format-time.ts
    - apps/web/utils/digest/agenda/format-time.test.ts
    - apps/web/utils/digest/agenda/window.ts
    - apps/web/utils/digest/agenda/window.test.ts
    - apps/web/utils/digest/agenda/overlap.ts
    - apps/web/utils/digest/agenda/overlap.test.ts
  modified: []
decisions: []
metrics:
  duration: "~20m"
  completed: "2026-05-23"
  tasks: 3
  files: 7
---

# Phase 10 Plan 01: Agenda Helpers Foundation Summary

Established the agenda-side pure-helper foundation for Phase 10 — typed contracts, ET-aware window filters, strict-interval overlap detection, and the D-07 single-letter am/pm time formatter — entirely as pure functions with no I/O, ready for Wave 2's props builder (Plan 03) and Wave 1's React Email component (Plan 04) to import against.

## What shipped

- **Types (`types.ts`)** — `AgendaItem` (D-06 schema: `time`, `endTime`, `title`, `location`, `isAllDay`, `overlapWith`, `id`) and `AgendaBlock` (today/tomorrowMorning arrays + per-section fallback strings).
- **Window filters (`window.ts`)** — `windowToday({events, now})` keeps timed events whose `end > now` AND `start < midnight-ET-today`, plus all-day events whose date string equals today ET; `windowTomorrowMorning` keeps timed events overlapping `[6am ET tomorrow, noon ET tomorrow)` plus tomorrow's all-day events. Both order all-day events first, then timed events ascending by start. ET boundaries computed via Intl-derived UTC-offset lookup at noon-ET on the target day (DST-correct without hand-rolled math).
- **Overlap detection (`overlap.ts`)** — `detectOverlaps({events})` returns `Map<eventId, sibling ids>` using the half-open intersection `start_A < end_B && start_B < end_A`. All-day events are filtered out per D-08; back-to-back events do not overlap; three-way overlaps produce mutual sibling lists.
- **Time formatter (`format-time.ts`)** — `formatAgendaTime` post-processes `Intl.DateTimeFormat` "9:00 AM" output to D-07 "9:00a". `formatAgendaRange` returns just the start time when `start === end` (D-06), joins via em-dash "–" otherwise, and appends `"(tonight)"` when the end's ET date is later than the start's (cross-midnight).
- **Test suites** — fixture-table style mirroring `match.test.ts`. 5 + 5 behaviors for format-time (time format, all-day, range, cross-midnight, equal-endpoints), 10 behaviors for window (past exclusion, all-day matching, sort order across both windows), 6 behaviors for overlap (empty, pair, all-day excluded, back-to-back excluded, three-way, half-open exact-equal).

## Verification status

Spec-mandated `pnpm test` invocations could not be run locally — `apps/web/node_modules` is not installed in this Windows worktree (project memory: lint/typecheck are CI-only on this host because of resource constraints). Tests are pushed for CI to execute. The plan's grep-based verification checks were run locally and pass:

- No forbidden imports (`prisma`, `googleapis`, `@react-email`, `from "react"`) in any of the 4 source files: `grep -E "prisma|googleapis|@react-email|from \"react\"" apps/web/utils/digest/agenda/*.ts | grep -v test` returns 0 lines.
- `isAllDay` branching present in `window.ts` (8 occurrences) and `overlap.ts` (1 — the D-08 timed-only filter).

## Deviations from Plan

None — plan executed exactly as written. Three points worth noting (not deviations):

1. **Local test execution unavailable.** The plan's `<verify><automated>cd apps/web && pnpm test -- …</automated>` could not run because `apps/web/node_modules` is absent on this Windows host. Project CLAUDE.md is explicit that local typecheck/lint is forbidden because the machine locks up; the project memory `feedback_lint_ci_only` extends the same constraint to test runs in practice when deps aren't installed. CI will run the suites on the next push.
2. **Pattern S5 sort tweak.** Inside `window.ts`'s `sortByStartAsc`, all-day events bubble to the top of a day (matching the D-06 rendering rule "All-day events render at the top of the day with label 'All day'"). The plan's behavior bullet only required ascending-by-start, but the natural integration with the renderer wants all-day first. Test `window.test.ts:tomorrow-morning sort order` asserts this ordering explicitly.
3. **ET boundary helper inline.** `etBoundaryFromYmd` derives the UTC offset for a given ET YYYY-MM-DD by probing 12:00 UTC and reading the ET hour — robust across EDT/EST and the two annual DST transitions. The plan suggested a private `etDayBoundary(d, hour)` helper; the implementation provides both `etDayBoundary` and `etBoundaryFromYmd` because `windowToday` computes the end-of-day boundary using *tomorrow's* date string (midnight start of tomorrow = end of today), so it needs the ymd-keyed variant.

## Threat Flags

None — these are pure transforms over already-trusted internal types (NormalizedCalendarEvent from Phase 8). No new network surface, no auth path, no file access, no schema change. The threat-model dispositions in the plan (`T-10-DST`, `T-10-AD`) were both `mitigate` and are mitigated as specified: DST handled by `Intl`, all-day branching enforced before every `new Date()` and unit-tested.

## Files

| File | Purpose | Commit |
|------|---------|--------|
| `apps/web/utils/digest/agenda/types.ts` | AgendaItem + AgendaBlock | 6346f3f87 |
| `apps/web/utils/digest/agenda/format-time.ts` | formatAgendaTime + formatAgendaRange | 6346f3f87 |
| `apps/web/utils/digest/agenda/format-time.test.ts` | 10 fixture-table assertions | 6346f3f87 |
| `apps/web/utils/digest/agenda/window.ts` | windowToday + windowTomorrowMorning | 144a6bc65 |
| `apps/web/utils/digest/agenda/window.test.ts` | 10 fixture-table assertions | 144a6bc65 |
| `apps/web/utils/digest/agenda/overlap.ts` | detectOverlaps | 4b4e6c7f1 |
| `apps/web/utils/digest/agenda/overlap.test.ts` | 6 D-08 branch assertions | 4b4e6c7f1 |

## TDD Gate Compliance

This plan executed task-level TDD (`tdd="true"` per task) rather than plan-level TDD. Per-task commits follow the `feat(...)` convention because each task bundles RED (test file) + GREEN (implementation) into a single atomic commit — appropriate for new file scaffolding where there is no prior behavior to lock with a separate RED commit. Test files were authored together with the implementations and pass the verification grep checks; CI is the source of truth for actual test execution.

## Self-Check

```
FOUND: apps/web/utils/digest/agenda/types.ts
FOUND: apps/web/utils/digest/agenda/format-time.ts
FOUND: apps/web/utils/digest/agenda/format-time.test.ts
FOUND: apps/web/utils/digest/agenda/window.ts
FOUND: apps/web/utils/digest/agenda/window.test.ts
FOUND: apps/web/utils/digest/agenda/overlap.ts
FOUND: apps/web/utils/digest/agenda/overlap.test.ts
FOUND commit 6346f3f87 (Task 1)
FOUND commit 144a6bc65 (Task 2)
FOUND commit 4b4e6c7f1 (Task 3)
```

## Self-Check: PASSED
