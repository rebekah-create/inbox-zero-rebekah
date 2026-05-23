import { describe, it, expect } from "vitest";
import { titleSimilarity } from "./dice";

describe("titleSimilarity (whitespace-token Dice coefficient)", () => {
  it("returns ~0.857 for 'Dr Jones cleaning' vs 'Dr Jones cleaning appointment' (6/7)", () => {
    expect(
      titleSimilarity("Dr Jones cleaning", "Dr Jones cleaning appointment"),
    ).toBeCloseTo(0.857, 2);
  });

  it("returns ~0.333 for 'Dr Jones cleaning' vs 'Dr Smith dentist' (below weak threshold)", () => {
    expect(
      titleSimilarity("Dr Jones cleaning", "Dr Smith dentist"),
    ).toBeCloseTo(0.333, 2);
  });

  it("returns exactly 0.4 for 'REI pickup' vs 'REI Store reservation' (AMBIGUOUS threshold)", () => {
    expect(titleSimilarity("REI pickup", "REI Store reservation")).toBeCloseTo(
      0.4,
      5,
    );
  });

  it("returns 0 for empty vs non-empty", () => {
    expect(titleSimilarity("", "anything")).toBe(0);
  });

  it("returns 1 for both-empty", () => {
    expect(titleSimilarity("", "")).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(titleSimilarity("CASE matters NOT", "case Matters not")).toBe(1);
  });

  it("collapses whitespace before tokenizing", () => {
    expect(
      titleSimilarity("  whitespace  trimmed  ", "whitespace trimmed"),
    ).toBe(1);
  });
});
