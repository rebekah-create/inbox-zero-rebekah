import { describe, expect, it } from "vitest";
import { matchesKeywordBackstop } from "./index";

describe("matchesKeywordBackstop", () => {
  it("matches an 'appointment' keyword in the subject", () => {
    expect(
      matchesKeywordBackstop({
        subject: "Appointment reminder",
        body: "See you soon.",
      }),
    ).toBe(true);
  });

  it("returns false for a shipment subject + body", () => {
    expect(
      matchesKeywordBackstop({
        subject: "Your order shipped",
        body: "Track your package using the link below.",
      }),
    ).toBe(false);
  });

  it("matches a keyword found only in the body", () => {
    expect(
      matchesKeywordBackstop({
        subject: "Order update",
        body: "Your reservation for Saturday is confirmed at 7pm.",
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      matchesKeywordBackstop({
        subject: "APPOINTMENT",
        body: "",
      }),
    ).toBe(true);
  });

  it("matches each of the 12 D-02 keywords individually", () => {
    const keywords = [
      "appointment",
      "reminder",
      "scheduled",
      "confirmation",
      "reservation",
      "your visit",
      "rsvp",
      "calendar",
      "meeting",
      "invitation",
      "booked",
      "dr.",
    ];
    for (const kw of keywords) {
      expect(
        matchesKeywordBackstop({ subject: `prefix ${kw} suffix`, body: "" }),
      ).toBe(true);
    }
  });
});
