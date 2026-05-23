/**
 * Phase 10 agenda data contracts.
 *
 * These types are the stable surface that Wave 2's props builder (Plan 03)
 * and Wave 1's React Email component (Plan 04) both import against. Fields
 * mirror the D-06 per-event row schema and the D-04 two-section agenda
 * block shape from the phase context.
 *
 * Pure type module — no runtime imports.
 */

export type AgendaItem = {
  /** "9:00a" — D-07 single-letter am/pm marker. "All day" when isAllDay. */
  time: string;
  /** "10:00a" or null. Null when end equals start (D-06). */
  endTime: string | null;
  title: string;
  location: string | null;
  isAllDay: boolean;
  /** Ids of overlapping siblings in the same sub-section (D-08). Empty when no overlap. */
  overlapWith: string[];
  /** NormalizedCalendarEvent.id — needed so detectOverlaps can key its return map. */
  id: string;
};

export type AgendaBlock = {
  today: AgendaItem[];
  tomorrowMorning: AgendaItem[];
  /** D-05 fallback copy when today has no events; null otherwise. */
  todayFallback: string | null;
  /** D-05 fallback copy when tomorrow morning has no events; null otherwise. */
  tomorrowMorningFallback: string | null;
};
