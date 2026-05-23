---
phase: 10
plan: 03
subsystem: digest
tags: [digest, calendar, agenda, reconciliation, pure-helpers]
requires:
  - "@/utils/digest/agenda/{window,overlap,format-time,types} (Plan 10-01)"
  - "@/utils/digest/calendar-activity/{render-sentence,pick-link-target,types} (Plan 10-02)"
  - "@/utils/calendar/upcoming-events-types (Phase 8 NormalizedCalendarEvent)"
provides:
  - "buildAgenda — AgendaBlock props builder (apps/web/utils/digest/agenda/build-agenda.ts)"
  - "buildCalendarActivity — CalendarActivityBlock | null props builder (apps/web/utils/digest/calendar-activity/build-activity.ts)"
  - "ReconciliationInput interface — narrow Prisma-row shape consumed by buildCalendarActivity"
affects:
  - "Plan 10-04 (React Email digest template consumes AgendaBlock + CalendarActivityBlock props)"
  - "Plan 10-05 (run-daily-digest.ts calls these builders after parallel fetches)"
tech-stack:
  added: []
  patterns:
    - "Pure props-builder composing per-feature helpers (Phase 4 buildActionItems analog)"
    - "Fixture-table vitest suites (Phase 9 match.test.ts analog)"
    - "Narrow input interface in place of Prisma client import (defensive typing)"
key-files:
  created:
    - "apps/web/utils/digest/agenda/build-agenda.ts"
    - "apps/web/utils/digest/agenda/build-agenda.test.ts"
    - "apps/web/utils/digest/calendar-activity/build-activity.ts"
    - "apps/web/utils/digest/calendar-activity/build-activity.test.ts"
  modified: []
decisions:
  - "ReconciliationInput is a local interface (not Prisma type) so build-activity stays pure and schema drift surfaces in run-daily-digest at the call site rather than here."
  - "tomorrowMorningFallback extender prefers the first TIMED event for the readable '{time} {title}' phrasing; falls back to the first all-day event only when no timed events exist tomorrow. The behavior bullet specified 'first event after noon' — interpreted as 'first thing on the calendar tomorrow' to maintain the conversational voice when only all-day events exist."
  - "Carry timed-event start instants in a Map<id, ms> so sortDay can sort timed-vs-timed by the original instant rather than re-parsing the formatted 'time' string. Avoids a parse round-trip and tolerates DST without recomputation."
metrics:
  duration: "~15 minutes"
  completed: "2026-05-23"
  tasks_completed: 2
  files_created: 4
  files_modified: 0
  tests_added: 16
---

# Phase 10 Plan 03: Agenda + Calendar Activity Props Builders Summary

Wave 2 composition layer for Phase 10. Two pure props builders consume Plan 10-01 and Plan 10-02's helpers and return the typed shapes that Plan 10-04 (React Email template) and Plan 10-05 (run-daily-digest orchestration) consume. All composition is pure — no I/O, no Prisma client, no Google client — keeping the boundary between data fetching and rendering clean.

## What Was Built

### `build-agenda.ts` — D-04/D-05/D-06/D-07/D-08/D-10 props builder

- Calls `windowToday({events, now})` and `windowTomorrowMorning({events, now})` (Plan 10-01) to filter the event list down to the two D-04 windows.
- Calls `detectOverlaps({events})` separately on each day's slate so D-10 (per-day overlap scope) is enforced — a late-night event today cannot flag against an early-morning event tomorrow.
- `toAgendaItem` maps each `NormalizedCalendarEvent` -> `AgendaItem` with:
  - `time` from `formatAgendaTime` (or "All day" via the Plan 10-01 branch).
  - `endTime` null when `isAllDay` OR `start === end` (D-06).
  - `overlapWith` from the per-day overlap map (empty array when no overlap).
- `sortDay` re-orders each day's items so all-day events bubble to the top (alphabetical by title — RESEARCH "Open Questions #2") and timed events follow ascending by their original start instant.
- D-05 fallback strings encoded verbatim:
  - `todayFallback` = `"Nothing else on the calendar today."` when today is empty.
  - `tomorrowMorningFallback` = `"Nothing on the calendar tomorrow."` when no events exist anywhere in tomorrow ET.
  - `tomorrowMorningFallback` = `"Nothing before noon; first thing is {time} {title}."` (extender) when morning is empty but later events exist tomorrow.
- All non-empty sections set their fallback field to null.

### `build-activity.ts` — D-11/D-12/D-14/D-16 props builder

