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

describe("buildAgenda — Tomorrow morning section + D-05 extender", () => {
  it("emits the extender fallback when morning empty but afternoon event exists tomorrow", () => {
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
    expect(block.tomorrowMorning).toEqual([]);
    // formatAgendaTime("2026-05-21T18:00:00Z", false) -> "2:00p"
    expect(block.tomorrowMorningFallback).toBe(
      "Nothing before noon; first thing is 2:00p Afternoon mtg.",
    );
  });

  it("emits the D-05 'Nothing on the calendar tomorrow.' fallback when no events all day tomorrow", () => {
    const block = buildAgenda({ events: [], now: NOW });
    expect(block.tomorrowMorning).toEqual([]);
    expect(block.tomorrowMorningFallback).toBe(
      "Nothing on the calendar tomorrow.",
    );
  });

  it("clears tomorrowMorningFallback when morning has events", () => {
    const events = [
      // Tomorrow 07:00-08:00 EDT
      timed("run", "Run", "2026-05-21T11:00:00Z", "2026-05-21T12:00:00Z"),
    ];
    const block = buildAgenda({ events, now: NOW });
    expect(block.tomorrowMorning.map((i) => i.id)).toEqual(["run"]);
    expect(block.tomorrowMorningFallback).toBeNull();
  });
});
