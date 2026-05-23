import { describe, it, expect } from "vitest";
import { decideOutcome } from "./match";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";

/**
 * Helper to build a timed NormalizedCalendarEvent fixture.
 * The real shape has `start: string` (RFC3339 for timed, "YYYY-MM-DD" for all-day)
 * — NOT the `{ dateTime, date }` object shape the plan's interfaces block sketches.
 * See apps/web/utils/calendar/upcoming-events-types.ts for the canonical shape.
 */
const timed = (
  id: string,
  title: string,
  startISO: string,
  endISO: string,
): NormalizedCalendarEvent => ({
  id,
  title,
  description: null,
  location: null,
  start: startISO,
  end: endISO,
  isAllDay: false,
  attendees: [],
  htmlLink: "",
});

const allDay = (
  id: string,
  title: string,
  date: string,
): NormalizedCalendarEvent => ({
  id,
  title,
  description: null,
  location: null,
  start: date,
  end: date,
  isAllDay: true,
  attendees: [],
  htmlLink: "",
});

describe("decideOutcome — D-06 four-step decision tree", () => {
  it("step 1: returns MATCHED when title_sim >= 0.7 AND time within ±60min", () => {
    const existing = [
      timed(
        "evt-1",
        "Dr Jones",
        "2026-05-25T15:00:00-04:00",
        "2026-05-25T16:00:00-04:00",
      ),
    ];
    const out = decideOutcome({
      candidate: {
        title: "Dr Jones cleaning",
        startISO: "2026-05-25T15:30:00-04:00",
        isAllDay: false,
      },
      existingEvents: existing,
    });
    expect(out).toEqual({ outcome: "MATCHED", matchedEventId: "evt-1" });
  });

  it("step 2: returns AMBIGUOUS (reschedule, REC-06) when title_sim >= 0.7 but time differs > 60min", () => {
    const existing = [
      timed(
        "evt-2",
        "Dr Jones",
        "2026-05-25T15:00:00-04:00",
        "2026-05-25T16:00:00-04:00",
      ),
    ];
    const out = decideOutcome({
      candidate: {
        title: "Dr Jones",
        startISO: "2026-05-26T15:00:00-04:00",
        isAllDay: false,
      },
      existingEvents: existing,
    });
    expect(out).toEqual({ outcome: "AMBIGUOUS", matchedEventId: "evt-2" });
  });

  it("step 3: returns AMBIGUOUS (near-match) when same-day AND 0.4 <= title_sim < 0.7", () => {
    // "Dr Jones cleaning" vs "Dr cleaning appointment" -> tokens overlap {Dr, cleaning} = 2;
    // 2*2 / (3+3) = 0.667 (within [0.4, 0.7) band).
    const existing = [
      timed(
        "evt-3",
        "Dr Jones cleaning",
        "2026-05-25T10:00:00-04:00",
        "2026-05-25T11:00:00-04:00",
      ),
    ];
    const out = decideOutcome({
      candidate: {
        title: "Dr cleaning appointment",
        startISO: "2026-05-25T16:00:00-04:00",
        isAllDay: false,
      },
      existingEvents: existing,
    });
    expect(out).toEqual({ outcome: "AMBIGUOUS", matchedEventId: "evt-3" });
  });

  it("step 4: returns CREATED when existing list is empty", () => {
    const out = decideOutcome({
      candidate: {
        title: "Anything",
        startISO: "2026-05-25T10:00:00-04:00",
        isAllDay: false,
      },
      existingEvents: [],
    });
    expect(out).toEqual({ outcome: "CREATED", matchedEventId: null });
  });

  it("step 4: returns CREATED for unrelated existing events", () => {
    const existing = [
      timed(
        "evt-4",
        "Camping trip",
        "2026-05-26T08:00:00-04:00",
        "2026-05-26T20:00:00-04:00",
      ),
    ];
    const out = decideOutcome({
      candidate: {
        title: "Doctor visit",
        startISO: "2026-05-29T09:00:00-04:00",
        isAllDay: false,
      },
      existingEvents: existing,
    });
    expect(out).toEqual({ outcome: "CREATED", matchedEventId: null });
  });

  it("D-08 all-day: returns MATCHED when date string + title match", () => {
    const existing = [allDay("evt-5", "Camping trip", "2026-05-25")];
    const out = decideOutcome({
      candidate: {
        title: "Camping trip",
        startISO: "2026-05-25",
        isAllDay: true,
      },
      existingEvents: existing,
    });
    expect(out).toEqual({ outcome: "MATCHED", matchedEventId: "evt-5" });
  });

  it("D-08 all-day: returns CREATED when date strings differ", () => {
    const existing = [allDay("evt-6", "Camping trip", "2026-05-25")];
    const out = decideOutcome({
      candidate: {
        title: "Camping trip",
        startISO: "2026-05-26",
        isAllDay: true,
      },
      existingEvents: existing,
    });
    expect(out).toEqual({ outcome: "CREATED", matchedEventId: null });
  });
});
