/**
 * Phase 8 normalized calendar event contract.
 *
 * This is the type surface that Phase 9 (reconciliation) and Phase 10 (digest)
 * consume. No `calendar_v3.Schema$Event` fields leak through — downstream code
 * imports only from this module.
 *
 * See `.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md` D-02.
 */

export interface NormalizedCalendarEvent {
  /**
   * Email addresses only. Empty array if no attendees or the owner is the
   * sole attendee.
   */
  attendees: string[];
  /** Event description, or null when absent. */
  description: string | null;
  /**
   * RFC3339 timestamp for timed events; "YYYY-MM-DD" string when isAllDay is true.
   * Never wrap in `new Date()` without branching on isAllDay — see
   * 08-RESEARCH.md Pitfall 4 (UTC midnight shifts all-day dates by ~hours).
   */
  end: string;
  /** Google Calendar UI link. Defaults to "" if missing. */
  htmlLink: string;
  /** Google Calendar event id. */
  id: string;
  /** True when the Google event used `date` (not `dateTime`). */
  isAllDay: boolean;
  /** Event location string, or null when absent. */
  location: string | null;
  /**
   * RFC3339 timestamp for timed events; "YYYY-MM-DD" string when isAllDay is true.
   * Never wrap in `new Date()` without branching on isAllDay — see
   * 08-RESEARCH.md Pitfall 4 (UTC midnight shifts all-day dates by ~hours).
   */
  start: string;
  /** Event title. Defaults to "Untitled" if `event.summary` is missing. */
  title: string;
}

/**
 * Cache envelope shape for Redis storage.
 *
 * D-09 stale-fallback requirement (see 08-RESEARCH.md Q3): Redis deletes
 * expired keys on get, so a naive TTL cannot serve stale data after expiry.
 * Instead the envelope is stored with a long hard TTL (24h) and the read
 * function compares `fetchedAt` against `now` to decide soft-freshness.
 */
export interface CalendarCacheEnvelope {
  data: NormalizedCalendarEvent[];
  /** Unix milliseconds at which `data` was written. */
  fetchedAt: number;
}