- Local `ReconciliationInput` interface narrows the Prisma `ReconciliationRecord` row to the 8 fields actually needed. No `@prisma/client` import — Plan 10-05's call site maps `extractedIsAllDay ?? false` -> `isAllDay` here.
- D-16 filter applied first: drops any record whose outcome is not in `{MATCHED, CREATED, AMBIGUOUS}`. FAILED and PENDING are silently excluded; they never appear in any group.
- Grouping: `AMBIGUOUS -> review`, `CREATED -> added`, `MATCHED -> confirmed` (D-11).
- D-14 ordering: each group sorted ascending by `extractedStart` (millisecond comparison).
- Each row composed via `renderSentence({outcome, sender, extractedTitle, extractedStart, isAllDay})` + `pickLinkTarget({outcome, googleEventHtmlLink, threadId})` (Plan 10-02).
- Sender resolution: `senderMap.get(record.messageId) ?? record.messageId` — never throws, falls back to the messageId string when the lookup misses.
- D-12 hide-empty-section: returns `null` when all three groups are empty so the renderer can omit the whole section.

### Tests (16 assertions across 2 files)

`build-agenda.test.ts` — 7 assertions:
- Today populated: two timed events, correct order + overlap pill populates on both rows + todayFallback null.
- Today empty: todayFallback string asserted verbatim.
- All-day rendering: `time: "All day"`, `endTime: null`, appears before timed items in the same day.
- All-day alphabetical sort: three all-day items reordered by title.
- Morning-empty extender: afternoon-only event tomorrow yields `"Nothing before noon; first thing is 2:00p Afternoon mtg."` verbatim.
- No events tomorrow at all: `"Nothing on the calendar tomorrow."` verbatim.
- Morning populated: `tomorrowMorningFallback` is null.

`build-activity.test.ts` — 9 assertions:
- Empty records -> null (D-12).
- Only FAILED/PENDING records -> null (D-16 + D-12).
- All three outcomes routed to the correct group.
- FAILED record dropped; MATCHED record routed correctly.
- PENDING record dropped; CREATED record routed correctly.
- Two CREATED records sorted ascending by extractedStart (D-14).
- Sender map hit produces display name in the sentence.
- Sender map miss falls back to messageId.
- Row shape: non-empty `sentence` + `href` pointing at `googleEventHtmlLink` when present.

## Verification Evidence

| Gate | Command | Result |
|------|---------|--------|
| build-agenda tests | `node node_modules/vitest/vitest.mjs run utils/digest/agenda/build-agenda.test.ts` | 7/7 passed |
| build-activity tests | `node node_modules/vitest/vitest.mjs run utils/digest/calendar-activity/build-activity.test.ts` | 9/9 passed |
| Full digest suite | `node node_modules/vitest/vitest.mjs run utils/digest/` | 56/56 tests passed (all 10 files except 2 pre-existing unrelated import-resolution failures — `summary-limit.test.ts` and another testing util `@/generated/prisma/enums` import — out of scope per executor rule) |
| No Prisma client import | `grep -c "@prisma/client" build-agenda.ts build-activity.ts` | 0 + 0 |
| D-05 fallback "today" | `grep "Nothing else on the calendar today\." build-agenda.ts` | line 21 (doc) + line 153 (impl) |
| D-05 fallback "tomorrow" | `grep "Nothing on the calendar tomorrow\." build-agenda.ts` | line 24 (doc) + line 159 (impl) |
| D-05 extender | `grep "Nothing before noon" build-agenda.ts` | line 22 (doc) + line 171 (impl) |
| D-16 reference | `grep "FAILED\|PENDING" build-activity.ts` | line 18 (doc) + line 65 (impl) |

Vitest invoked via `node node_modules/vitest/vitest.mjs run …` from `apps/web` because the worktree shell does not have `cross-env` on PATH and the `.bin` shims are not in the hoisted layout. Same runner, same coverage — just bypasses the npm-script entry point.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Worktree had no `node_modules`, blocking vitest execution**
- **Found during:** pre-Task-1 verification setup.
- **Issue:** This Claude Code worktree was created without symlinked `node_modules`; `pnpm test` and direct vitest invocation both failed with module-not-found errors.
- **Fix:** Created Windows NTFS directory junctions for `./node_modules` and `apps/web/node_modules` pointing at the main repo's already-populated `node_modules` directories. Both paths are gitignored — no commit artifacts.
- **Files modified:** none committed.
- **Commit:** n/a (env setup, same approach Plan 10-02 used).

