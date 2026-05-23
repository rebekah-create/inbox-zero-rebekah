import { describe, expect, it } from "vitest";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { detectOverlaps } from "./overlap";

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

describe("detectOverlaps — D-08 strict interval", () => {
  it("returns empty map when no events overlap", () => {
    const events = [
      timed("a", "Morning", "2026-05-20T14:00:00Z", "2026-05-20T15:00:00Z"),
      timed("b", "Afternoon", "2026-05-20T18:00:00Z", "2026-05-20T19:00:00Z"),
    ];
    expect(detectOverlaps({ events }).size).toBe(0);
  });

  it("detects two overlapping timed events as siblings of each other", () => {
    const events = [
      timed("a", "Standup", "2026-05-20T14:00:00Z", "2026-05-20T15:00:00Z"),
      timed("b", "Review", "2026-05-20T14:30:00Z", "2026-05-20T15:30:00Z"),
    ];
    const out = detectOverlaps({ events });
    expect(out.get("a")).toEqual(["b"]);
    expect(out.get("b")).toEqual(["a"]);
  });

  it("excludes all-day events from overlap detection (D-08)", () => {
    const events = [
      allDay("ad", "Birthday", "2026-05-20"),
      timed("a", "Standup", "2026-05-20T14:00:00Z", "2026-05-20T15:00:00Z"),
    ];
    const out = detectOverlaps({ events });
    expect(out.size).toBe(0);
    expect(out.has("ad")).toBe(false);
    expect(out.has("a")).toBe(false);
  });

  it("does NOT flag back-to-back events as overlapping (D-08)", () => {
    const events = [
      timed("a", "Block 1", "2026-05-20T14:00:00Z", "2026-05-20T15:00:00Z"),
      timed("b", "Block 2", "2026-05-20T15:00:00Z", "2026-05-20T16:00:00Z"),
    ];
    expect(detectOverlaps({ events }).size).toBe(0);
  });

  it("detects three-way overlap (each event lists other two as siblings)", () => {
    const events = [
      timed("a", "A", "2026-05-20T14:00:00Z", "2026-05-20T15:30:00Z"),
      timed("b", "B", "2026-05-20T14:15:00Z", "2026-05-20T15:00:00Z"),
      timed("c", "C", "2026-05-20T14:30:00Z", "2026-05-20T15:15:00Z"),
    ];
    const out = detectOverlaps({ events });
    expect(out.get("a")?.sort()).toEqual(["b", "c"]);
    expect(out.get("b")?.sort()).toEqual(["a", "c"]);
    expect(out.get("c")?.sort()).toEqual(["a", "b"]);
  });

  it("treats half-open intervals correctly (event ending exactly at another's start does not overlap)", () => {
    const events = [
      timed("a", "A", "2026-05-20T14:00:00Z", "2026-05-20T15:00:00Z"),
      // Starts exactly when 'a' ends — half-open [start,end), so no overlap.
      timed("b", "B", "2026-05-20T15:00:00Z", "2026-05-20T16:00:00Z"),
      // Genuinely overlaps 'a'.
      timed("c", "C", "2026-05-20T14:30:00Z", "2026-05-20T14:45:00Z"),
    ];
    const out = detectOverlaps({ events });
    expect(out.get("a")).toEqual(["c"]);
    expect(out.get("c")).toEqual(["a"]);
    expect(out.has("b")).toBe(false);
  });
});
