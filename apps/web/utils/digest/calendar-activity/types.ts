/**
 * Calendar Activity types — Phase 10 DIG-05.
 *
 * Row + block shapes consumed by `build-activity` (Plan 03) and the React Email
 * `CalendarActivitySection` sub-component (Plan 04). All values are pre-rendered
 * primitives (string sentence + string href) so the render layer stays dumb.
 *
 * D-16 (amended 2026-06): only AMBIGUOUS / RESCHEDULE are surfaced. FAILED and
 * PENDING remain internal/operational state. MATCHED ("confirmed") and CREATED
 * ("added") were dropped from the digest once the reconciler proved trustworthy —
 * they were diagnostic clutter; the calendar itself is the record of adds.
 *
 * RESCHEDULE (Phase 11): the reconciler created a new event at the new time AND
 * left a non-destructive note on the old event. It surfaces in its own
 * `rescheduled` bucket and links to the new event.
 *
 * Pure type module — no runtime, no I/O.
 */

export type CalendarActivityOutcome = "AMBIGUOUS" | "RESCHEDULE";

export type CalendarActivityRow = {
  sentence: string;
  href: string;
};

export type CalendarActivityBlock = {
  review: CalendarActivityRow[]; // AMBIGUOUS (D-11)
  rescheduled: CalendarActivityRow[]; // RESCHEDULE (Phase 11)
};
