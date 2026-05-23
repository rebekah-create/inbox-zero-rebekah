import type { calendar_v3 } from "@googleapis/calendar";
import { describe, expect, it } from "vitest";
import {
  hasStartAndEnd,
  isExcluded,
  normalize,
  pastPrune,
} from "./upcoming-events-helpers";
import type { NormalizedCalendarEvent } from "./upcoming-events-types";

// Helper to build minimal Schema$Event fixtures.
function makeEvent(
  overrides: Partial<calendar_v3.Schema$Event> = {},
): calendar_v3.Schema$Event {
  return {
    id: "evt-1",
    summary: "Test event",
    start: { dateTime: "2026-05-25T15:00:00-04:00" },
    end: { dateTime: "2026-05-25T16:00:00-04:00" },
    htmlLink: "https://calendar.google.com/event?eid=abc",
    ...overrides,
  };
}

describe("isExcluded", () => {
  it("returns true when self attendee declined", () => {
    const event = makeEvent({
      attendees: [{ self: true, responseStatus: "declined" }],
    });
    expect(isExcluded(event)).toBe(true);
  });

  it("returns true when self attendee is tentative", () => {
    const event = makeEvent({
      attendees: [{ self: true, responseStatus: "tentative" }],
    });
    expect(isExcluded(event)).toBe(true);
  });

  it("returns false when self attendee accepted", () => {
    const event = makeEvent({
      attendees: [{ self: true, responseStatus: "accepted" }],
    });
    expect(isExcluded(event)).toBe(false);
  });

  it("returns false when self attendee needsAction", () => {
    const event = makeEvent({
      attendees: [{ self: true, responseStatus: "needsAction" }],
    });
    expect(isExcluded(event)).toBe(false);
  });

  it("returns false when no self attendee row exists (other declined)", () => {
    const event = makeEvent({
      attendees: [{ email: "other@x.com", responseStatus: "declined" }],
    });
    expect(isExcluded(event)).toBe(false);
  });

  it("returns false for empty attendees array (owner-created)", () => {
    const event = makeEvent({ attendees: [] });
    expect(isExcluded(event)).toBe(false);
  });

  it("returns false when attendees is undefined (owner-created)", () => {
    const event = makeEvent({ attendees: undefined });
    expect(isExcluded(event)).toBe(false);
  });

  it("returns false when self is accepted even if another attendee declined", () => {
    const event = makeEvent({
      attendees: [
        { self: true, responseStatus: "accepted" },
        { email: "other@x.com", responseStatus: "declined" },
      ],
    });
    expect(isExcluded(event)).toBe(false);
  });
});

describe("normalize", () => {
  it("normalizes a timed event preserving RFC3339 strings", () => {
    const event = makeEvent({
      id: "timed-1",
      summary: "Doctor",
      start: { dateTime: "2026-05-25T15:00:00-04:00" },
      end: { dateTime: "2026-05-25T16:00:00-04:00" },
    });
    const n = normalize(event);
    expect(n.isAllDay).toBe(false);
    expect(n.start).toBe("2026-05-25T15:00:00-04:00");
    expect(n.end).toBe("2026-05-25T16:00:00-04:00");
    expect(n.id).toBe("timed-1");
    expect(n.title).toBe("Doctor");
  });

  it("normalizes an all-day event preserving YYYY-MM-DD strings", () => {
    const event = makeEvent({
      id: "allday-1",
      summary: "Camping",
      start: { date: "2026-05-25" },
      end: { date: "2026-05-26" },
    });
    const n = normalize(event);
    expect(n.isAllDay).toBe(true);
    expect(n.start).toBe("2026-05-25");
    expect(n.end).toBe("2026-05-26");
    // Critical: must remain a string, never wrapped in Date.
    expect(typeof n.start).toBe("string");
    expect(typeof n.end).toBe("string");
  });

  it("defaults missing summary to 'Untitled'", () => {
    const event = makeEvent({ summary: undefined });
    expect(normalize(event).title).toBe("Untitled");
  });

  it("defaults missing location to null (not undefined)", () => {
    const event = makeEvent({ location: undefined });
    const n = normalize(event);
    expect(n.location).toBeNull();
  });

  it("defaults missing description to null", () => {
    const event = makeEvent({ description: undefined });
    expect(normalize(event).description).toBeNull();
  });

  it("filters attendees missing email and returns only string emails", () => {
    const event = makeEvent({
      attendees: [
        { email: "a@x.com", responseStatus: "accepted" },
        { email: null, responseStatus: "needsAction" },
        { email: undefined },
        { email: "b@x.com", self: true, responseStatus: "accepted" },
      ],
    });
    const n = normalize(event);
    expect(n.attendees).toEqual(["a@x.com", "b@x.com"]);
  });

  it("defaults missing htmlLink to empty string", () => {
    const event = makeEvent({ htmlLink: undefined });
    expect(normalize(event).htmlLink).toBe("");
  });

  it("returns empty attendees array when attendees missing", () => {
    const event = makeEvent({ attendees: undefined });
    expect(normalize(event).attendees).toEqual([]);
  });

  it("throws when event has neither dateTime nor date on start/end (WR-01)", () => {
    const event = makeEvent({ start: {}, end: {} });
    expect(() => normalize(event)).toThrow(/missing start or end/);
  });

  it("throws when event has start but no end (WR-01)", () => {
    const event = makeEvent({
      start: { dateTime: "2026-05-25T15:00:00-04:00" },
      end: {},
    });
    expect(() => normalize(event)).toThrow(/missing start or end/);
  });
});

