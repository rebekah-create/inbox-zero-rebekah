import { describe, expect, it } from "vitest";
import { formatAgendaRange, formatAgendaTime } from "./format-time";

describe("formatAgendaTime — D-07 single-letter am/pm", () => {
  it("returns '9:00a' for 9 AM ET (timed)", () => {
    // 2026-05-23T13:00:00Z = 09:00 EDT (America/New_York is in EDT in May)
    expect(
      formatAgendaTime({ iso: "2026-05-23T13:00:00Z", isAllDay: false }),
    ).toBe("9:00a");
  });

  it("returns '12:00p' for noon ET", () => {
    // 2026-05-23T16:00:00Z = 12:00 EDT
    expect(
      formatAgendaTime({ iso: "2026-05-23T16:00:00Z", isAllDay: false }),
    ).toBe("12:00p");
  });

  it("returns '12:30a' for 12:30 AM ET", () => {
    // 2026-05-23T04:30:00Z = 00:30 EDT
    expect(
      formatAgendaTime({ iso: "2026-05-23T04:30:00Z", isAllDay: false }),
    ).toBe("12:30a");
  });

  it("returns '2:30p' for 2:30 PM ET", () => {
    // 2026-05-23T18:30:00Z = 14:30 EDT
    expect(
      formatAgendaTime({ iso: "2026-05-23T18:30:00Z", isAllDay: false }),
    ).toBe("2:30p");
  });

  it("returns 'All day' for all-day events", () => {
    expect(formatAgendaTime({ iso: "2026-05-23", isAllDay: true })).toBe(
      "All day",
    );
  });
});

describe("formatAgendaRange — D-06 / D-07", () => {
  it("returns 'All day' when isAllDay", () => {
    expect(
      formatAgendaRange({
        startIso: "2026-05-23",
        endIso: "2026-05-23",
        isAllDay: true,
      }),
    ).toBe("All day");
  });

  it("returns just start time when start equals end (D-06)", () => {
    expect(
      formatAgendaRange({
        startIso: "2026-05-23T13:00:00Z",
        endIso: "2026-05-23T13:00:00Z",
        isAllDay: false,
      }),
    ).toBe("9:00a");
  });

  it("returns 'h:mma–h:mma' for same-day range", () => {
    expect(
      formatAgendaRange({
        startIso: "2026-05-23T13:00:00Z", // 9:00a EDT
        endIso: "2026-05-23T14:00:00Z", // 10:00a EDT
        isAllDay: false,
      }),
    ).toBe("9:00a–10:00a");
  });

  it("appends '(tonight)' when end is on the next ET calendar day (D-07 cross-midnight)", () => {
    expect(
      formatAgendaRange({
        startIso: "2026-05-24T01:00:00Z", // 21:00 EDT on 2026-05-23
        endIso: "2026-05-24T04:30:00Z", // 00:30 EDT on 2026-05-24
        isAllDay: false,
      }),
    ).toBe("9:00p–12:30a (tonight)");
  });
});
