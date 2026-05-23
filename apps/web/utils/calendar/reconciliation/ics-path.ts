import {
  analyzeCalendarEvent,
  hasIcsAttachment,
} from "@/utils/parse/calender-event";
import type { ParsedMessage } from "@/utils/types";
import type { CandidateEvent } from "./extract";

/**
 * Path A (.ics) extraction — REC-01, EVT-01, T-09-02.
 *
 * Deterministic adapter over `analyzeCalendarEvent` + `hasIcsAttachment`. Reshapes
 * the existing `CalendarEventInfo` output into the Phase 9 `CandidateEvent`
 * contract. No LLM call ever reaches this code path — that's the point of T-09-02
 * (defense against prompt injection via .ics attachments). The grep gate in the
 * plan asserts zero LLM imports in this file; do NOT regress.
 *
 * Confidence is hard-coded to 1.0 because .ics field values come from the
 * structured iCalendar block, not a free-text body — they are authoritative.
 *
 * `analyzeCalendarEvent` (apps/web/utils/parse/calender-event.ts:24) returns
 *   `{ isCalendarEvent, eventDate?, endDate?, eventTitle?, organizer?, ... }`.
 *   There is no `location` field exposed; we surface null. There is no
 *   `isAllDay` marker exposed; we infer it from the midnight-UTC + 24h-multiple
 *   pattern that `VALUE=DATE` iCalendar entries produce. TODO: extend the
 *   underlying parser to expose the DTSTART type so this inference can go away.
 */
export function extractFromIcs(
  parsedMessage: ParsedMessage,
): CandidateEvent | null {
  if (!hasIcsAttachment(parsedMessage)) return null;

  const ics = analyzeCalendarEvent(parsedMessage);
  if (!ics.isCalendarEvent || !ics.eventDate) return null;

  const startISO = ics.eventDate.toISOString();
  const endISO = ics.endDate ? ics.endDate.toISOString() : null;
  const title = ics.eventTitle ?? "";

  // D-08 all-day derivation. Heuristic: a midnight-UTC start with an end that
  // is an exact whole-day multiple later (or no end at all) is the shape that
  // `VALUE=DATE` iCalendar entries produce. Timed events have non-midnight UTC
  // components even after timezone normalization.
  const isAllDay =
    ics.eventDate.getUTCHours() === 0 &&
    ics.eventDate.getUTCMinutes() === 0 &&
    ics.eventDate.getUTCSeconds() === 0 &&
    ics.endDate != null &&
    (ics.endDate.getTime() - ics.eventDate.getTime()) % 86_400_000 === 0;

  return {
    title,
    startISO,
    endISO,
    location: null, // analyzeCalendarEvent does not surface .ics LOCATION today
    attendees: [], // .ics ATTENDEE lines are not parsed by the existing helper
    confidence: 1.0,
    isAllDay,
  };
}