describe("hasStartAndEnd", () => {
  it("returns true for a timed event with both dateTime fields", () => {
    expect(hasStartAndEnd(makeEvent())).toBe(true);
  });

  it("returns true for an all-day event with both date fields", () => {
    const event = makeEvent({
      start: { date: "2026-05-25" },
      end: { date: "2026-05-26" },
    });
    expect(hasStartAndEnd(event)).toBe(true);
  });

  it("returns false when start has neither dateTime nor date", () => {
    const event = makeEvent({ start: {}, end: { dateTime: "x" } });
    expect(hasStartAndEnd(event)).toBe(false);
  });

  it("returns false when end is missing", () => {
    const event = makeEvent({ end: {} });
    expect(hasStartAndEnd(event)).toBe(false);
  });
});

describe("pastPrune", () => {
  // Fixed "now" used by all pastPrune tests.
  const now = new Date("2026-05-22T12:00:00-04:00");
  // For all-day comparisons, the helper uses now.toISOString().slice(0,10).
  // 2026-05-22T12:00:00-04:00 → 2026-05-22T16:00:00Z → todayString "2026-05-22".

  function timedEvent(endIso: string, id = "t"): NormalizedCalendarEvent {
    return {
      id,
      title: "T",
      start: "2026-05-22T09:00:00-04:00",
      end: endIso,
      isAllDay: false,
      location: null,
      description: null,
      attendees: [],
      htmlLink: "",
    };
  }

  function allDayEvent(endDate: string, id = "a"): NormalizedCalendarEvent {
    return {
      id,
      title: "A",
      start: "2026-05-22",
      end: endDate,
      isAllDay: true,
      location: null,
      description: null,
      attendees: [],
      htmlLink: "",
    };
  }

  it("drops a timed event whose end is strictly before now", () => {
    const e = timedEvent("2026-05-22T10:00:00-04:00", "past-timed");
    expect(pastPrune([e], now)).toEqual([]);
  });

  it("keeps a timed event whose end is after now", () => {
    const e = timedEvent("2026-05-22T14:00:00-04:00", "future-timed");
    expect(pastPrune([e], now).map((x) => x.id)).toEqual(["future-timed"]);
  });

  it("keeps a timed event whose end equals now (boundary kept, predicate is end < now)", () => {
    const e = timedEvent("2026-05-22T12:00:00-04:00", "boundary");
    expect(pastPrune([e], now).map((x) => x.id)).toEqual(["boundary"]);
  });

  it("keeps an all-day event whose end-date equals today's local date string", () => {
    const e = allDayEvent("2026-05-22", "today-allday");
    expect(pastPrune([e], now).map((x) => x.id)).toEqual(["today-allday"]);
  });

  it("drops an all-day event whose end-date is before today's local date string", () => {
    const e = allDayEvent("2026-05-21", "yesterday-allday");
    expect(pastPrune([e], now)).toEqual([]);
  });

  it("keeps a future all-day event", () => {
    const e = allDayEvent("2026-05-25", "future-allday");
    expect(pastPrune([e], now).map((x) => x.id)).toEqual(["future-allday"]);
  });

  it("drops a timed event whose end is 1ms before now (IN-04)", () => {
    const endIso = new Date(now.getTime() - 1).toISOString();
    const e = timedEvent(endIso, "just-past");
    expect(pastPrune([e], now)).toEqual([]);
  });

  it("keeps a timed event whose end is 1ms after now (IN-04)", () => {
    const endIso = new Date(now.getTime() + 1).toISOString();
    const e = timedEvent(endIso, "just-future");
    expect(pastPrune([e], now).map((x) => x.id)).toEqual(["just-future"]);
  });

  it("respects explicit todayLocalDate for all-day comparison (WR-02)", () => {
    // now is 2026-05-22T12:00:00-04:00 → UTC date is 2026-05-22.
    // Pretend the user-local date is one day ahead: 2026-05-23.
    const e = allDayEvent("2026-05-22", "today-in-utc");
    // With the user-local date 2026-05-23, the 2026-05-22 all-day event is past.
    expect(pastPrune([e], now, "2026-05-23")).toEqual([]);
    // Without the override (UTC fallback), it remains kept.
    expect(pastPrune([e], now).map((x) => x.id)).toEqual(["today-in-utc"]);
  });

  it("handles a mix of past, present, and future events", () => {
    const events = [
      timedEvent("2026-05-22T10:00:00-04:00", "past-timed"),
      timedEvent("2026-05-22T14:00:00-04:00", "future-timed"),
      allDayEvent("2026-05-21", "past-allday"),
      allDayEvent("2026-05-25", "future-allday"),
    ];
    const kept = pastPrune(events, now)
      .map((e) => e.id)
      .sort();
    expect(kept).toEqual(["future-allday", "future-timed"]);
  });
});
