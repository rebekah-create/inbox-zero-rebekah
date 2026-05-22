import type { calendar_v3 } from "@googleapis/calendar";
import type { NormalizedCalendarEvent } from "./upcoming-events-types";

/**
 * Returns true iff the calendar owner (self attendee) has responseStatus
 * 'declined' or 'tentative'. Events with no `self` attendee row are
 * owner-created (or the user is not on the invite list) and are kept.
 *
 * See 08-RESEARCH.md Q1 / Pitfalls 1 and 2.
 */
export function isExcluded(event: calendar_v3.Schema$Event): boolean {
  const selfAttendee = event.attendees?.find((a) => a.self === true);
  if (!selfAttendee) return false;
  return (
    selfAttendee.responseStatus === "declined" ||
    selfAttendee.responseStatus === "tentative"
  );
}

/**
 * Returns true iff the event has both a usable start and end (either
 * `dateTime` or `date`). Use this to filter out malformed events before
 * calling `normalize` — otherwise `normalize` will throw. The Google API
 * always populates one of the two in practice, but a defensive guard
 * avoids a hard-to-trace data-loss path downstream (WR-01).
 */
export function hasStartAndEnd(event: calendar_v3.Schema$Event): boolean {
  const startRaw = event.start?.dateTime ?? event.start?.date;
  const endRaw = event.end?.dateTime ?? event.end?.date;
  return Boolean(startRaw && endRaw);
}

/**
 * Converts a raw Google `Schema$Event` into the Phase 8 D-02 contract.
 * Critically: all-day events retain their `YYYY-MM-DD` strings; they are
 * never wrapped in `new Date()` (Pitfall 4 — UTC midnight shifts the date).
 *
 * Throws if the event has no usable start or end. Callers should filter with
 * `hasStartAndEnd` first (WR-01). The previous implementation cast `null` to
 * `string`, which let malformed events propagate as `start: null` typed as
 * non-null — those silently became `NaN` downstream in `pastPrune`.
 *
 * See 08-RESEARCH.md Q2.
 */
export function normalize(
  event: calendar_v3.Schema$Event,
): NormalizedCalendarEvent {
  const startDateTime = event.start?.dateTime ?? null;
  const endDateTime = event.end?.dateTime ?? null;
  const isAllDay = !startDateTime && !!event.start?.date;

  const startRaw = isAllDay ? event.start?.date : startDateTime;
  const endRaw = isAllDay ? event.end?.date : endDateTime;
  if (!startRaw || !endRaw) {
    throw new Error("Calendar event missing start or end");
  }
  const start: string = startRaw;
  const end: string = endRaw;

  const attendees = (event.attendees ?? [])
    .map((a) => a.email)
    .filter((e): e is string => typeof e === "string" && e.length > 0);

  return {
    id: event.id ?? "",
    title: event.summary ?? "Untitled",
    start,
    end,
    isAllDay,
    location: event.location ?? null,
    description: event.description ?? null,
    attendees,
    htmlLink: event.htmlLink ?? "",
  };
}

/**
 * Drops events whose end is strictly before `now`. Boundary rule:
 * keep events where `end >= now`; equivalently drop those where `end < now`.
 * Boundary case `end === now` is KEPT.
 *
 * Timed events compare unix ms. All-day events compare the YYYY-MM-DD end
 * string lexicographically against today's date — valid because ISO date
 * strings sort correctly.
 *
 * CALLER CONTRACT — TIMEZONE (WR-02):
 *   `todayLocalDate` MUST be the YYYY-MM-DD string for the user's local
 *   timezone, not UTC. If omitted, falls back to `now.toISOString().slice(0,10)`
 *   (UTC), which is INCORRECT outside UTC and will silently drop an all-day
 *   event one calendar day early when the user's local time has rolled over
 *   but UTC has not (or vice versa). The current digest cron runs at 6-7am ET
 *   where UTC === ET-date (after 4am UTC), so the legacy fallback is safe for
 *   that single window only. Phase 9 reconciliation runs at arbitrary times
 *   and MUST pass `todayLocalDate` explicitly.
 *
 *   To compute correctly for a tz:
 *     new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now)
 *   yields "YYYY-MM-DD" in that tz (en-CA locale gives ISO-format dates).
 *
 * See 08-RESEARCH.md Pitfall 6.
 */
export function pastPrune(
  events: NormalizedCalendarEvent[],
  now: Date,
  todayLocalDate?: string,
): NormalizedCalendarEvent[] {
  const nowMs = now.getTime();
  const todayString = todayLocalDate ?? now.toISOString().slice(0, 10);
  return events.filter((event) => {
    if (event.isAllDay) {
      return event.end >= todayString;
    }
    const endMs = new Date(event.end).getTime();
    return endMs >= nowMs;
  });
}
