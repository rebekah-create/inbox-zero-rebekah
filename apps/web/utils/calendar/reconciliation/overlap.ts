import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";

/**
 * Pure interval-intersection helper for reconciliation overlap detection.
 *
 * Phase 11 D-01: Two events overlap iff `candStart < eEnd AND candEnd > eStart`
 *   (strict less-than — events that exactly touch at a boundary do NOT overlap).
 *
 * Phase 11 D-02: When the Haiku-extracted candidate has no end time, treat it
 *   as a `DEFAULT_DURATION_MS` (60 minute) interval starting at candStart.
 *   This mirrors the default applied at insertion time in
 *   `apps/web/utils/calendar/reconciliation/create-event.ts` so the overlap
 *   check and the persisted event agree on duration.
 *
 * All-day existing events are excluded from the result regardless of date
 * overlap — all-day reconciliation is `match.ts`'s responsibility per D-03.
 *
 * Defensive behavior:
 *   - Unparseable candidate start -> empty result.
 *   - Unparseable existing-event start -> that event is skipped (not thrown).
 *   - Empty / unparseable existing end -> treat as existingStart + 60 min, the
 *     same default Google would have written via `create-event.ts`.
 *
 * Pure module — only imports the NormalizedCalendarEvent type. No Prisma, no
 * Google, no AI SDK.
 */

export const DEFAULT_DURATION_MS = 60 * 60 * 1000;

export function findIntervalOverlaps({
  candidateStartISO,
  candidateEndISO,
  existingEvents,
}: {
  candidateStartISO: string;
  candidateEndISO: string | null;
  existingEvents: NormalizedCalendarEvent[];
}): NormalizedCalendarEvent[] {
  if (!candidateStartISO) return [];
  const candStartMs = Date.parse(candidateStartISO);
  if (!Number.isFinite(candStartMs)) return [];

  let candEndMs: number;
  if (candidateEndISO) {
    const parsedEnd = Date.parse(candidateEndISO);
    candEndMs = Number.isFinite(parsedEnd)
      ? parsedEnd
      : candStartMs + DEFAULT_DURATION_MS;
  } else {
    candEndMs = candStartMs + DEFAULT_DURATION_MS;
  }

  return existingEvents.filter((e) => {
    if (e.isAllDay) return false;
    const eStartMs = Date.parse(e.start);
    if (!Number.isFinite(eStartMs)) return false;
    const eEndParsed = e.end ? Date.parse(e.end) : Number.NaN;
    const eEndMs = Number.isFinite(eEndParsed)
      ? eEndParsed
      : eStartMs + DEFAULT_DURATION_MS;
    // D-01 strict interval intersection.
    return candStartMs < eEndMs && candEndMs > eStartMs;
  });
}
