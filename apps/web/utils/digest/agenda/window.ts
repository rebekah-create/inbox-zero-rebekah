import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";

/**
 * D-04 agenda window filters.
 *
 *  - windowToday:           [now, midnight-ET-of-today)
 *  - windowTomorrowMorning: [6am ET tomorrow, noon ET tomorrow)
 *
 * Both branch on `isAllDay` first (Pattern S5) — all-day events use the
 * `YYYY-MM-DD` date string directly; timed events use RFC3339 instants.
 * Never wrap an all-day `start`/`end` in `new Date()` — UTC midnight
 * shifts the date in ET (08-RESEARCH.md Pitfall 4).
 *
 * DST is delegated to `Intl.DateTimeFormat`. No hand-rolled DST math.
 *
 * Pure helper — no Prisma, no Google client, no React.
 */

const ET = "America/New_York";

/** "YYYY-MM-DD" in America/New_York for the given instant. */
function etDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** "YYYY-MM-DD" of the ET-day after the ET-day containing `d`. */
function etTomorrowDateString(d: Date): string {
  // 36 hours forward guarantees we cross into tomorrow ET regardless of DST/UTC offset.
  const plus = new Date(d.getTime() + 36 * 60 * 60 * 1000);
  return etDateString(plus);
}

/** Returns a Date instant for hour-of-day ET on a specific ET YYYY-MM-DD. */
function etBoundaryFromYmd(ymd: string, hour: number): Date {
  // Probe the UTC offset for ET at noon on the target date by reading Intl parts.
  // Noon avoids the spring-forward/fall-back ambiguity windows.
  const probe = new Date(`${ymd}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(probe);
  const etHourAtUtcNoon = Number(parts.find((p) => p.type === "hour")?.value);
  // offsetHours such that (UTC noon) + offsetHours = ET hour at that instant
  // => ET = UTC + offsetHours ; offsetHours typically -4 (EDT) or -5 (EST)
  const offsetHours = etHourAtUtcNoon - 12;
  // To build the instant for `hour` ET on that ymd: UTC = hour - offsetHours
  const hh = String(hour - offsetHours).padStart(2, "0");
  return new Date(`${ymd}T${hh}:00:00.000Z`);
}

function sortByStartAsc<T extends { start: string; isAllDay: boolean }>(
  events: T[],
): T[] {
  return [...events].sort((a, b) => {
    // All-day events bubble to the top of the day; among themselves keep order by date string.
    if (a.isAllDay && !b.isAllDay) return -1;
    if (!a.isAllDay && b.isAllDay) return 1;
    if (a.isAllDay && b.isAllDay) return a.start.localeCompare(b.start);
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });
}

export function windowToday({
  events,
  now,
}: {
  events: NormalizedCalendarEvent[];
  now: Date;
}): NormalizedCalendarEvent[] {
  const todayYmd = etDateString(now);
  const endOfDay = etBoundaryFromYmd(
    // midnight at end of today = midnight at start of tomorrow
    etTomorrowDateString(now),
    0,
  );

  const kept = events.filter((event) => {
    // Pattern S5: branch on isAllDay before `new Date()`.
    if (event.isAllDay) {
      return event.start === todayYmd;
    }
    const startMs = new Date(event.start).getTime();
    const endMs = new Date(event.end).getTime();
    // D-04: timed event whose end > now AND start < midnight-ET-of-today.
    return endMs > now.getTime() && startMs < endOfDay.getTime();
  });

  return sortByStartAsc(kept);
}

export function windowTomorrowMorning({
  events,
  now,
}: {
  events: NormalizedCalendarEvent[];
  now: Date;
}): NormalizedCalendarEvent[] {
  const tomorrowYmd = etTomorrowDateString(now);
  const sixAm = etBoundaryFromYmd(tomorrowYmd, 6);
  const noon = etBoundaryFromYmd(tomorrowYmd, 12);

  const kept = events.filter((event) => {
    if (event.isAllDay) {
      return event.start === tomorrowYmd;
    }
    const startMs = new Date(event.start).getTime();
    const endMs = new Date(event.end).getTime();
    // D-04: timed event whose start < noon-ET-tomorrow AND end > 6am-ET-tomorrow.
    return startMs < noon.getTime() && endMs > sixAm.getTime();
  });

  return sortByStartAsc(kept);
}
