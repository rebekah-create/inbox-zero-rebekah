import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";

/**
 * Phase 11 D-03 — all-day reconciliation branch.
 *
 * Token-Dice (Phase 9 D-06/D-07) has been retired (D-04, D-12). `match.ts`
 * now owns ONE responsibility: deciding what to do when the Haiku extractor
 * returns an all-day candidate. Timed candidates are routed through
 * `overlap.ts` + the arbitration Haiku call in `arbitrate.ts` by the
 * orchestrator (Phase 11 11-05); this module is never called for them.
 *
 * Rule: if any existing event shares the candidate's date (by `slice(0,10)`),
 * return `NEEDS_ARBITRATION` along with the list of same-date events so the
 * orchestrator can hand them off to Haiku. If no event shares the date,
 * return `CREATED` — there is nothing to compare against.
 *
 * Title similarity is NEVER consulted in this module. All semantic identity
 * judgments are deferred to the arbiter.
 *
 * Date-handling pitfall: never wrap an all-day `start` in `new Date()` — UTC
 * midnight shifts can move the date by hours (Phase 8 08-RESEARCH.md
 * Pitfall 4; Phase 9 D-08 carry-forward). Always compare date strings.
 */

/**
 * Discriminated outcome of the all-day branch.
 *
 * `MATCHED` is not currently produced by `decideAllDayOutcome` — under Phase 11
 * the MATCH-vs-CREATE decision lives downstream of the arbiter. The variant is
 * kept in the type for forward-compat in case a future task makes this function
 * authoritative again (e.g. a deterministic fast-path).
 */
export type AllDayOutcome = {
  matchedEventId: string | null;
  outcome: "MATCHED" | "CREATED" | "NEEDS_ARBITRATION";
  sameDateEvents: NormalizedCalendarEvent[];
};

export function decideAllDayOutcome({
  candidate,
  existingEvents,
}: {
  candidate: { isAllDay: true; startISO: string; title: string };
  existingEvents: NormalizedCalendarEvent[];
}): AllDayOutcome {
  if (candidate.isAllDay !== true) {
    throw new Error(
      "decideAllDayOutcome called with non-all-day candidate; orchestrator must route timed candidates through findIntervalOverlaps + arbitrate.",
    );
  }

  const candDate = candidate.startISO.slice(0, 10);
  const sameDateEvents = existingEvents.filter(
    (e) => e.start.slice(0, 10) === candDate,
  );

  if (sameDateEvents.length === 0) {
    return {
      outcome: "CREATED",
      matchedEventId: null,
      sameDateEvents: [],
    };
  }

  return {
    outcome: "NEEDS_ARBITRATION",
    matchedEventId: null,
    sameDateEvents,
  };
}
