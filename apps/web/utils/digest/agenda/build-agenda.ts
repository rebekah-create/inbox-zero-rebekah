import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { formatAgendaTime } from "./format-time";
import { detectOverlaps } from "./overlap";
import type { AgendaBlock, AgendaItem } from "./types";
import { windowToday, windowTomorrow } from "./window";

/**
 * Agenda props builder.
 *
 * Composes the pure window/overlap/format helpers into the AgendaBlock that
 * the React Email digest template renders. Pure — no I/O. Called from
 * run-daily-digest.ts after `getUpcomingEvents` resolves.
 *
 *  - windowToday / windowTomorrow filter the input event list. Tomorrow is the
 *    full ET-day — no morning/afternoon split (single section in the digest).
 *  - detectOverlaps runs per-day (D-10) so a late-night event today does not
 *    flag against an early-morning event tomorrow.
 *  - All-day events bubble to the top of each day's array; among themselves
 *    they sort alphabetically by title. Timed events follow, ascending by start.
 *  - Fallbacks (single line each, when the section is empty):
 *      todayFallback    = "Nothing else on the calendar today."
 *      tomorrowFallback = "Nothing on the calendar tomorrow."
 *
 * Pure helper — no Prisma, no Google client, no AI SDK, no React.
 */

function toAgendaItem(
  event: NormalizedCalendarEvent,
  overlapMap: Map<string, string[]>,
): AgendaItem {
  // D-06: endTime is null when isAllDay OR when end === start.
  const startTime = formatAgendaTime({
    iso: event.start,
    isAllDay: event.isAllDay,
  });
  const endTime =
    event.isAllDay || event.start === event.end
      ? null
      : formatAgendaTime({ iso: event.end, isAllDay: false });
  return {
    id: event.id,
    title: event.title,
    location: event.location,
    isAllDay: event.isAllDay,
    time: startTime,
    endTime,
    overlapWith: overlapMap.get(event.id) ?? [],
  };
}

/**
 * Sort one day's AgendaItems: all-day events first (alphabetical by title),
 * then timed events ascending by underlying start instant.
 *
 * `windowToday` / `windowTomorrow` already sort by start; this re-sort
 * additionally enforces alphabetical ordering among all-day items.
 */
function sortDay(
  items: AgendaItem[],
  startByIdMs: Map<string, number>,
): AgendaItem[] {
  return [...items].sort((a, b) => {
    if (a.isAllDay && !b.isAllDay) return -1;
    if (!a.isAllDay && b.isAllDay) return 1;
    if (a.isAllDay && b.isAllDay) {
      return a.title.localeCompare(b.title);
    }
    // Timed-vs-timed: use the original event start instants.
    return (startByIdMs.get(a.id) ?? 0) - (startByIdMs.get(b.id) ?? 0);
  });
}

export function buildAgenda({
  events,
  now,
}: {
  events: NormalizedCalendarEvent[];
  now: Date;
}): AgendaBlock {
  const todayEvents = windowToday({ events, now });
  const tomorrowEvents = windowTomorrow({ events, now });

  // D-10: detect overlaps per-day (separate maps).
  const todayOverlaps = detectOverlaps({ events: todayEvents });
  const tomorrowOverlaps = detectOverlaps({ events: tomorrowEvents });

  // Carry timed start instants by id so sortDay can use them.
  const todayStartMs = new Map<string, number>(
    todayEvents
      .filter((e) => !e.isAllDay)
      .map((e) => [e.id, new Date(e.start).getTime()]),
  );
  const tomorrowStartMs = new Map<string, number>(
    tomorrowEvents
      .filter((e) => !e.isAllDay)
      .map((e) => [e.id, new Date(e.start).getTime()]),
  );

  const today = sortDay(
    todayEvents.map((e) => toAgendaItem(e, todayOverlaps)),
    todayStartMs,
  );
  const tomorrow = sortDay(
    tomorrowEvents.map((e) => toAgendaItem(e, tomorrowOverlaps)),
    tomorrowStartMs,
  );

  const todayFallback =
    today.length > 0 ? null : "Nothing else on the calendar today.";
  const tomorrowFallback =
    tomorrow.length > 0 ? null : "Nothing on the calendar tomorrow.";

  return {
    today,
    tomorrow,
    todayFallback,
    tomorrowFallback,
  };
}