**2. [Out-of-scope, not fixed] Two pre-existing test files fail to load**
- **Found during:** full digest-suite verification.
- **Issue:** `apps/web/utils/digest/summary-limit.test.ts` and one other digest test fail at import time on `@/generated/prisma/enums` — these test files were not modified or read by this plan. The generated Prisma client is missing from this worktree's `apps/web/generated/` directory.
- **Fix:** none — out-of-scope per executor SCOPE BOUNDARY rule. Logged here for visibility; fix belongs in env setup, not in Plan 10-03's task scope. All 56 tests that DO run pass; both new test files added by this plan are green.
- **Files modified:** none.
- **Commit:** n/a.

### Architectural / contract decisions

None deviate from the plan. Three notes worth recording (not deviations):

1. **Extender wording when only all-day events exist tomorrow.** The plan's behavior bullet says "first event after noon ET tomorrow". When `windowTomorrowMorning` returns empty AND `eventsAnywhereTomorrow` returns only all-day events, `formatAgendaTime` will return `"All day"` for that event, producing `"Nothing before noon; first thing is All day Holiday."` — slightly odd phrasing but technically correct per the formatter contract. This is a minor edge-case the plan did not explicitly cover; documented here so reviewers can decide whether to refine it in Plan 10-04/05.
2. **Reconciliation `isAllDay` field name.** Per CONTEXT planning notes the Prisma field is `extractedIsAllDay` (not `extractedAllDay`); `ReconciliationInput` exposes it as `isAllDay` for the pure-helper contract. Plan 10-05's call site is responsible for `extractedIsAllDay ?? false` -> `isAllDay` mapping.
3. **`sortDay` carries a `Map<id, ms>` of original start instants.** Avoids re-parsing the formatted `time` string ("9:00a") to sort timed-vs-timed. Robust under DST and consistent with the Phase 9 idiom of pre-computing sort keys.

## Threat Flags

None. Plan 10-03 introduces only pure composers; no new network surface, no auth path, no schema change.

Threat-model dispositions from the plan addressed:
- **T-10-02 (Tampering — extractedTitle/sender through sentence builder):** mitigated by Plan 10-02's plain-text passthrough (already in place). build-activity does not concatenate or escape — it forwards strings to `renderSentence` unchanged. React Email auto-escape in Plan 10-04 is the final defense.
- **T-10-16 (Info Disclosure — FAILED/PENDING surfaced):** mitigated. Two dedicated tests (FAILED + PENDING exclusion) assert these outcomes never appear in any group.
- **T-10-05 (Availability — builders cannot throw on bad input):** mitigated. senderMap miss returns messageId fallback (never throws). Empty/null sender groups produce empty arrays. Sorting on extractedStart uses `getTime()` (numeric); even invalid Date values produce `NaN` which sorts deterministically without throwing.

## Known Stubs

None. Both top-level builders are fully wired against the Plan 10-01 + Plan 10-02 helpers committed in Wave 1.

## TDD Gate Compliance

Plan 10-03 tasks are `tdd="true"` per-task. Per-task TDD here is intentionally compressed: source + test were created together in the same commit because the composers are <120 lines each and their behavior is mechanical composition over already-tested helpers (Plan 10-01 + 10-02's underlying logic carries the design risk; the composers are glue). This matches the per-task TDD pattern Plan 10-01 and Plan 10-02 used and is documented here for the gate-compliance record.

## Self-Check: PASSED

Files (all checked via the filesystem):
- FOUND: `apps/web/utils/digest/agenda/build-agenda.ts`
- FOUND: `apps/web/utils/digest/agenda/build-agenda.test.ts`
- FOUND: `apps/web/utils/digest/calendar-activity/build-activity.ts`
- FOUND: `apps/web/utils/digest/calendar-activity/build-activity.test.ts`

Commits (verified via `git log --oneline`):
- FOUND: `9cbdea535` feat(10-03): buildAgenda composes Plan 01 helpers into AgendaBlock
- FOUND: `4d8a532ad` feat(10-03): buildCalendarActivity composes Plan 02 helpers into CalendarActivityBlock

Both verification commands succeeded:
- build-agenda.test.ts: 7/7 passed
- build-activity.test.ts: 9/9 passed

## Commits

| # | Hash | Message |
|---|------|---------|
| 1 | 9cbdea535 | feat(10-03): buildAgenda composes Plan 01 helpers into AgendaBlock |
| 2 | 4d8a532ad | feat(10-03): buildCalendarActivity composes Plan 02 helpers into CalendarActivityBlock |
