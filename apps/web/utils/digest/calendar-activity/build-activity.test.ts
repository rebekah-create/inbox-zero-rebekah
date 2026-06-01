import { describe, expect, it } from "vitest";
import {
  buildCalendarActivity,
  type ReconciliationInput,
} from "./build-activity";

const rec = (
  overrides: Partial<ReconciliationInput> & {
    id: string;
    outcome: string;
  },
): ReconciliationInput => ({
  extractedTitle: "Some event",
  extractedStart: new Date("2026-05-21T13:00:00Z"),
  threadId: `thread-${overrides.id}`,
  googleEventHtmlLink: "https://calendar.google.com/event?eid=abc",
  messageId: `msg-${overrides.id}`,
  isAllDay: false,
  ...overrides,
});

describe("buildCalendarActivity — D-12 empty handling", () => {
  it("returns null when records array is empty", () => {
    const block = buildCalendarActivity({
      records: [],
      senderMap: new Map(),
    });
    expect(block).toBeNull();
  });

  it("returns null when only FAILED/PENDING records exist (D-16 + D-12)", () => {
    const block = buildCalendarActivity({
      records: [
        rec({ id: "1", outcome: "FAILED" }),
        rec({ id: "2", outcome: "PENDING" }),
      ],
      senderMap: new Map(),
    });
    expect(block).toBeNull();
  });
});

describe("buildCalendarActivity — D-11 grouping by outcome", () => {
  it("routes AMBIGUOUS->review, RESCHEDULE->rescheduled, CREATED->added, MATCHED->confirmed", () => {
    const records = [
      rec({ id: "1", outcome: "AMBIGUOUS" }),
      rec({ id: "2", outcome: "CREATED" }),
      rec({ id: "3", outcome: "MATCHED" }),
      rec({ id: "4", outcome: "RESCHEDULE" }),
    ];
    const block = buildCalendarActivity({
      records,
      senderMap: new Map(),
    });
    expect(block).not.toBeNull();
    expect(block!.review).toHaveLength(1);
    expect(block!.rescheduled).toHaveLength(1);
    expect(block!.added).toHaveLength(1);
    expect(block!.confirmed).toHaveLength(1);
  });

  it("RESCHEDULE row surfaces and links to the new Google event (Phase 11)", () => {
    const records = [
      rec({
        id: "1",
        outcome: "RESCHEDULE",
        extractedTitle: "Dr. Jones checkup",
        googleEventHtmlLink: "https://calendar.google.com/event?eid=new",
        messageId: "msg-r",
      }),
    ];
    const block = buildCalendarActivity({
      records,
      senderMap: new Map([["msg-r", "Orlando Health"]]),
    });
    expect(block!.rescheduled).toHaveLength(1);
    const row = block!.rescheduled[0]!;
    expect(row.sentence).toContain("Looks like Dr. Jones checkup moved to");
    expect(row.sentence).toContain("added the new time, flagged the old event");
    // RESCHEDULE deep-links into the newly-created event, like CREATED.
    expect(row.href).toBe("https://calendar.google.com/event?eid=new");
  });
});

describe("buildCalendarActivity — D-16 FAILED/PENDING exclusion", () => {
  it("drops FAILED records entirely; they appear in no group", () => {
    const records = [
      rec({ id: "1", outcome: "MATCHED" }),
      rec({ id: "2", outcome: "FAILED" }),
    ];
    const block = buildCalendarActivity({
      records,
      senderMap: new Map(),
    });
    expect(block).not.toBeNull();
    expect(block!.review).toHaveLength(0);
    expect(block!.added).toHaveLength(0);
    expect(block!.confirmed).toHaveLength(1);
  });

  it("drops PENDING records entirely; they appear in no group", () => {
    const records = [
      rec({ id: "1", outcome: "CREATED" }),
      rec({ id: "2", outcome: "PENDING" }),
    ];
    const block = buildCalendarActivity({
      records,
      senderMap: new Map(),
    });
    expect(block).not.toBeNull();
    expect(block!.added).toHaveLength(1);
    expect(block!.review).toHaveLength(0);
    expect(block!.confirmed).toHaveLength(0);
  });
});

describe("buildCalendarActivity — D-14 ordering within group", () => {
  it("sorts two CREATED records ascending by extractedStart", () => {
    const records = [
      rec({
        id: "late",
        outcome: "CREATED",
        extractedStart: new Date("2026-05-25T14:00:00Z"),
        extractedTitle: "Later event",
      }),
      rec({
        id: "early",
        outcome: "CREATED",
        extractedStart: new Date("2026-05-21T14:00:00Z"),
        extractedTitle: "Earlier event",
      }),
    ];
    const block = buildCalendarActivity({
      records,
      senderMap: new Map(),
    });
    // Earlier extractedStart should render first; we assert via sentence content.
    expect(block!.added[0]!.sentence).toContain("Earlier event");
    expect(block!.added[1]!.sentence).toContain("Later event");
  });
});

describe("buildCalendarActivity — sender resolution", () => {
  it("uses senderMap display name when present", () => {
    const records = [
      rec({ id: "1", outcome: "MATCHED", messageId: "msg-xyz" }),
    ];
    const senderMap = new Map([["msg-xyz", "Dr. Smith"]]);
    const block = buildCalendarActivity({ records, senderMap });
    expect(block!.confirmed[0]!.sentence.startsWith("Dr. Smith ")).toBe(true);
  });

  it("falls back to messageId string when senderMap misses", () => {
    const records = [
      rec({ id: "1", outcome: "MATCHED", messageId: "msg-orphan" }),
    ];
    const block = buildCalendarActivity({
      records,
      senderMap: new Map(),
    });
    expect(block!.confirmed[0]!.sentence.startsWith("msg-orphan ")).toBe(true);
  });
});

describe("buildCalendarActivity — row shape", () => {
  it("returns non-empty sentence + valid href per row", () => {
    const records = [
      rec({
        id: "1",
        outcome: "CREATED",
        googleEventHtmlLink: "https://calendar.google.com/event?eid=zzz",
      }),
    ];
    const block = buildCalendarActivity({
      records,
      senderMap: new Map([["msg-1", "Calendar Bot"]]),
    });
    const row = block!.added[0]!;
    expect(row.sentence.length).toBeGreaterThan(0);
    expect(row.href).toBe("https://calendar.google.com/event?eid=zzz");
  });
});
