/**
 * Phase 9 reconciliation orchestrator (plan 09-06).
 *
 * Task 1 (this commit) ships only the keyword-backstop pre-filter helper —
 * a pure data-only function isolated so its 12-keyword D-02 list and
 * case-insensitivity can be unit-tested without dragging in any of the
 * orchestrator's mocked module boundaries.
 *
 * Task 2 extends this file with the full `reconcileMessage` orchestrator.
 */

/**
 * D-02 keyword backstop list (locked verbatim — see plan 09-06 task 1 action note).
 * Tuning happens in plan 09-08 if cost projection demands it.
 */
const CALENDAR_KEYWORDS = [
  "appointment",
  "reminder",
  "scheduled",
  "confirmation",
  "reservation",
  "your visit",
  "rsvp",
  "calendar",
  "meeting",
  "invitation",
  "booked",
  "dr.",
] as const;

/**
 * Returns true when ANY of the 12 D-02 keywords appears (case-insensitive)
 * in the concatenated subject + body haystack. Used by the orchestrator as
 * the Path B backstop when the v1.0 classifier hasn't tagged the message
 * with `Rule.systemType === "CALENDAR"`.
 *
 * Pure function: no I/O, no side effects.
 */
export function matchesKeywordBackstop({
  subject,
  body,
}: {
  subject: string;
  body: string;
}): boolean {
  const haystack = `${subject}\n${body}`.toLowerCase();
  return CALENDAR_KEYWORDS.some((kw) => haystack.includes(kw));
}
