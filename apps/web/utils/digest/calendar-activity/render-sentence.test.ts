import { describe, expect, it } from "vitest";
import { renderSentence } from "./render-sentence";

describe("renderSentence — D-11 sentence templates", () => {
  it("MATCHED renders '{Sender} confirmed {extractedTitle} — already on your calendar'", () => {
    const out = renderSentence({
      outcome: "MATCHED",
      sender: "REI",
      extractedTitle: "Camping reservation",
      extractedStart: new Date("2026-05-25T17:00:00Z"),
      isAllDay: false,
    });
    expect(out).toBe(
      "REI confirmed Camping reservation — already on your calendar",
    );
  });

  it("CREATED renders 'Added {title} {day} at {time} to your calendar (from {sender}) →'", () => {
    // 2026-05-25 09:00 ET = 13:00 UTC. 2026-05-25 is a Monday.
    const out = renderSentence({
      outcome: "CREATED",
      sender: "Orlando Health",
      extractedTitle: "Dr. Jones visit",
      extractedStart: new Date("2026-05-25T13:00:00Z"),
      isAllDay: false,
    });
    expect(out).toBe(
      "Added Dr. Jones visit Mon at 9:00a to your calendar (from Orlando Health) →",
    );
  });

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

  it("CREATED + isAllDay omits the time and renders just the day abbreviation", () => {
    // 2026-05-25 = Monday in ET.
    const out = renderSentence({
      outcome: "CREATED",
      sender: "School",
      extractedTitle: "School Holiday",
      extractedStart: new Date("2026-05-25T04:00:00Z"),
      isAllDay: true,
    });
    expect(out).toBe(
      "Added School Holiday Mon to your calendar (from School) →",
    );
  });

  it("does not include HTML metacharacters from extracted fields raw (T-10-02)", () => {
    // Helper passes input through as plain text; React Email <Text> escapes downstream.
    const out = renderSentence({
      outcome: "MATCHED",
      sender: "<b>Acme</b>",
      extractedTitle: "<script>alert(1)</script>",
      extractedStart: new Date("2026-05-25T17:00:00Z"),
      isAllDay: false,
    });
    expect(out).toBe(
      "<b>Acme</b> confirmed <script>alert(1)</script> — already on your calendar",
    );
    // No pre-escaping — raw < / > pass through verbatim.
    expect(out).toContain("<b>Acme</b>");
    expect(out).toContain("<script>");
  });
});
