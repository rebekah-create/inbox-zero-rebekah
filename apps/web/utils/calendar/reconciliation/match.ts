import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { titleSimilarity } from "./dice";

/**
 * D-06 four-step decision tree for reconciling an extracted calendar candidate
 * against the user's existing 7-day window.
 *
 *  1. Strong title sim (>= 0.7) AND time within ±60min -> MATCHED
 *  2. Strong title sim anywhere in window, time differs > 60min -> AMBIGUOUS (reschedule, REC-06)
 *  3. Same-day event AND weak sim (0.4 <= sim < 0.7) -> AMBIGUOUS (near-match)
 *  4. Otherwise -> CREATED
 *
 * D-08 all-day branch is handled first: compare by date-string (YYYY-MM-DD)
 * equality plus title strong-sim. Never wrap an all-day `start` in `new Date()`
 * — see 08-RESEARCH.md Pitfall 4 (UTC midnight shifts the date).
 *
 * Pure helper — only imports are `titleSimilarity` from ./dice and the
 * NormalizedCalendarEvent type. No Prisma, no Google client, no AI SDK.
 */

export type ReconcileOutcome = "MATCHED" | "CREATED" | "AMBIGUOUS";

const STRONG_SIM = 0.7;
const WEAK_SIM = 0.4;
const TIME_WINDOW_MS = 60 * 60 * 1000;

export function decideOutcome({
  candidate,
  existingEvents,
}: {
  candidate: { title: string; startISO: string; isAllDay: boolean };
  existingEvents: NormalizedCalendarEvent[];
}): { outcome: ReconcileOutcome; matchedEventId: string | null } {
  // D-08: all-day candidates compare by date string + strong title sim.
  if (candidate.isAllDay) {
    const candDate = candidate.startISO.slice(0, 10);
    for (const e of existingEvents) {
      // For an all-day existing event, `start` is "YYYY-MM-DD".
      // For a timed existing event, slice(0,10) still yields the date portion.
      const eDate = e.start.slice(0, 10);
      const sim = titleSimilarity(candidate.title, e.title);
      if (eDate === candDate && sim >= STRONG_SIM) {
        return { outcome: "MATCHED", matchedEventId: e.id };
      }
    }
    return { outcome: "CREATED", matchedEventId: null };
  }

  const candMs = Date.parse(candidate.startISO);

  // Step 1: strong sim AND time within ±60min -> MATCHED
  for (const e of existingEvents) {
    if (e.isAllDay) continue; // all-day existing can't match a timed candidate at minute precision
    const sim = titleSimilarity(candidate.title, e.title);
    const diff = Math.abs(Date.parse(e.start) - candMs);
    if (sim >= STRONG_SIM && diff <= TIME_WINDOW_MS) {
      return { outcome: "MATCHED", matchedEventId: e.id };
    }
  }

  // Step 2: strong sim anywhere in window -> AMBIGUOUS (reschedule, REC-06)
  for (const e of existingEvents) {
    if (e.isAllDay) continue;
    const sim = titleSimilarity(candidate.title, e.title);
    if (sim >= STRONG_SIM) {
      return { outcome: "AMBIGUOUS", matchedEventId: e.id };
    }
  }

  // Step 3: same-day + weak sim -> AMBIGUOUS (near-match)
  const candDate = candidate.startISO.slice(0, 10);
  for (const e of existingEvents) {
    const eDate = e.start.slice(0, 10);
    const sim = titleSimilarity(candidate.title, e.title);
    if (eDate === candDate && sim >= WEAK_SIM && sim < STRONG_SIM) {
      return { outcome: "AMBIGUOUS", matchedEventId: e.id };
    }
  }

  return { outcome: "CREATED", matchedEventId: null };
}
