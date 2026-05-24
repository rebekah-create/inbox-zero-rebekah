import { describe, expect, it } from "vitest";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { buildAgenda } from "./build-agenda";

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

// Fixed "now" — 2026-05-20T13:00:00Z = 09:00 EDT on 2026-05-20.
const NOW = new Date("2026-05-20T13:00:00Z");

describe("buildAgenda — Today section", () => {
  it("populates today with two timed events sorted by start and overlap pill correct", () => {
    const events = [
      // 10:00-11:30 EDT
      timed("a", "Standup", "2026-05-20T14:00:00Z", "2026-05-20T15:30:00Z"),
      // 11:00-12:00 EDT (overlaps with a)
      timed("b", "Sync", "2026-05-20T15:00:00Z", "2026-05-20T16:00:00Z"),
    ];
    const block = buildAgenda({ events, now: NOW });
    expect(block.today.map((i) => i.id)).toEqual(["a", "b"]);
    expect(block.today.find((i) => i.id === "a")?.overlapWith).toEqual(["b"]);
    expect(block.today.find((i) => i.id === "b")?.overlapWith).toEqual(["a"]);
    expect(block.todayFallback).toBeNull();
  });

  it("emits the D-05 todayFallback verbatim when today is empty", () => {
    const block = buildAgenda({ events: [], now: NOW });
    expect(block.today).toEqual([]);
    expect(block.todayFallback).toBe("Nothing else on the calendar today.");
  });

  it("renders all-day items with time='All day' and endTime=null and puts them first", () => {
    const events = [
      timed("t1", "Standup", "2026-05-20T14:00:00Z", "2026-05-20T15:00:00Z"),
      allDay("ad", "Holiday", "2026-05-20"),
    ];
    const block = buildAgenda({ events, now: NOW });
    expect(block.today.map((i) => i.id)).toEqual(["ad", "t1"]);
    const adItem = block.today[0]!;
    expect(adItem.time).toBe("All day");
    expect(adItem.endTime).toBeNull();
    expect(adItem.isAllDay).toBe(true);
  });

  it("sorts multiple all-day items alphabetically by title", () => {
    const events = [
      allDay("z", "Zoo trip", "2026-05-20"),
      allDay("a", "Anniversary", "2026-05-20"),
      allDay("m", "Marathon", "2026-05-20"),
    ];
    const block = buildAgenda({ events, now: NOW });
    expect(block.today.map((i) => i.title)).toEqual([
      "Anniversary",
      "Marathon",
      "Zoo trip",
    ]);
  });
});

describe("buildAgenda — Tomorrow section (full day)", () => {
  it("includes an afternoon event tomorrow — no morning/extender split", () => {
    // Tomorrow 14:00 EDT (afternoon) -> 2026-05-21T18:00:00Z
    const events = [
      timed(
        "after",
        "Afternoon mtg",
        "2026-05-21T18:00:00Z",
        "2026-05-21T19:00:00Z",
      ),
    ];
    const block = buildAgenda({ events, now: NOW });
    expect(block.tomorrow.map((i) => i.id)).toEqual(["after"]);
    expect(block.tomorrowFallback).toBeNull();
  });

  it("includes an evening event tomorrow (e.g. Ninja class 5pm)", () => {
    const events = [
      timed(
        "ninja",
        "Ninja class",
        "2026-05-21T21:00:00Z", // 17:00 EDT
        "2026-05-21T22:00:00Z", // 18:00 EDT
      ),
    ];
    const block = buildAgenda({ events, now: NOW });
    expect(block.tomorrow.map((i) => i.title)).toEqual(["Ninja class"]);
    expect(block.tomorrowFallback).toBeNull();
  });

  it("emits 'Nothing on the calendar tomorrow.' when truly empty", () => {
    const block = buildAgenda({ events: [], now: NOW });
    expect(block.tomorrow).toEqual([]);
    expect(block.tomorrowFallback).toBe("Nothing on the calendar tomorrow.");
  });

  it("renders an all-day event (Memorial Day) at the top with time='All day'", () => {
    const events = [
      allDay("md", "Memorial Day", "2026-05-21"),
      timed(
        "ninja",
        "Ninja class",
        "2026-05-21T21:00:00Z",
        "2026-05-21T22:00:00Z",
      ),
    ];
    const block = buildAgenda({ events, now: NOW });
    expect(block.tomorrow.map((i) => i.title)).toEqual([
      "Memorial Day",
      "Ninja class",
    ]);
    expect(block.tomorrow[0]!.time).toBe("All day");
    expect(block.tomorrow[0]!.isAllDay).toBe(true);
    expect(block.tomorrowFallback).toBeNull();
  });
});
