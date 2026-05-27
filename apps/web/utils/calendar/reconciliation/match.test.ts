import { describe, expect, it } from "vitest";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { decideAllDayOutcome } from "./match";

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

describe("decideAllDayOutcome — Phase 11 D-03 all-day branch", () => {
  it("returns CREATED when no existing events share the candidate's date", () => {
    const out = decideAllDayOutcome({
      candidate: {
        title: "Camping trip",
        startISO: "2026-08-14",
        isAllDay: true,
      },
      existingEvents: [allDay("evt-other-day", "Anything", "2026-05-25")],
    });
    expect(out).toEqual({
      outcome: "CREATED",
      matchedEventId: null,
      sameDateEvents: [],
    });
  });

  it("returns NEEDS_ARBITRATION when a same-date all-day event exists", () => {
    const same = allDay("evt-same-allday", "Camping trip", "2026-08-14");
    const out = decideAllDayOutcome({
      candidate: {
        title: "Camping trip",
        startISO: "2026-08-14",
        isAllDay: true,
      },
      existingEvents: [same],
    });
    expect(out.outcome).toBe("NEEDS_ARBITRATION");
    expect(out.matchedEventId).toBeNull();
    expect(out.sameDateEvents.map((e) => e.id)).toEqual(["evt-same-allday"]);
  });

  it("returns NEEDS_ARBITRATION when a same-date TIMED event exists (date-string match)", () => {
    const sameDateTimed = timed(
      "evt-timed-sameday",
      "Standup",
      "2026-08-14T14:00:00.000Z",
      "2026-08-14T14:30:00.000Z",
    );
    const out = decideAllDayOutcome({
      candidate: {
        title: "Camping trip",
        startISO: "2026-08-14",
        isAllDay: true,
      },
      existingEvents: [sameDateTimed],
    });
    expect(out.outcome).toBe("NEEDS_ARBITRATION");
    expect(out.sameDateEvents.map((e) => e.id)).toEqual(["evt-timed-sameday"]);
  });

  it("returns NEEDS_ARBITRATION with multiple same-date events when several share the date", () => {
    const a = allDay("evt-a", "Camping", "2026-08-14");
    const b = timed(
      "evt-b",
      "Drive home",
      "2026-08-14T22:00:00.000Z",
      "2026-08-14T23:30:00.000Z",
    );
    const c = allDay("evt-c-other", "Different day", "2026-08-13");
    const out = decideAllDayOutcome({
      candidate: {
        title: "Camping trip",
        startISO: "2026-08-14",
        isAllDay: true,
      },
      existingEvents: [a, b, c],
    });
    expect(out.outcome).toBe("NEEDS_ARBITRATION");
    expect(out.sameDateEvents.map((e) => e.id).sort()).toEqual([
      "evt-a",
      "evt-b",
    ]);
  });

  it("returns CREATED when only different-date events exist", () => {
    const existing = [
      allDay("evt-1", "Earlier", "2026-08-13"),
      timed(
        "evt-2",
        "Later",
        "2026-08-15T14:00:00.000Z",
        "2026-08-15T15:00:00.000Z",
      ),
    ];
    const out = decideAllDayOutcome({
      candidate: {
        title: "Camping trip",
        startISO: "2026-08-14",
        isAllDay: true,
      },
      existingEvents: existing,
    });
    expect(out).toEqual({
      outcome: "CREATED",
      matchedEventId: null,
      sameDateEvents: [],
    });
  });

  it("throws when called with a non-all-day candidate (contract violation)", () => {
    expect(() =>
      decideAllDayOutcome({
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the contract for the test
        candidate: {
          title: "Timed",
          startISO: "2026-08-14T14:00:00.000Z",
          isAllDay: false as unknown as true,
        },
        existingEvents: [],
      }),
    ).toThrow(/non-all-day candidate/);
  });
});
