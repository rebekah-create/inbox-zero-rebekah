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
 * Converts a raw Google `Schema$Event` into the Phase 8 D-02 contract.
 * Critically: all-day events retain their `YYYY-MM-DD` strings; they are
 * never wrapped in `new Date()` (Pitfall 4 — UTC midnight shifts the date).
 *
 * See 08-RESEARCH.md Q2.
 */
export function normalize(
  event: calendar_v3.Schema$Event,
): NormalizedCalendarEvent {
  const startDateTime = event.start?.dateTime ?? null;
  const endDateTime = event.end?.dateTime ?? null;
  const isAllDay = !startDateTime && !!event.start?.date;

  const start = isAllDay
    ? (event.start?.date as string)
    : (startDateTime as string);
  const end = isAllDay
    ? (event.end?.date as string)
    : (endDateTime as string);

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
 * an event whose end equals `now` exactly is KEPT (predicate is `end < now`).
 *
 * Timed events compare unix ms. All-day events compare the YYYY-MM-DD end
 * string lexicographically against `now.toISOString().slice(0,10)` — valid
 * because ISO date strings sort correctly. Note this uses UTC date; for the
 * single-user personal-logistics use case in v1.1 this is acceptable and
 * matches the documented contract.
 *
 * See 08-RESEARCH.md Pitfall 6.
 */
export function pastPrune(
  events: NormalizedCalendarEvent[],
  now: Date,
): NormalizedCalendarEvent[] {
  const nowMs = now.getTime();
  const todayString = now.toISOString().slice(0, 10);
  return events.filter((event) => {
    if (event.isAllDay) {
      return event.end >= todayString;
    }
    const endMs = new Date(event.end).getTime();
    return endMs >= nowMs;
  });
}
