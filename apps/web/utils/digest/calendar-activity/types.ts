/**
 * Calendar Activity types — Phase 10 DIG-05.
 *
 * Row + block shapes consumed by `build-activity` (Plan 03) and the React Email
 * `CalendarActivitySection` sub-component (Plan 04). All values are pre-rendered
 * primitives (string sentence + string href) so the render layer stays dumb.
 *
 * D-16: only MATCHED / CREATED / AMBIGUOUS are surfaced. FAILED and PENDING are
 * intentionally excluded from this type alias so the type system enforces the
 * digest contract — those outcomes are internal/operational state only.
 *
 * Pure type module — no runtime, no I/O.
 */

export type CalendarActivityOutcome = "MATCHED" | "CREATED" | "AMBIGUOUS";

export type CalendarActivityRow = {
  sentence: string;
  href: string;
};

export type CalendarActivityBlock = {
  review: CalendarActivityRow[]; // AMBIGUOUS (D-11)
  added: CalendarActivityRow[]; // CREATED (D-11)
  confirmed: CalendarActivityRow[]; // MATCHED (D-11)
};
