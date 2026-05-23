import { formatAgendaTime } from "@/utils/digest/agenda/format-time";
import type { CalendarActivityOutcome } from "./types";

/**
 * D-11 sentence templates for Calendar Activity rows (Phase 10).
 *
 * Templates (verbatim from 10-CONTEXT D-11):
 *   AMBIGUOUS -> "{Sender}: looks like it's about {extractedTitle} — review →"
 *   CREATED   -> "Added {extractedTitle} {day/time} to your calendar (from {sender}) →"
 *   MATCHED   -> "{Sender} confirmed {extractedTitle} — already on your calendar"
 *
 * Day/time format for CREATED rows (RESEARCH §"Open Questions #3" recommendation):
 *   - Timed:   "{dayAbbrev} at {formatAgendaTime}"  e.g. "Mon at 9:00a"
 *   - All-day: "{dayAbbrev}"                         e.g. "Mon"
 *
 * Day abbreviation: 3-letter weekday in America/New_York (Intl.DateTimeFormat).
 *
 * T-10-02 mitigation: this helper returns plain text. It does NOT pre-escape
 * HTML metacharacters from extractedTitle / sender — React Email's Text and
 * Link components in Plan 04 auto-escape on render. The Plan 04 grep gate
 * asserts the raw-HTML escape hatch is absent from the CalendarActivitySection.
 *
 * Pure helper — imports only formatAgendaTime + CalendarActivityOutcome type.
 * No Prisma, no Google client, no AI SDK.
 */

function formatDayAbbrev(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(date);
}

export function renderSentence({
  outcome,
  sender,
  extractedTitle,
  extractedStart,
  isAllDay,
}: {
  outcome: CalendarActivityOutcome;
  sender: string;
  extractedTitle: string;
  extractedStart: Date;
  isAllDay: boolean;
}): string {
  switch (outcome) {
    case "MATCHED":
      return `${sender} confirmed ${extractedTitle} — already on your calendar`;
    case "AMBIGUOUS":
      return `${sender}: looks like it's about ${extractedTitle} — review →`;
    case "CREATED": {
      const dayAbbrev = formatDayAbbrev(extractedStart);
      const dayTime = isAllDay
        ? dayAbbrev
        : `${dayAbbrev} at ${formatAgendaTime({ iso: extractedStart.toISOString(), isAllDay: false })}`;
      return `Added ${extractedTitle} ${dayTime} to your calendar (from ${sender}) →`;
    }
  }
}
