import { describe, expect, it } from "vitest";
import {
  DIGEST_SYSTEM_PROMPT,
  buildDigestPrompt,
  type AgendaCompactItem,
  type Bucketed,
  type ReconciliationCompactItem,
} from "./digest-prompt";

const emptyBucketed: Bucketed = {
  urgent: [],
  uncertain: [],
  receipts: [],
  newsletters: [],
  marketing: [],
  notifications: [],
};

describe("buildDigestPrompt — Phase 10 extensions", () => {
  it("includes ### AGENDA section with empty placeholder when agendaCompact is empty", () => {
    const prompt = buildDigestPrompt({
      todayDate: "Tuesday, May 21",
      bucketed: emptyBucketed,
    });
    expect(prompt).toContain("### AGENDA\n(nothing on the calendar)");
  });

  it("includes ### AGENDA section with formatted items when agendaCompact is non-empty", () => {
    const agendaCompact: AgendaCompactItem[] = [
      { day: "today", time: "9:00a", title: "Standup", isAllDay: false },
      {
        day: "tomorrow",
        time: "8:30a",
        title: "Pediatrician",
        isAllDay: false,
      },
      {
        day: "tomorrow",
        time: "All day",
        title: "Memorial Day",
        isAllDay: true,
      },
    ];
    const prompt = buildDigestPrompt({
      todayDate: "Tuesday, May 21",
      bucketed: emptyBucketed,
      agendaCompact,
    });
    expect(prompt).toContain("### AGENDA");
    expect(prompt).toContain("- [today] 9:00a Standup");
    expect(prompt).toContain("- [tomorrow] 8:30a Pediatrician");
    expect(prompt).toContain("- [tomorrow] (all-day) Memorial Day");
  });

  it("includes ### RECONCILIATIONS section with empty placeholder when empty", () => {
    const prompt = buildDigestPrompt({
      todayDate: "Tuesday, May 21",
      bucketed: emptyBucketed,
    });
    expect(prompt).toContain("### RECONCILIATIONS\n(none in the last 24h)");
  });

  it("includes ### RECONCILIATIONS section with formatted items when non-empty", () => {
    const reconciliationsCompact: ReconciliationCompactItem[] = [
      { outcome: "CREATED", title: "Doctor visit", sender: "Memorial Health" },
      { outcome: "AMBIGUOUS", title: "Camping trip", sender: "Scout Troop" },
    ];
    const prompt = buildDigestPrompt({
      todayDate: "Tuesday, May 21",
      bucketed: emptyBucketed,
      reconciliationsCompact,
    });
    expect(prompt).toContain("### RECONCILIATIONS");
    expect(prompt).toContain("- [CREATED] Doctor visit — Memorial Health");
    expect(prompt).toContain("- [AMBIGUOUS] Camping trip — Scout Troop");
  });

  it("DIGEST_SYSTEM_PROMPT contains the D-22 hard rule verbatim", () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain(
      "Only reference events / reconciliations present in the AGENDA and RECONCILIATIONS blocks. Do not infer, summarize counts you can't see, or extrapolate.",
    );
  });

  it("token-delta: 5 agenda + 5 reconciliations adds ≤ 4000 characters (≤ ~1000 tokens) vs empty arrays", () => {
    const shortPrompt = buildDigestPrompt({
      todayDate: "Tuesday, May 21",
      bucketed: emptyBucketed,
    });

    const agendaCompact: AgendaCompactItem[] = [
      {
        day: "today",
        time: "9:00a",
        title: "Annual physical with Dr. Smith",
        isAllDay: false,
      },
      {
        day: "today",
        time: "12:30p",
        title: "Lunch with marketing team lead",
        isAllDay: false,
      },
      {
        day: "today",
        time: "3:00p",
        title: "Quarterly review presentation",
        isAllDay: false,
      },
      {
        day: "tomorrow",
        time: "8:00a",
        title: "Pediatric dentist appointment",
        isAllDay: false,
      },
      {
        day: "tomorrow",
        time: "10:30a",
        title: "Camping gear pickup at REI",
        isAllDay: false,
      },
    ];
    const reconciliationsCompact: ReconciliationCompactItem[] = [
      {
        outcome: "CREATED",
        title: "Soccer practice with the kids",
        sender: "Coach Williams Athletics",
      },
      {
        outcome: "MATCHED",
        title: "Annual checkup follow-up",
        sender: "Memorial Medical Group",
      },
      {
        outcome: "AMBIGUOUS",
        title: "Weekend camping trip planning",
        sender: "Boy Scout Troop 42",
      },
      {
        outcome: "CREATED",
        title: "Parent-teacher conference",
        sender: "Lincoln Elementary School",
      },
      {
        outcome: "MATCHED",
        title: "Furniture delivery window",
        sender: "True Ocean Logistics",
      },
    ];

    const longPrompt = buildDigestPrompt({
      todayDate: "Tuesday, May 21",
      bucketed: emptyBucketed,
      agendaCompact,
      reconciliationsCompact,
    });

    expect(longPrompt.length - shortPrompt.length).toBeLessThanOrEqual(4000);
  });
});
