---
phase: 08-calendar-sync-foundation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/web/utils/calendar/upcoming-events-types.ts
  - apps/web/utils/calendar/upcoming-events-helpers.ts
  - apps/web/utils/calendar/upcoming-events-helpers.test.ts
autonomous: true
requirements:
  - CAL-01
  - CAL-02
tags:
  - calendar
  - normalization

must_haves:
  truths:
    - "A NormalizedCalendarEvent type exists with the exact D-02 shape and is exported for downstream consumers"
    - "A pure isExcluded(event) function returns true only when the calendar owner (self attendee) responded declined or tentative"
    - "Owner-created events with empty/missing attendees array are NOT excluded"
    - "A pure normalize(event) function converts a calendar_v3.Schema$Event to NormalizedCalendarEvent, preserving the all-day distinction (YYYY-MM-DD string when isAllDay=true)"
    - "A pure pastPrune(events, now) function drops events whose end is before now (timed) or whose date is before today (all-day)"
    - "Vitest tests cover declined/tentative/owner-created/accepted/needsAction/all-day/past-event/timed branches and pass"
  artifacts:
    - path: "apps/web/utils/calendar/upcoming-events-types.ts"
      provides: "NormalizedCalendarEvent + Envelope type definitions"
      contains: "export type NormalizedCalendarEvent"
    - path: "apps/web/utils/calendar/upcoming-events-helpers.ts"
      provides: "isExcluded, normalize, pastPrune pure functions"
      exports: ["isExcluded", "normalize", "pastPrune"]
    - path: "apps/web/utils/calendar/upcoming-events-helpers.test.ts"
      provides: "Unit tests for all helper branches"
      contains: "describe"
  key_links:
    - from: "apps/web/utils/calendar/upcoming-events-helpers.ts"
      to: "apps/web/utils/calendar/upcoming-events-types.ts"
      via: "import type { NormalizedCalendarEvent }"
      pattern: "from \"./upcoming-events-types\""
---

<objective>
Establish the Phase 8 type contract (D-02 normalized event shape + cache envelope shape) and the three pure helper functions (isExcluded, normalize, pastPrune) that the cache module in Plan 02 will compose. All logic in this plan is side-effect free and unit-testable in isolation — no Redis, no Google API, no Postgres.

Purpose: De-risk the two pieces of net-new logic the research flagged (responseStatus filtering and all-day date-string preservation) by isolating them in pure functions with exhaustive test coverage before any I/O is layered on top.

Output: Two source files (types + helpers) and one test file. Plan 02 imports these directly.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md
@.planning/phases/08-calendar-sync-foundation/08-RESEARCH.md
@CLAUDE.md

<interfaces>
<!-- The upstream calendar_v3.Schema$Event shape this plan consumes. -->
<!-- From @googleapis/calendar — already in package.json. Executor should import the type, not redefine it. -->

```ts
import type { calendar_v3 } from "@googleapis/calendar";

// Relevant fields per Google Calendar v3 reference:
//   event.id?: string | null
//   event.summary?: string | null            (title)
//   event.description?: string | null
//   event.location?: string | null
//   event.htmlLink?: string | null
//   event.start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null
//   event.end?:   { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null
//   event.attendees?: Array<{ email?: string | null; self?: boolean | null; responseStatus?: string | null; displayName?: string | null }> | null
```

The D-02 normalized shape this plan defines (verbatim from CONTEXT.md):

