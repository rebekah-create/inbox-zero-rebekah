import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { formatAgendaTime } from "./format-time";
import { detectOverlaps } from "./overlap";
import type { AgendaBlock, AgendaItem } from "./types";
import { windowToday, windowTomorrowMorning } from "./window";

/**
 * D-04/D-05/D-06/D-07/D-08/D-10 agenda props builder (Phase 10).
 *
 * Composes Plan 10-01's pure helpers into the AgendaBlock that the React Email
 * digest template (Plan 10-04) renders. Pure — no I/O. Called from
 * run-daily-digest.ts after `getUpcomingEvents` resolves (Plan 10-05).
 *
 *  - windowToday / windowTomorrowMorning filter the input event list.
 *  - detectOverlaps runs per-day (D-10) so a late-night event today does not
 *    flag against an early-morning event tomorrow.
 *  - All-day events bubble to the top of each day's array; among themselves
 *    they sort alphabetically by title (RESEARCH "Open Questions #2").
 *  - Timed events follow, ascending by start.
 *  - Fallbacks (D-05):
 *      todayFallback        = "Nothing else on the calendar today." when today empty.
 *      tomorrowMorningFallback = "Nothing before noon; first thing is {time} {title}."
 *                                when morning empty BUT later events exist tomorrow.
 *      tomorrowMorningFallback = "Nothing on the calendar tomorrow." when no events
 *                                exist anywhere in tomorrow ET.
 *  - When a section is non-empty, its corresponding fallback is null.
 *
 * Pure helper — no Prisma, no Google client, no AI SDK, no React.
 */

const ET = "America/New_York";

function etDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function etTomorrowDateString(d: Date): string {
  const plus = new Date(d.getTime() + 36 * 60 * 60 * 1000);
  return etDateString(plus);
}

/** All events scheduled anywhere in the ET-day of `tomorrow` (timed or all-day). */
function eventsAnywhereTomorrow(
  events: NormalizedCalendarEvent[],
  now: Date,
): NormalizedCalendarEvent[] {
  const tomorrowYmd = etTomorrowDateString(now);
  return events
    .filter((event) => {
      if (event.isAllDay) {
        return event.start === tomorrowYmd;
      }
      // Timed: any event whose start falls on tomorrow's ET date string.
      const startEtYmd = new Intl.DateTimeFormat("en-CA", {
        timeZone: ET,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(event.start));
      return startEtYmd === tomorrowYmd;
    })
    .sort((a, b) => {
      // All-day first, then timed ascending by start instant.
      if (a.isAllDay && !b.isAllDay) return -1;
      if (!a.isAllDay && b.isAllDay) return 1;
      if (a.isAllDay && b.isAllDay) return a.start.localeCompare(b.start);
      return new Date(a.start).getTime() - new Date(b.start).getTime();
    });
}

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
 * `windowToday` / `windowTomorrowMorning` already sort by start; this re-sort
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
  const morningEvents = windowTomorrowMorning({ events, now });

  // D-10: detect overlaps per-day (separate maps).
  const todayOverlaps = detectOverlaps({ events: todayEvents });
  const morningOverlaps = detectOverlaps({ events: morningEvents });

  // Carry timed start instants by id so sortDay can use them.
  const todayStartMs = new Map<string, number>(
    todayEvents
      .filter((e) => !e.isAllDay)
      .map((e) => [e.id, new Date(e.start).getTime()]),
  );
  const morningStartMs = new Map<string, number>(
    morningEvents
      .filter((e) => !e.isAllDay)
      .map((e) => [e.id, new Date(e.start).getTime()]),
  );

  const today = sortDay(
    todayEvents.map((e) => toAgendaItem(e, todayOverlaps)),
    todayStartMs,
  );
  const tomorrowMorning = sortDay(
    morningEvents.map((e) => toAgendaItem(e, morningOverlaps)),
    morningStartMs,
  );

  // D-05 fallbacks.
  const todayFallback =
    today.length > 0 ? null : "Nothing else on the calendar today.";

  let tomorrowMorningFallback: string | null = null;
  if (tomorrowMorning.length === 0) {
    const allTomorrow = eventsAnywhereTomorrow(events, now);
    if (allTomorrow.length === 0) {
      tomorrowMorningFallback = "Nothing on the calendar tomorrow.";
    } else {
      // Earliest event tomorrow that is not a morning event — i.e. after-noon.
      // `windowTomorrowMorning` returned empty, so all of `allTomorrow` is non-morning.
      // For the extender we want the *first thing* on the calendar tomorrow.
      // Prefer the first timed event (real time-of-day); fall back to first all-day.
      const firstTimed = allTomorrow.find((e) => !e.isAllDay);
      const firstLater = firstTimed ?? allTomorrow[0]!;
      const firstTime = formatAgendaTime({
        iso: firstLater.start,
        isAllDay: firstLater.isAllDay,
      });
      tomorrowMorningFallback = `Nothing before noon; first thing is ${firstTime} ${firstLater.title}.`;
    }
  }

  return {
    today,
    tomorrowMorning,
    todayFallback,
    tomorrowMorningFallback,
  };
}
