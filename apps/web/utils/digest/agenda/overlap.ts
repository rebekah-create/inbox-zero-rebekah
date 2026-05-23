import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";

/**
 * D-08 overlap rule: strict time-interval intersection.
 * Two timed events A and B overlap iff [startA, endA) ∩ [startB, endB) ≠ ∅,
 * i.e. `start_A < end_B && start_B < end_A`.
 *
 *  - All-day events never participate in overlap detection (D-08).
 *  - Back-to-back events (endA === startB) do NOT overlap — half-open
 *    interval semantics.
 *  - Detection is per-day (D-10); call this after windowing so the input
 *    is already a single day's slate.
 *
 * Returns a Map<eventId, eventId[]> of sibling ids for each overlapping
 * event. Events with no overlaps are absent from the map (no empty arrays).
 *
 * O(n²) double-loop — n is 1–3 events/day for this personal-logistics
 * use case (PROJECT.md). Interval tree would be over-engineering
 * (10-RESEARCH.md "Alternatives Considered").
 *
 * Pure helper — no Prisma, no Google client, no AI SDK.
 */
export function detectOverlaps({
  events,
}: {
  events: NormalizedCalendarEvent[];
}): Map<string, string[]> {
  const result = new Map<string, string[]>();
  // D-08: all-day events never participate — filter them out up front.
  const timed = events.filter((e) => !e.isAllDay);

  for (let i = 0; i < timed.length; i++) {
    const a = timed[i]!;
    const aStart = new Date(a.start).getTime();
    const aEnd = new Date(a.end).getTime();
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j]!;
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();
      // Strict half-open intersection — back-to-back (aEnd === bStart) yields false.
      if (aStart < bEnd && bStart < aEnd) {
        appendSibling(result, a.id, b.id);
        appendSibling(result, b.id, a.id);
      }
    }
  }

  return result;
}

function appendSibling(
  map: Map<string, string[]>,
  key: string,
  sibling: string,
): void {
  const list = map.get(key);
  if (list) {
    list.push(sibling);
  } else {
    map.set(key, [sibling]);
  }
}
