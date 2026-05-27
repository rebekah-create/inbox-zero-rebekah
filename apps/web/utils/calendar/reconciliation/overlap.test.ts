import { describe, expect, it } from "vitest";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { DEFAULT_DURATION_MS, findIntervalOverlaps } from "./overlap";

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

describe("findIntervalOverlaps — D-01 strict interval intersection", () => {
  it("A: candidate 7:30-8:00pm overlaps existing 7:00-8:00pm same day", () => {
    const existing = [
      timed(
        "evt-A",
        "Music lessons",
        "2026-05-26T23:00:00.000Z",
        "2026-05-27T00:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T23:30:00.000Z",
      candidateEndISO: "2026-05-27T00:00:00.000Z",
      existingEvents: existing,
    });
    expect(out.map((e) => e.id)).toEqual(["evt-A"]);
  });

  it("B: candidate 7:30pm (no end) does NOT overlap existing 4:00-5:00pm", () => {
    const existing = [
      timed(
        "evt-B",
        "Math Class",
        "2026-05-26T20:00:00.000Z",
        "2026-05-26T21:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T23:30:00.000Z",
      candidateEndISO: null,
      existingEvents: existing,
    });
    expect(out).toEqual([]);
  });

  it("C: candidate 7:30pm (no end) overlaps existing 7:00-8:00pm via 60min default", () => {
    const existing = [
      timed(
        "evt-C",
        "Music lessons",
        "2026-05-26T23:00:00.000Z",
        "2026-05-27T00:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T23:30:00.000Z",
      candidateEndISO: null,
      existingEvents: existing,
    });
    expect(out.map((e) => e.id)).toEqual(["evt-C"]);
  });

  it("D: boundary touch — candidate 7-8pm, existing 8-9pm — no overlap (strict <)", () => {
    const existing = [
      timed(
        "evt-D",
        "Adjacent",
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T01:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T23:00:00.000Z",
      candidateEndISO: "2026-05-27T00:00:00.000Z",
      existingEvents: existing,
    });
    expect(out).toEqual([]);
  });

  it("E: existing all-day event is excluded regardless of date overlap", () => {
    const existing = [allDay("evt-E", "Camping trip", "2026-05-26")];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T15:00:00.000Z",
      candidateEndISO: "2026-05-26T16:00:00.000Z",
      existingEvents: existing,
    });
    expect(out).toEqual([]);
  });

  it("F: far-future camping candidate, no overlap with today's events", () => {
    const existing = [
      timed(
        "evt-F1",
        "Standup",
        "2026-05-26T14:00:00.000Z",
        "2026-05-26T14:30:00.000Z",
      ),
      timed(
        "evt-F2",
        "Lunch",
        "2026-05-26T16:00:00.000Z",
        "2026-05-26T17:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-08-14T18:00:00.000Z",
      candidateEndISO: "2026-08-14T22:00:00.000Z",
      existingEvents: existing,
    });
    expect(out).toEqual([]);
  });

  it("G: multiple existing events — returns only the two that overlap", () => {
    const existing = [
      timed(
        "evt-G1",
        "Overlap A",
        "2026-05-26T15:30:00.000Z",
        "2026-05-26T16:30:00.000Z",
      ),
      timed(
        "evt-G2",
        "Overlap B",
        "2026-05-26T16:45:00.000Z",
        "2026-05-26T17:30:00.000Z",
      ),
      timed(
        "evt-G3",
        "Way later",
        "2026-05-26T20:00:00.000Z",
        "2026-05-26T21:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T16:00:00.000Z",
      candidateEndISO: "2026-05-26T17:00:00.000Z",
      existingEvents: existing,
    });
    expect(out.map((e) => e.id).sort()).toEqual(["evt-G1", "evt-G2"]);
  });

  it("H: empty candidateStartISO returns []", () => {
    const existing = [
      timed(
        "evt-H",
        "Anything",
        "2026-05-26T16:00:00.000Z",
        "2026-05-26T17:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "",
      candidateEndISO: null,
      existingEvents: existing,
    });
    expect(out).toEqual([]);
  });

  it("I: unparseable candidateStartISO returns []", () => {
    const existing = [
      timed(
        "evt-I",
        "Anything",
        "2026-05-26T16:00:00.000Z",
        "2026-05-26T17:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "not-a-date",
      candidateEndISO: null,
      existingEvents: existing,
    });
    expect(out).toEqual([]);
  });

  it("J: existing event with empty end falls back to start + 60min default and overlaps", () => {
    // existing starts 7:00pm, no end -> treated as 7:00-8:00pm.
    // candidate 7:30-8:30pm overlaps that window.
    const existing: NormalizedCalendarEvent[] = [
      {
        id: "evt-J",
        title: "End-missing",
        description: null,
        location: null,
        start: "2026-05-26T23:00:00.000Z",
        end: "",
        isAllDay: false,
        attendees: [],
        htmlLink: "",
      },
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T23:30:00.000Z",
      candidateEndISO: "2026-05-27T00:30:00.000Z",
      existingEvents: existing,
    });
    expect(out.map((e) => e.id)).toEqual(["evt-J"]);
  });

  it("skips existing events whose start is unparseable, without throwing", () => {
    const existing: NormalizedCalendarEvent[] = [
      {
        id: "evt-bad",
        title: "Bad",
        description: null,
        location: null,
        start: "garbage",
        end: "garbage",
        isAllDay: false,
        attendees: [],
        htmlLink: "",
      },
      timed(
        "evt-good",
        "Good",
        "2026-05-26T16:00:00.000Z",
        "2026-05-26T17:00:00.000Z",
      ),
    ];
    const out = findIntervalOverlaps({
      candidateStartISO: "2026-05-26T16:30:00.000Z",
      candidateEndISO: "2026-05-26T17:30:00.000Z",
      existingEvents: existing,
    });
    expect(out.map((e) => e.id)).toEqual(["evt-good"]);
  });

  it("exports DEFAULT_DURATION_MS = 60 minutes", () => {
    expect(DEFAULT_DURATION_MS).toBe(60 * 60 * 1000);
  });
});
