import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/parse/calender-event", () => ({
  analyzeCalendarEvent: vi.fn(),
  hasIcsAttachment: vi.fn(),
}));

import {
  analyzeCalendarEvent,
  hasIcsAttachment,
} from "@/utils/parse/calender-event";
import type { ParsedMessage } from "@/utils/types";
import { extractFromIcs } from "./ics-path";

const FAKE_MESSAGE = {} as ParsedMessage;

beforeEach(() => {
  vi.mocked(analyzeCalendarEvent).mockReset();
  vi.mocked(hasIcsAttachment).mockReset();
});

describe("extractFromIcs", () => {
  it("returns null when the message has no .ics attachment", () => {
    vi.mocked(hasIcsAttachment).mockReturnValue(false);
    expect(extractFromIcs(FAKE_MESSAGE)).toBeNull();
    expect(analyzeCalendarEvent).not.toHaveBeenCalled();
  });

  it("returns a CandidateEvent-shaped object for a timed .ics event", () => {
    vi.mocked(hasIcsAttachment).mockReturnValue(true);
    vi.mocked(analyzeCalendarEvent).mockReturnValue({
      isCalendarEvent: true,
      eventDate: new Date(Date.UTC(2026, 5, 1, 15, 0, 0)),
      endDate: new Date(Date.UTC(2026, 5, 1, 16, 0, 0)),
      eventTitle: "Dental",
    });

    const result = extractFromIcs(FAKE_MESSAGE);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Dental");
    expect(result?.startISO).toBe(
      new Date(Date.UTC(2026, 5, 1, 15, 0, 0)).toISOString(),
    );
    expect(result?.endISO).toBe(
      new Date(Date.UTC(2026, 5, 1, 16, 0, 0)).toISOString(),
    );
    expect(result?.location).toBeNull();
    expect(result?.attendees).toEqual([]);
    expect(result?.confidence).toBe(1.0);
  });

  it("returns null when analyzeCalendarEvent says it is not a calendar event", () => {
    vi.mocked(hasIcsAttachment).mockReturnValue(true);
    vi.mocked(analyzeCalendarEvent).mockReturnValue({
      isCalendarEvent: false,
    });
    expect(extractFromIcs(FAKE_MESSAGE)).toBeNull();
  });

  it("returns null when analyzeCalendarEvent has no eventDate", () => {
    vi.mocked(hasIcsAttachment).mockReturnValue(true);
    vi.mocked(analyzeCalendarEvent).mockReturnValue({
      isCalendarEvent: true,
      // no eventDate
    });
    expect(extractFromIcs(FAKE_MESSAGE)).toBeNull();
  });

  it("sets isAllDay: true for a date-only .ics event (midnight UTC + 24h delta)", () => {
    vi.mocked(hasIcsAttachment).mockReturnValue(true);
    vi.mocked(analyzeCalendarEvent).mockReturnValue({
      isCalendarEvent: true,
      eventDate: new Date(Date.UTC(2026, 5, 1, 0, 0, 0)),
      endDate: new Date(Date.UTC(2026, 5, 2, 0, 0, 0)),
      eventTitle: "Holiday",
    });
    const result = extractFromIcs(FAKE_MESSAGE);
    expect(result?.isAllDay).toBe(true);
  });

  it("sets isAllDay: false for a timed .ics event", () => {
    vi.mocked(hasIcsAttachment).mockReturnValue(true);
    vi.mocked(analyzeCalendarEvent).mockReturnValue({
      isCalendarEvent: true,
      eventDate: new Date(Date.UTC(2026, 5, 1, 15, 0, 0)),
      endDate: new Date(Date.UTC(2026, 5, 1, 16, 0, 0)),
      eventTitle: "Meeting",
    });
    const result = extractFromIcs(FAKE_MESSAGE);
    expect(result?.isAllDay).toBe(false);
  });
});
