---
phase: 08-calendar-sync-foundation
plan: 01
subsystem: calendar
tags: [calendar, normalization, types, tdd]
dependency_graph:
  requires: []
  provides:
    - "NormalizedCalendarEvent type for Phase 9/10 consumers"
    - "CalendarCacheEnvelope envelope shape for Plan 02 Redis cache"
    - "isExcluded / normalize / pastPrune pure helpers for Plan 02"
  affects:
    - "Plan 02 (cache + read path) imports all three helpers and the envelope type"
    - "Plan 03 (integration) consumes NormalizedCalendarEvent shape"
tech-stack:
  added: []
  patterns:
    - "Pure-function helpers (no I/O) tested in isolation with vitest fixtures"
    - "All-day vs. timed event distinction preserved as a string-vs-RFC3339 contract"
key-files:
  created:
    - apps/web/utils/calendar/upcoming-events-types.ts
    - apps/web/utils/calendar/upcoming-events-helpers.ts
    - apps/web/utils/calendar/upcoming-events-helpers.test.ts
  modified: []
decisions:
  - "pastPrune boundary: predicate is end < now (event ending exactly at now is KEPT). Lockstep tested."
  - "All-day pastPrune compares against now.toISOString().slice(0,10) (UTC date). Acceptable for v1.1 single-user; if reconciliation surfaces an edge-case midnight bug, tighten in Plan 02."
  - "normalize filters attendees by typeof === 'string' && length > 0 (drops null/undefined/empty)."
metrics:
  duration: "~25 min"
  completed: "2026-05-22"
  task_count: 3
  file_count: 3
  test_count: 23
requirements: [CAL-01, CAL-02]
---

# Phase 8 Plan 01: Calendar Helper Types and Pure Functions Summary

Established the Phase 8/9/10 normalized calendar event contract (`NormalizedCalendarEvent`) and shipped three pure helpers — `isExcluded`, `normalize`, `pastPrune` — with 23 vitest cases locking the responseStatus/self-attendee filter and the all-day-as-string preservation rule.

## What Was Built

| File | Purpose |
| --- | --- |
| `apps/web/utils/calendar/upcoming-events-types.ts` | `NormalizedCalendarEvent` (D-02) + `CalendarCacheEnvelope` (D-09) interfaces. Zero imports — pure type definitions. |
| `apps/web/utils/calendar/upcoming-events-helpers.ts` | `isExcluded(event)`, `normalize(event)`, `pastPrune(events, now)` — all pure, side-effect-free, importable by Plan 02. |
| `apps/web/utils/calendar/upcoming-events-helpers.test.ts` | 23 vitest `it()` blocks across three `describe()` groups; full branch coverage. |

## Commits

| Commit | Type | Description |
| --- | --- | --- |
| `667e50c52` | feat | Add `NormalizedCalendarEvent` + `CalendarCacheEnvelope` types |
| `ae373d5e0` | test | Add failing tests for `isExcluded`, `normalize`, `pastPrune` (RED) |
| `3fcd0458f` | feat | Implement helpers; all 23 tests pass (GREEN) |

## Behaviors Locked by Tests

**isExcluded (8 cases):**
- `self responseStatus === 'declined'` → excluded
- `self responseStatus === 'tentative'` → excluded
- `self responseStatus === 'accepted' | 'needsAction'` → kept
- No self attendee row (owner-created, empty array, or undefined) → kept
- Other attendee declined while self accepted → kept (only self matters)

**normalize (8 cases):**
- Timed event → RFC3339 strings preserved, `isAllDay: false`
- All-day event → `YYYY-MM-DD` strings preserved (never wrapped in `Date`), `isAllDay: true`
- Missing `summary` → `title: 'Untitled'`
- Missing `location` / `description` → `null` (not `undefined`)
- Missing `htmlLink` → `''`
- Attendees with null/undefined/missing email → filtered out

**pastPrune (7 cases):**
- Timed end < now → dropped
- Timed end ≥ now → kept (boundary `end === now` is KEPT, predicate is `endMs < nowMs` for drop)
- All-day end-date < today's UTC date string → dropped
- All-day end-date ≥ today's UTC date string → kept
- Mixed event sets prune correctly

## Test Run

```
Test Files  1 passed (1)
     Tests  23 passed (23)
  Duration  2.64s
```

## Deviations from Plan

None — plan executed exactly as written. The plan's boundary-rule guidance offered two options; chose **"end === now → KEPT"** (predicate is `end < now` for drop) and the test was authored to match. This is documented in the decisions frontmatter.

## Key Decisions

- **Predicate `end < now` for pastPrune drop** — events ending exactly at the current instant are still surfaced; tests lock this.
- **All-day comparison uses UTC date string** — `now.toISOString().slice(0,10)`. For the single-user v1.1 use case this is acceptable. If Plan 02 reconciliation testing surfaces a midnight-boundary bug (e.g. event marked "today" in user's local TZ but already past in UTC), tighten with `date-fns-tz`. Captured as a deferred refinement for Plan 02.
- **Email filter on attendees** — `typeof e === 'string' && e.length > 0` (rather than truthy check) to be explicit about dropping empty strings if Google ever returns them.

## Self-Check: PASSED

- File `apps/web/utils/calendar/upcoming-events-types.ts` FOUND
- File `apps/web/utils/calendar/upcoming-events-helpers.ts` FOUND
- File `apps/web/utils/calendar/upcoming-events-helpers.test.ts` FOUND
- Commit `667e50c52` FOUND
- Commit `ae373d5e0` FOUND
- Commit `3fcd0458f` FOUND
- All 23 vitest cases pass (verified locally)
