import { describe, it, expect } from "vitest";
import { findTimeOverlaps } from "./arbitrate";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";

const timed = (
  id: string,
  title: string,
  startISO: string,
): NormalizedCalendarEvent => ({
  id,
  title,
  description: null,
  location: null,
  start: startISO,
  end: startISO,
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

const WINDOW = 60 * 60 * 1000;

describe("findTimeOverlaps", () => {
  it("returns events whose start is within the window", () => {
    const events = [
      timed("a", "Madi Art class", "2026-05-26T16:30:00Z"),
      timed("b", "Bekah therapy", "2026-05-26T17:00:00Z"),
      timed("c", "Far future event", "2026-05-26T20:00:00Z"),
    ];

    const overlaps = findTimeOverlaps({
      candidateStartISO: "2026-05-26T16:30:00Z",
      existingEvents: events,
      windowMs: WINDOW,
    });

    expect(overlaps.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("treats the exact boundary as included", () => {
    const events = [
      timed("on-edge", "Edge", "2026-05-26T17:30:00Z"), // exactly +60min
    ];

    const overlaps = findTimeOverlaps({
      candidateStartISO: "2026-05-26T16:30:00Z",
      existingEvents: events,
      windowMs: WINDOW,
    });

    expect(overlaps.map((e) => e.id)).toEqual(["on-edge"]);
  });

  it("skips all-day existing events", () => {
    const events = [
      allDay("all-day", "Holiday", "2026-05-26"),
      timed("timed", "Real one", "2026-05-26T17:00:00Z"),
    ];

    const overlaps = findTimeOverlaps({
      candidateStartISO: "2026-05-26T16:30:00Z",
      existingEvents: events,
      windowMs: WINDOW,
    });

    expect(overlaps.map((e) => e.id)).toEqual(["timed"]);
  });

  it("returns empty when candidate has no resolvable start", () => {
    const events = [timed("a", "Anything", "2026-05-26T16:30:00Z")];

    expect(
      findTimeOverlaps({
        candidateStartISO: "",
        existingEvents: events,
        windowMs: WINDOW,
      }),
    ).toEqual([]);
  });

  it("returns empty when no existing events fall in the window", () => {
    const events = [timed("far", "Tomorrow", "2026-05-27T16:30:00Z")];

    expect(
      findTimeOverlaps({
        candidateStartISO: "2026-05-26T16:30:00Z",
        existingEvents: events,
        windowMs: WINDOW,
      }),
    ).toEqual([]);
  });

  it("ignores existing events with unparseable start strings", () => {
    const events = [
      { ...timed("ok", "ok", "2026-05-26T16:30:00Z") },
      { ...timed("bad", "bad", "not-a-date") },
    ];

    const overlaps = findTimeOverlaps({
      candidateStartISO: "2026-05-26T16:30:00Z",
      existingEvents: events,
      windowMs: WINDOW,
    });

    expect(overlaps.map((e) => e.id)).toEqual(["ok"]);
  });
});
