import { describe, expect, it } from "vitest";
import { renderSentence } from "./render-sentence";

describe("renderSentence — D-11 sentence templates", () => {
  it("AMBIGUOUS renders '{Sender}: looks like it's about {extractedTitle} — review →'", () => {
    const out = renderSentence({
      outcome: "AMBIGUOUS",
      sender: "Camp Director",
      extractedTitle: "rescheduled session",
      extractedStart: new Date("2026-05-25T15:00:00Z"),
      isAllDay: false,
    });
    expect(out).toBe(
      "Camp Director: looks like it's about rescheduled session — review →",
    );
  });

  it("RESCHEDULE renders 'Looks like {title} moved to {day} at {time} — added the new time, flagged the old event (from {sender}) →'", () => {
    // 2026-05-25 09:00 ET = 13:00 UTC. 2026-05-25 is a Monday.
    const out = renderSentence({
      outcome: "RESCHEDULE",
      sender: "Orlando Health",
      extractedTitle: "Dr. Jones checkup",
      extractedStart: new Date("2026-05-25T13:00:00Z"),
      isAllDay: false,
    });
    expect(out).toBe(
      "Looks like Dr. Jones checkup moved to Mon at 9:00a — added the new time, flagged the old event (from Orlando Health) →",
    );
  });

  it("RESCHEDULE + isAllDay omits the time and renders just the day abbreviation", () => {
    const out = renderSentence({
      outcome: "RESCHEDULE",
      sender: "Camp Wildwood",
      extractedTitle: "Camping trip",
      extractedStart: new Date("2026-05-25T04:00:00Z"),
      isAllDay: true,
    });
    expect(out).toBe(
      "Looks like Camping trip moved to Mon — added the new time, flagged the old event (from Camp Wildwood) →",
    );
  });

  it("does not include HTML metacharacters from extracted fields raw (T-10-02)", () => {
    // Helper passes input through as plain text; React Email <Text> escapes downstream.
    const out = renderSentence({
      outcome: "AMBIGUOUS",
      sender: "<b>Acme</b>",
      extractedTitle: "<script>alert(1)</script>",
      extractedStart: new Date("2026-05-25T17:00:00Z"),
      isAllDay: false,
    });
    expect(out).toBe(
      "<b>Acme</b>: looks like it's about <script>alert(1)</script> — review →",
    );
    // No pre-escaping — raw < / > pass through verbatim.
    expect(out).toContain("<b>Acme</b>");
    expect(out).toContain("<script>");
  });
});
