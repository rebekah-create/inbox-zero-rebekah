import { describe, expect, it } from "vitest";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { windowToday, windowTomorrow } from "./window";

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

// Fixed "now" — 2026-05-20T13:00:00Z = 09:00 EDT on 2026-05-20 (mid-May, DST-stable).
const NOW = new Date("2026-05-20T13:00:00Z");

describe("windowToday — D-04 Today window", () => {
  it("includes a timed event happening later today (10am–11am ET)", () => {
    const events = [
      timed(
        "e1",
        "Standup",
        "2026-05-20T14:00:00Z", // 10:00 EDT
        "2026-05-20T15:00:00Z", // 11:00 EDT
      ),
    ];
    expect(windowToday({ events, now: NOW }).map((e) => e.id)).toEqual(["e1"]);
  });

  it("excludes a timed event whose end is in the past (8am–8:45am ET)", () => {
    const events = [
      timed(
        "e1",
        "Early call",
        "2026-05-20T12:00:00Z", // 08:00 EDT
        "2026-05-20T12:45:00Z", // 08:45 EDT — before NOW (09:00 EDT)
      ),
    ];
    expect(windowToday({ events, now: NOW })).toEqual([]);
  });

  it("includes an all-day event whose date matches today ET", () => {
    const events = [allDay("e1", "Holiday", "2026-05-20")];
    expect(windowToday({ events, now: NOW }).map((e) => e.id)).toEqual(["e1"]);
  });

  it("excludes an all-day event for tomorrow", () => {
    const events = [allDay("e1", "Tomorrow holiday", "2026-05-21")];
    expect(windowToday({ events, now: NOW })).toEqual([]);
  });

  it("sorts results ascending by start", () => {
    const events = [
      timed("late", "Late", "2026-05-20T20:00:00Z", "2026-05-20T21:00:00Z"),
      timed("mid", "Mid", "2026-05-20T16:00:00Z", "2026-05-20T17:00:00Z"),
      timed("early", "Early", "2026-05-20T14:00:00Z", "2026-05-20T15:00:00Z"),
    ];
    expect(windowToday({ events, now: NOW }).map((e) => e.id)).toEqual([
      "early",
      "mid",
      "late",
    ]);
  });
});

describe("windowTomorrow — full ET-day tomorrow window", () => {
  it("includes a timed event tomorrow morning (7am–8am ET)", () => {
    const events = [
      timed(
        "e1",
        "Run",
        "2026-05-21T11:00:00Z", // 07:00 EDT on 2026-05-21
        "2026-05-21T12:00:00Z", // 08:00 EDT
      ),
    ];
    expect(windowTomorrow({ events, now: NOW }).map((e) => e.id)).toEqual([
      "e1",
    ]);
  });

  it("includes a timed event tomorrow afternoon (1pm–2pm ET) — full-day window", () => {
    const events = [
      timed(
        "e1",
        "Afternoon",
        "2026-05-21T17:00:00Z", // 13:00 EDT
        "2026-05-21T18:00:00Z", // 14:00 EDT
      ),
    ];
    expect(windowTomorrow({ events, now: NOW }).map((e) => e.id)).toEqual([
      "e1",
    ]);
  });

  it("includes a timed event tomorrow evening (8pm–9pm ET)", () => {
    const events = [
      timed(
        "ninja",
        "Ninja class",
        "2026-05-22T00:30:00Z", // 20:30 EDT on 2026-05-21
        "2026-05-22T01:30:00Z", // 21:30 EDT on 2026-05-21
      ),
    ];
    expect(windowTomorrow({ events, now: NOW }).map((e) => e.id)).toEqual([
      "ninja",
    ]);
  });

  it("excludes a timed event for two days from now", () => {
    const events = [
      timed(
        "twoday",
        "Two days out",
        "2026-05-22T15:00:00Z",
        "2026-05-22T16:00:00Z",
      ),
    ];
    expect(windowTomorrow({ events, now: NOW })).toEqual([]);
  });

  it("includes an all-day event whose date matches tomorrow ET", () => {
    const events = [allDay("e1", "Memorial Day", "2026-05-21")];
    expect(windowTomorrow({ events, now: NOW }).map((e) => e.id)).toEqual([
      "e1",
    ]);
  });

  it("sorts results: all-day first, then timed ascending by start", () => {
    const events = [
      timed("late", "Late", "2026-05-21T22:00:00Z", "2026-05-21T23:00:00Z"),
      allDay("ad", "All-day", "2026-05-21"),
      timed("early", "Early", "2026-05-21T11:00:00Z", "2026-05-21T12:00:00Z"),
    ];
    expect(windowTomorrow({ events, now: NOW }).map((e) => e.id)).toEqual([
      "ad",
      "early",
      "late",
    ]);
  });
});