```ts
export interface NormalizedCalendarEvent {
  id: string;
  title: string;
  // RFC3339 timestamp for timed events; "YYYY-MM-DD" string for all-day events.
  start: string;
  end: string;
  isAllDay: boolean;
  location: string | null;
  description: string | null;
  attendees: string[]; // email addresses only
  htmlLink: string;
}

// Cache envelope shape (D-09 stale-fallback requirement — see 08-RESEARCH.md Q3).
export interface CalendarCacheEnvelope {
  data: NormalizedCalendarEvent[];
  fetchedAt: number; // unix ms
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Define type contract for normalized events and cache envelope</name>
  <files>apps/web/utils/calendar/upcoming-events-types.ts</files>
  <read_first>
    - .planning/phases/08-calendar-sync-foundation/08-CONTEXT.md (D-02 shape — lines 36-42 area)
    - .planning/phases/08-calendar-sync-foundation/08-RESEARCH.md (Q2 all-day handling, Q3 envelope pattern)
    - apps/web/utils/calendar/event-types.ts (existing CalendarEvent type — confirm we are NOT modifying it, we are creating a parallel new type for Phase 8/9/10 only)
  </read_first>
  <behavior>
    - File exports `NormalizedCalendarEvent` interface with EXACTLY these fields and types: id (string), title (string), start (string), end (string), isAllDay (boolean), location (string | null), description (string | null), attendees (string[]), htmlLink (string).
    - File exports `CalendarCacheEnvelope` interface with exactly: data (NormalizedCalendarEvent[]), fetchedAt (number — unix ms).
    - JSDoc on `start`/`end` notes: "RFC3339 timestamp for timed events; 'YYYY-MM-DD' string when isAllDay is true. Never wrap in `new Date()` without branching on isAllDay — see 08-RESEARCH.md Pitfall 4."
    - JSDoc on `attendees` notes: "Email addresses only. Empty array if no attendees or the owner is the sole attendee."
    - File does NOT import from `@googleapis/calendar` — it is pure type definitions, no Google types leak.
  </behavior>
  <action>
    Create `apps/web/utils/calendar/upcoming-events-types.ts` per D-02. Include both `NormalizedCalendarEvent` and `CalendarCacheEnvelope` interfaces with the field set and JSDoc described in <behavior>. Do not import from any other module — these are leaf-level type definitions.
  </action>
  <verify>
    <automated>node -e "const m = require('fs').readFileSync('apps/web/utils/calendar/upcoming-events-types.ts','utf8'); for (const f of ['NormalizedCalendarEvent','CalendarCacheEnvelope','isAllDay','fetchedAt','htmlLink','attendees']) { if (!m.includes(f)) { console.error('MISSING:',f); process.exit(1);} } console.log('OK');"</automated>
  </verify>
  <acceptance_criteria>
    - File `apps/web/utils/calendar/upcoming-events-types.ts` exists
    - `grep -q "export interface NormalizedCalendarEvent" apps/web/utils/calendar/upcoming-events-types.ts`
    - `grep -q "export interface CalendarCacheEnvelope" apps/web/utils/calendar/upcoming-events-types.ts`
    - `grep -q "isAllDay" apps/web/utils/calendar/upcoming-events-types.ts`
    - `grep -q "fetchedAt" apps/web/utils/calendar/upcoming-events-types.ts`
    - File contains zero `import` statements (pure types only)
  </acceptance_criteria>
  <done>The Phase 8/9/10 contract is committed as type definitions; downstream code can import these names without seeing Google-specific shapes.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Write failing tests for isExcluded, normalize, pastPrune helpers</name>
  <files>apps/web/utils/calendar/upcoming-events-helpers.test.ts</files>
  <read_first>
    - .planning/phases/08-calendar-sync-foundation/08-RESEARCH.md (Q1 responseStatus rule, Q2 all-day handling, Pitfalls 1-4 and 6)
    - apps/web/utils/calendar/providers/google-events.ts (lines 97-128 — existing parseEvent for reference on dual-branch date handling)
    - apps/web/utils/calendar/upcoming-events-types.ts (created in Task 1)
    - apps/web/utils/calendar/event-provider.test.ts OR any apps/web/utils/calendar/*.test.ts (find existing vitest pattern in this folder before authoring — use Glob if none, then mirror project test style)
  </read_first>
  <behavior>
    Test suite covers each case below with a fixture built from `calendar_v3.Schema$Event`. Suite SHOULD FAIL when run before Task 3 implements the helpers (RED step).

    isExcluded:
    - Event with `attendees: [{ self: true, responseStatus: 'declined' }]` → returns true
    - Event with `attendees: [{ self: true, responseStatus: 'tentative' }]` → returns true
    - Event with `attendees: [{ self: true, responseStatus: 'accepted' }]` → returns false
    - Event with `attendees: [{ self: true, responseStatus: 'needsAction' }]` → returns false
    - Event with `attendees: [{ email: 'other@x.com', responseStatus: 'declined' }]` (no self row) → returns false
    - Event with `attendees: []` → returns false
    - Event with `attendees` undefined → returns false
    - Event with multiple attendees including one self=true accepted plus an other declined → returns false (only self matters)

    normalize:
    - Timed event (`start.dateTime: '2026-05-25T15:00:00-04:00'`, `end.dateTime: '2026-05-25T16:00:00-04:00'`) → `isAllDay: false`, `start` equals the RFC3339 string, `end` equals the RFC3339 string
    - All-day event (`start.date: '2026-05-25'`, `end.date: '2026-05-26'`, no dateTime) → `isAllDay: true`, `start === '2026-05-25'`, `end === '2026-05-26'` (string, NOT a Date)
    - Missing summary → title === 'Untitled'
    - Missing location → location === null (NOT undefined)
    - Missing description → description === null
    - Attendees with mixed valid/missing emails → only valid email strings in result; nulls filtered out
    - Missing htmlLink → htmlLink === ''

    pastPrune:
    - Given now = `new Date('2026-05-22T12:00:00-04:00')`:
      - Timed event ending at 2026-05-22T10:00:00-04:00 → DROPPED
      - Timed event ending at 2026-05-22T14:00:00-04:00 → KEPT
      - Timed event ending exactly at now → DROPPED (use `<` not `<=`, or `<=` — document choice; recommend KEPT if end > now-1ms to avoid edge race; pick one and write the test to match)
      - All-day event with `end: '2026-05-22'` (today is 5/22) → KEPT (all-day event "ends" at end-of-day calendar-local, NOT at midnight UTC; treat all-day as kept if end-date >= today-in-local-date)
      - All-day event with `end: '2026-05-21'` → DROPPED
  </behavior>
  <action>
    Create `apps/web/utils/calendar/upcoming-events-helpers.test.ts` with vitest. Use `import { describe, it, expect } from "vitest"`. Build minimal `calendar_v3.Schema$Event` fixtures inline (no shared fixture file yet — Plan 02 may extract one). Import `isExcluded`, `normalize`, `pastPrune` from `./upcoming-events-helpers` (which does not yet exist — this is the RED test step).

    For pastPrune, fix `now` via a test constant. Lock the equality-at-boundary rule explicitly: end strictly less than now → dropped; end equal to now → kept (i.e. predicate is `endMs < nowMs` for drop). Write the test to match. For all-day events, compare the end-date STRING against the YYYY-MM-DD of `now` in the system's local TZ using `now.toISOString().slice(0,10)` — drop if `end < todayString`.

    Author at least one test per bullet above (≈18 `it()` blocks). Group with `describe('isExcluded')`, `describe('normalize')`, `describe('pastPrune')`.
  </action>
  <verify>
    <automated>cd apps/web && pnpm test -- utils/calendar/upcoming-events-helpers.test.ts --run 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - File `apps/web/utils/calendar/upcoming-events-helpers.test.ts` exists
    - `grep -c "it(" apps/web/utils/calendar/upcoming-events-helpers.test.ts` returns at least 15
    - `grep -q "describe(.isExcluded" apps/web/utils/calendar/upcoming-events-helpers.test.ts`
    - `grep -q "describe(.normalize" apps/web/utils/calendar/upcoming-events-helpers.test.ts`
    - `grep -q "describe(.pastPrune" apps/web/utils/calendar/upcoming-events-helpers.test.ts`
    - `grep -q "self: true" apps/web/utils/calendar/upcoming-events-helpers.test.ts` (the self-attendee fixture is present)
    - `grep -q "isAllDay" apps/web/utils/calendar/upcoming-events-helpers.test.ts`
    - Running the suite before Task 3 fails with "Cannot find module './upcoming-events-helpers'" or "is not a function" (RED — expected at this step)
  </acceptance_criteria>
  <done>Failing test suite exists with full branch coverage of the three helpers; running it produces a deterministic RED state ready for Task 3 to turn GREEN.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Implement isExcluded, normalize, pastPrune to turn tests GREEN</name>
  <files>apps/web/utils/calendar/upcoming-events-helpers.ts</files>
  <read_first>
    - apps/web/utils/calendar/upcoming-events-types.ts (Task 1 — type contract)
    - apps/web/utils/calendar/upcoming-events-helpers.test.ts (Task 2 — locks behavior)
    - .planning/phases/08-calendar-sync-foundation/08-RESEARCH.md (Q1 code snippet lines 116-125, Q2 code snippet lines 135-150)
    - apps/web/utils/calendar/providers/google-events.ts lines 97-128 (analog — but note this plan does NOT layer on it; we extract the dual-branch logic but preserve the all-day distinction)
  </read_first>
  <behavior>
    Three exported pure functions:

    ```ts
    import type { calendar_v3 } from "@googleapis/calendar";
    import type { NormalizedCalendarEvent } from "./upcoming-events-types";

    export function isExcluded(event: calendar_v3.Schema$Event): boolean;
    export function normalize(event: calendar_v3.Schema$Event): NormalizedCalendarEvent;
    export function pastPrune(events: NormalizedCalendarEvent[], now: Date): NormalizedCalendarEvent[];
    ```

    isExcluded: find the attendee where `a.self === true`. If none exists, return false. Otherwise return true iff `responseStatus` is `'declined'` or `'tentative'`.

    normalize: per the code snippet at 08-RESEARCH.md lines 135-150 — preserve all-day as YYYY-MM-DD string, never wrap in `new Date()`. Map attendees to email strings, filter out null/undefined emails. Title defaults to 'Untitled'. location/description default to null. htmlLink defaults to ''.

    pastPrune: drop events where end is strictly before now. For timed events compare `new Date(event.end).getTime() < now.getTime()`. For all-day events compare the YYYY-MM-DD string against `now.toISOString().slice(0,10)` lexicographically (valid because YYYY-MM-DD strings sort correctly).

    All three functions are pure: no I/O, no logger, no Redis, no fetch.
  </behavior>
  <action>
    Create `apps/web/utils/calendar/upcoming-events-helpers.ts` exporting the three functions per signatures and behavior above. Use the exact code snippets from 08-RESEARCH.md Q1 (isExcluded) and Q2 (normalize) as starting points, adjusting types to match the `NormalizedCalendarEvent` interface from Task 1 (e.g. `location: event.location ?? null` to honor the null-not-undefined rule).

    Iterate until `pnpm test -- utils/calendar/upcoming-events-helpers.test.ts --run` is fully green. If any test fails, adjust implementation (not test) unless the test itself encodes a contradiction with this plan's behavior section — in which case fix the test.
  </action>
  <verify>
    <automated>cd apps/web && pnpm test -- utils/calendar/upcoming-events-helpers.test.ts --run 2>&1 | tail -10</automated>
  </verify>
  <acceptance_criteria>
    - File `apps/web/utils/calendar/upcoming-events-helpers.ts` exists
    - `grep -q "export function isExcluded" apps/web/utils/calendar/upcoming-events-helpers.ts`
    - `grep -q "export function normalize" apps/web/utils/calendar/upcoming-events-helpers.ts`
    - `grep -q "export function pastPrune" apps/web/utils/calendar/upcoming-events-helpers.ts`
    - `grep -q "self === true" apps/web/utils/calendar/upcoming-events-helpers.ts` OR `grep -q "a.self" apps/web/utils/calendar/upcoming-events-helpers.ts` (self-attendee rule present)
    - `grep -q "event.start?.date" apps/web/utils/calendar/upcoming-events-helpers.ts` (all-day branch present)
    - `grep -vE "^\s*(//|\*|/\*)" apps/web/utils/calendar/upcoming-events-helpers.ts | grep -c "new Date(event.start" | xargs -I{} test {} -eq 0` (NOT wrapping all-day start in Date — per Pitfall 4)
    - `cd apps/web && pnpm test -- utils/calendar/upcoming-events-helpers.test.ts --run` exits 0
    - All 15+ test cases pass (GREEN)
  </acceptance_criteria>
  <done>All helper unit tests pass; the three pure functions are committed and ready for Plan 02 to compose into the cache-aware read function.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| (none in this plan) | Pure types + pure functions; no I/O, no untrusted input crosses any boundary. The `calendar_v3.Schema$Event` inputs in tests are static fixtures. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-08-01 | Information disclosure | normalize() copying event.description into result | accept | Description field is preserved by design (D-02 contract). Information leak risk is addressed in Plan 02's logging (never log full event bodies; IDs + timestamps only). |
| T-08-02 | Tampering | isExcluded filter logic | mitigate | Test suite locks all responseStatus + self-attendee branches with explicit fixtures; deviation requires intentional code+test change. |
</threat_model>

<verification>
- Helper unit tests pass: `cd apps/web && pnpm test -- utils/calendar/upcoming-events-helpers.test.ts --run` exits 0
- Type contract committed: `grep -q "export interface NormalizedCalendarEvent" apps/web/utils/calendar/upcoming-events-types.ts`
- All-day preservation enforced: pastPrune and normalize tests for all-day cases pass without `new Date()` wrapping
- Self-attendee rule enforced: isExcluded tests for "no self row" and "owner-created empty attendees" both return false
</verification>

<success_criteria>
- D-02 normalized event shape committed as a TypeScript interface, importable by Plan 02
- Three pure helpers implemented with 100% branch coverage by vitest
- Zero direct calls to Redis or Google in this plan (validated by absence of imports)
- Test suite is the executable specification for the responseStatus + all-day rules
</success_criteria>

<output>
After completion, create `.planning/phases/08-calendar-sync-foundation/08-01-SUMMARY.md` listing:
- Files created (paths)
- Test count and which behaviors they lock
- Any deviations from the planned `pastPrune` boundary rule (kept/dropped at end===now)
</output>
