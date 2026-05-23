/**
 * D-07 agenda time formatter.
 *
 * Renders RFC3339 timed event boundaries as "9:00a" / "2:30p" (single-letter
 * am/pm marker, no space) for the conversational digest voice. For events
 * crossing midnight ET, renders "9:00p–12:30a (tonight)".
 *
 * All-day events return the literal string "All day" — date-string `start`/`end`
 * are never passed to `new Date()` (08-RESEARCH.md Pitfall 4 / Pattern S5).
 *
 * Pure helper — no Prisma, no Google client, no React.
 */

const ET = "America/New_York";

function formatRawTimeET(iso: string): string {
  // Produces "9:00 AM" / "2:30 PM" — standard Intl output in ET.
  const raw = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
  // Collapse " AM" → "a" / " PM" → "p" (D-07 single-letter marker, no space).
  return raw.replace(" AM", "a").replace(" PM", "p");
}

function etDateString(iso: string): string {
  // YYYY-MM-DD in America/New_York for cross-midnight date comparison.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function formatAgendaTime({
  iso,
  isAllDay,
}: {
  iso: string;
  isAllDay: boolean;
}): string {
  // Pattern S5: branch on isAllDay before `new Date()`.
  if (isAllDay) return "All day";
  return formatRawTimeET(iso);
}

export function formatAgendaRange({
  startIso,
  endIso,
  isAllDay,
}: {
  startIso: string;
  endIso: string;
  isAllDay: boolean;
}): string {
  // Pattern S5: branch on isAllDay first.
  if (isAllDay) return "All day";
  // D-06: end times shown only when present and not equal to start.
  if (startIso === endIso)
    return formatAgendaTime({ iso: startIso, isAllDay: false });

  const start = formatAgendaTime({ iso: startIso, isAllDay: false });
  const end = formatAgendaTime({ iso: endIso, isAllDay: false });
  const range = `${start}–${end}`; // em-dash U+2013

  // D-07 cross-midnight: append "(tonight)" when the end ET-date > start ET-date.
  if (etDateString(endIso) > etDateString(startIso)) {
    return `${range} (tonight)`;
  }
  return range;
}
