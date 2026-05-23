import { describe, it, expect } from "vitest";
import { normalizeTitle, eventSignature } from "./signature";

describe("normalizeTitle", () => {
  it("lowercases, trims, and single-spaces", () => {
    expect(normalizeTitle("  Dr. Jones    Appointment  ")).toBe(
      "dr. jones appointment",
    );
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTitle("")).toBe("");
  });
});

describe("eventSignature", () => {
  it("returns a 64-character lowercase hex string (sha256 shape)", () => {
    const sig = eventSignature("Dr Jones", "2026-05-25T15:00:00-04:00");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies normalization before hashing (case + whitespace insensitive)", () => {
    const a = eventSignature("Dr Jones", "2026-05-25T15:00:00-04:00");
    const b = eventSignature("dr   jones", "2026-05-25T15:00:00-04:00");
    expect(a).toBe(b);
  });

  it("produces different hashes for different startISO values", () => {
    const a = eventSignature("Dr Jones", "2026-05-25T15:00:00-04:00");
    const b = eventSignature("Dr Jones", "2026-05-25T16:00:00-04:00");
    expect(a).not.toBe(b);
  });

  it("is deterministic across calls (same input -> same hash)", () => {
    const a = eventSignature("A", "X");
    const b = eventSignature("A", "X");
    expect(a).toBe(b);
  });
});
