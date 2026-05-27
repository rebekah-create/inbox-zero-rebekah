import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-boundary mocks (all sub-modules + cross-package boundaries) ----
vi.mock("@/utils/prisma", () => ({
  default: {
    executedRule: { findFirst: vi.fn() },
    reconciliationRecord: { findUnique: vi.fn() },
  },
}));
vi.mock("@/utils/calendar/upcoming-events", () => ({
  getUpcomingEvents: vi.fn(),
}));
vi.mock("@/utils/mail", () => ({
  convertEmailHtmlToText: vi.fn(
    ({ htmlText }: { htmlText: string }) => htmlText,
  ),
}));
vi.mock("./ics-path", () => ({ extractFromIcs: vi.fn() }));
vi.mock("./extract", () => ({ extractCandidateEvent: vi.fn() }));
vi.mock("./match", () => ({ decideAllDayOutcome: vi.fn() }));
vi.mock("./arbitrate", () => ({ arbitrateOverlap: vi.fn() }));
vi.mock("./overlap", () => ({ findIntervalOverlaps: vi.fn(() => []) }));
vi.mock("./signature", () => ({ eventSignature: vi.fn(() => "sig_abc") }));
vi.mock("./persist", () => ({
  createReconciliationRecord: vi.fn(),
  findExistingReconciliationRecord: vi.fn(),
  findStalePendingRecord: vi.fn(),
  updateReconciliationRecord: vi.fn(),
}));
vi.mock("./create-event", () => ({
  createCalendarEvent: vi.fn(),
  patchEventDescription: vi.fn(),
}));

import prisma from "@/utils/prisma";
import { getUpcomingEvents } from "@/utils/calendar/upcoming-events";
import { extractFromIcs } from "./ics-path";
import { extractCandidateEvent } from "./extract";
import { decideAllDayOutcome } from "./match";
import { arbitrateOverlap } from "./arbitrate";
import { findIntervalOverlaps } from "./overlap";
import {
  createReconciliationRecord,
  findExistingReconciliationRecord,
  findStalePendingRecord,
  updateReconciliationRecord,
} from "./persist";
import { createCalendarEvent, patchEventDescription } from "./create-event";
import { matchesKeywordBackstop, reconcileMessage } from "./index";
import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import type { EmailAccountWithAI } from "@/utils/llms/types";

// --- helpers ---------------------------------------------------------------

function makeLogger(): Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  const subject = (overrides.subject as string | undefined) ?? "Test subject";
  return {
    id: "msg_1",
    threadId: "thr_1",
    subject,
    snippet: "",
    date: new Date().toISOString(),
    historyId: "h1",
    inline: [],
    headers: {
      from: "sender@example.com",
      to: "rebekah@trueocean.com",
      subject,
      date: new Date().toISOString(),
    },
    textPlain: "plain body",
    ...overrides,
  } as unknown as ParsedMessage;
}

const emailAccount = {
  id: "acct_1",
  userId: "u_1",
  email: "rebekah@trueocean.com",
  timezone: "America/New_York",
  user: { id: "u_1", aiProvider: null, aiModel: null, aiApiKey: null },
} as unknown as EmailAccountWithAI;

function defaultCandidate() {
  return {
    title: "Dr Jones visit",
    startISO: "2026-06-01T15:00:00-04:00",
    endISO: null,
    location: null,
    attendees: [] as string[],
    confidence: 0.9,
    isAllDay: false,
  };
}

function makeOverlapEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evt_overlap",
    title: "Existing event",
    description: null,
    location: null,
    start: "2026-06-01T15:00:00-04:00",
    end: "2026-06-01T16:00:00-04:00",
    isAllDay: false,
    attendees: [],
    htmlLink: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults — individual tests override.
  vi.mocked(extractFromIcs).mockReturnValue(null);
  vi.mocked(prisma.executedRule.findFirst).mockResolvedValue(null);
  vi.mocked(findExistingReconciliationRecord).mockResolvedValue(null);
  vi.mocked(findStalePendingRecord).mockResolvedValue(null);
  vi.mocked(extractCandidateEvent).mockResolvedValue(defaultCandidate());
  vi.mocked(createReconciliationRecord).mockResolvedValue({
    created: true,
    record: { id: "rec_1" } as never,
  });
  vi.mocked(getUpcomingEvents).mockResolvedValue([]);
  vi.mocked(findIntervalOverlaps).mockReturnValue([]);
  vi.mocked(decideAllDayOutcome).mockReturnValue({
    outcome: "CREATED",
    matchedEventId: null,
    sameDateEvents: [],
  });
  vi.mocked(createCalendarEvent).mockResolvedValue({
    ok: true,
    googleEventId: "evt_new",
    googleEventHtmlLink: "https://cal/x",
  });
  vi.mocked(patchEventDescription).mockResolvedValue({ ok: true });
  vi.mocked(updateReconciliationRecord).mockResolvedValue({} as never);
});

// =========================================================================
// Pre-filter helper (kept inline; the orchestrator imports the same)
// =========================================================================
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

// =========================================================================
// Orchestrator integration tests — pre-existing flow (preserved).
// =========================================================================
describe("reconcileMessage — pre-existing flow", () => {
  it("Test B: Path B via CALENDAR ExecutedRule match", async () => {
    vi.mocked(prisma.executedRule.findFirst).mockResolvedValue({
      rule: { systemType: "CALENDAR", name: "Calendar" },
    } as never);

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({
          subject: "Random subject no keywords",
          textPlain: "Hi there.",
        }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(extractCandidateEvent).toHaveBeenCalledOnce();
    expect(createReconciliationRecord).toHaveBeenCalledOnce();
  });

  it("Test C: Path B via keyword backstop", async () => {
    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({
          subject: "Appointment with the dentist",
          textPlain: "...",
        }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(extractCandidateEvent).toHaveBeenCalledOnce();
  });

  it("still runs Haiku when classifier labeled it non-calendar but a keyword matched (legacy learned-pattern fallback)", async () => {
    // A real calendar event can land in Notification / Newsletter / Urgent
    // via legacy learned-pattern rules that predate the Calendar label.
    // The keyword backstop must keep firing for those cases — Haiku is the
    // gatekeeper that decides whether there's actually an event.
    vi.mocked(prisma.executedRule.findFirst).mockResolvedValue({
      rule: { systemType: "NOTIFICATION", name: "Notification" },
    } as never);

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({
          subject: "Appointment reminder for Friday",
          textPlain: "Your visit is confirmed.",
        }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(extractCandidateEvent).toHaveBeenCalledOnce();
  });

  it("skips when classifier matched the user 'TD Furn' rule (digest opt-out)", async () => {
    vi.mocked(prisma.executedRule.findFirst).mockResolvedValue({
      rule: { systemType: null, name: "TD Furn" },
    } as never);

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({
          subject: "Your daily digest — appointment reminders",
          textPlain: "...",
        }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(extractCandidateEvent).not.toHaveBeenCalled();
    expect(createReconciliationRecord).not.toHaveBeenCalled();
  });

  it("flips outcome to FAILED with no_resolvable_time when Haiku returns empty startISO", async () => {
    // Haiku saw no resolvable event in the body — schema explicitly permits
    // this via `startISO: ""`. The orchestrator must NOT attempt a Google
    // events.insert (which would throw "Invalid time value" inside
    // create-event.ts on `new Date(Date.parse("") + 1h).toISOString()`).
    vi.mocked(extractCandidateEvent).mockResolvedValue({
      title: "",
      startISO: "",
      endISO: null,
      location: null,
      attendees: [],
      confidence: 0,
      isAllDay: false,
    });

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({
          subject: "Appointment reminder",
          textPlain: "...",
        }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "FAILED", errorMessage: "no_resolvable_time" },
    });
  });

  it("Test D: Path C skip — no .ics, no ExecutedRule, no keyword", async () => {
    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({
          subject: "Your order shipped",
          textPlain: "Track your package",
        }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(extractCandidateEvent).not.toHaveBeenCalled();
    expect(findExistingReconciliationRecord).not.toHaveBeenCalled();
    expect(createReconciliationRecord).not.toHaveBeenCalled();
  });

  it("Test E: idempotency fast-path — existing non-PENDING row → no-op", async () => {
    vi.mocked(findExistingReconciliationRecord).mockResolvedValue({
      id: "rec_old",
      outcome: "CREATED",
    } as never);

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(extractCandidateEvent).not.toHaveBeenCalled();
    expect(createReconciliationRecord).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).not.toHaveBeenCalled();
  });

  it("Test F: stale-PENDING recovery — update-in-place, no second create", async () => {
    const stale = {
      id: "rec_stale",
      outcome: "PENDING",
      extractedTitle: "Dr Jones",
      extractedStart: new Date("2026-06-01T15:00:00Z"),
      extractedEnd: null,
      extractedLocation: null,
      extractedAttendees: [],
      candidateConfidence: 0.8,
      extractedIsAllDay: false,
    };
    vi.mocked(findExistingReconciliationRecord).mockResolvedValue(
      stale as never,
    );
    vi.mocked(findStalePendingRecord).mockResolvedValue(stale as never);
    vi.mocked(prisma.reconciliationRecord.findUnique).mockResolvedValue(
      stale as never,
    );

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(createReconciliationRecord).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rec_stale" }),
    );
  });

  it("Test G: P2002 idempotency catch — created:false → no-op", async () => {
    vi.mocked(createReconciliationRecord).mockResolvedValue({
      created: false,
      record: null,
    });

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(getUpcomingEvents).not.toHaveBeenCalled();
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).not.toHaveBeenCalled();
  });

  it("Test K: Google API failure (OPS-01) — outcome flips to FAILED, no rethrow", async () => {
    vi.mocked(createCalendarEvent).mockResolvedValue({
      ok: false,
      reason: "api-error",
    });
    const logger = makeLogger();

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "FAILED", errorMessage: "api-error" },
    });
  });

  it("Test L: extractCandidateEvent throws → catch, attempt FAILED update, no rethrow", async () => {
    vi.mocked(extractCandidateEvent).mockRejectedValue(new Error("haiku 500"));
    vi.mocked(findExistingReconciliationRecord)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "rec_err" } as never);
    const logger = makeLogger();

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });

  it("Test N: PII discipline — logger payloads on failure paths contain no extracted fields", async () => {
    vi.mocked(extractCandidateEvent).mockRejectedValue(new Error("boom"));
    const logger = makeLogger();

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger,
    });

    const allCalls = [
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ];
    for (const [, payload] of allCalls) {
      if (payload && typeof payload === "object") {
        expect(payload).not.toHaveProperty("extractedTitle");
        expect(payload).not.toHaveProperty("extractedLocation");
        expect(payload).not.toHaveProperty("extractedAttendees");
        expect(payload).not.toHaveProperty("textPlain");
        expect(payload).not.toHaveProperty("textHtml");
        expect(payload).not.toHaveProperty("subject");
      }
    }
  });

  it("Test O: body truncated to first 2000 chars before extractCandidateEvent (D-05)", async () => {
    await reconcileMessage({
      parsedMessage: makeMessage({
        subject: "Appointment reminder",
        textPlain: "x".repeat(5000),
      }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(extractCandidateEvent).toHaveBeenCalledOnce();
    const call = vi.mocked(extractCandidateEvent).mock.calls[0]?.[0];
    expect(call?.email.bodyTruncated.length).toBe(2000);
  });
});

// =========================================================================
// Phase 11 D-13: verdict-to-outcome routing (the new flow).
// =========================================================================
describe("reconcileMessage — Phase 11 verdict routing", () => {
  it("1. No overlap on timed candidate → arbitrate NOT called; CREATED", async () => {
    vi.mocked(findIntervalOverlaps).mockReturnValue([]);
    vi.mocked(getUpcomingEvents).mockResolvedValue([]);

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(arbitrateOverlap).not.toHaveBeenCalled();
    expect(createCalendarEvent).toHaveBeenCalledOnce();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: {
        outcome: "CREATED",
        googleEventId: "evt_new",
        googleEventHtmlLink: "https://cal/x",
      },
    });
  });

  it("2. Overlap + arbiter SAME → MATCHED, no Google insert, no patch", async () => {
    const overlap = makeOverlapEvent({ id: "evt_existing" });
    vi.mocked(getUpcomingEvents).mockResolvedValue([overlap]);
    vi.mocked(findIntervalOverlaps).mockReturnValue([overlap]);
    vi.mocked(arbitrateOverlap).mockResolvedValue({
      verdict: "SAME",
      matchedEventId: "evt_existing",
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(patchEventDescription).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "MATCHED", googleEventId: "evt_existing" },
    });
  });

  it("3. Overlap + arbiter SEPARATE → CREATED via insert; no patch", async () => {
    const overlap = makeOverlapEvent({ id: "evt_other" });
    vi.mocked(getUpcomingEvents).mockResolvedValue([overlap]);
    vi.mocked(findIntervalOverlaps).mockReturnValue([overlap]);
    vi.mocked(arbitrateOverlap).mockResolvedValue({
      verdict: "SEPARATE",
      matchedEventId: null,
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(createCalendarEvent).toHaveBeenCalledOnce();
    expect(patchEventDescription).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: {
        outcome: "CREATED",
        googleEventId: "evt_new",
        googleEventHtmlLink: "https://cal/x",
      },
    });
  });

  it("4. Overlap + arbiter RESCHEDULE + insert ok → patch old; record RESCHEDULE", async () => {
    const overlap = makeOverlapEvent({ id: "evt_old" });
    vi.mocked(getUpcomingEvents).mockResolvedValue([overlap]);
    vi.mocked(findIntervalOverlaps).mockReturnValue([overlap]);
    vi.mocked(arbitrateOverlap).mockResolvedValue({
      verdict: "RESCHEDULE",
      matchedEventId: "evt_old",
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment moved" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(createCalendarEvent).toHaveBeenCalledOnce();
    expect(patchEventDescription).toHaveBeenCalledOnce();
    const patchArgs = vi.mocked(patchEventDescription).mock.calls[0]?.[0];
    expect(patchArgs?.input.eventId).toBe("evt_old");
    expect(patchArgs?.input.appendText).toContain("https://cal/x");
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: {
        outcome: "RESCHEDULE",
        googleEventId: "evt_new",
        googleEventHtmlLink: "https://cal/x",
        rescheduleOfEventId: "evt_old",
        errorMessage: null,
      },
    });
  });

  it("5. RESCHEDULE + patch fails → record RESCHEDULE with patch_failed errorMessage", async () => {
    const overlap = makeOverlapEvent({ id: "evt_old" });
    vi.mocked(getUpcomingEvents).mockResolvedValue([overlap]);
    vi.mocked(findIntervalOverlaps).mockReturnValue([overlap]);
    vi.mocked(arbitrateOverlap).mockResolvedValue({
      verdict: "RESCHEDULE",
      matchedEventId: "evt_old",
    });
    vi.mocked(patchEventDescription).mockResolvedValue({
      ok: false,
      reason: "event-not-found",
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment moved" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: {
        outcome: "RESCHEDULE",
        googleEventId: "evt_new",
        googleEventHtmlLink: "https://cal/x",
        rescheduleOfEventId: "evt_old",
        errorMessage: "patch_failed:event-not-found",
      },
    });
  });

  it("6. RESCHEDULE + insert fails → FAILED; patch NOT called", async () => {
    const overlap = makeOverlapEvent({ id: "evt_old" });
    vi.mocked(getUpcomingEvents).mockResolvedValue([overlap]);
    vi.mocked(findIntervalOverlaps).mockReturnValue([overlap]);
    vi.mocked(arbitrateOverlap).mockResolvedValue({
      verdict: "RESCHEDULE",
      matchedEventId: "evt_old",
    });
    vi.mocked(createCalendarEvent).mockResolvedValue({
      ok: false,
      reason: "api-error",
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment moved" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(patchEventDescription).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "FAILED", errorMessage: "api-error" },
    });
  });

  it("7. Overlap + arbiter SKIP → FAILED with arbiter_skip; no Google calls", async () => {
    const overlap = makeOverlapEvent({ id: "evt_x" });
    vi.mocked(getUpcomingEvents).mockResolvedValue([overlap]);
    vi.mocked(findIntervalOverlaps).mockReturnValue([overlap]);
    vi.mocked(arbitrateOverlap).mockResolvedValue({
      verdict: "SKIP",
      matchedEventId: null,
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment book today!" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(patchEventDescription).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "FAILED", errorMessage: "arbiter_skip" },
    });
  });

  it("8. Overlap + arbiter THROWS → D-08 fallback CREATE; record CREATED", async () => {
    const overlap = makeOverlapEvent({ id: "evt_x" });
    vi.mocked(getUpcomingEvents).mockResolvedValue([overlap]);
    vi.mocked(findIntervalOverlaps).mockReturnValue([overlap]);
    vi.mocked(arbitrateOverlap).mockRejectedValue(new Error("haiku down"));
    const logger = makeLogger();

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger,
    });

    expect(createCalendarEvent).toHaveBeenCalledOnce();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: {
        outcome: "CREATED",
        googleEventId: "evt_new",
        googleEventHtmlLink: "https://cal/x",
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Reconciliation arbitration failed; falling through to CREATE",
      expect.any(Object),
    );
  });

  it("9. All-day candidate, no same-date events → arbitrate NOT called; CREATED", async () => {
    vi.mocked(extractCandidateEvent).mockResolvedValue({
      ...defaultCandidate(),
      isAllDay: true,
      startISO: "2026-06-01T00:00:00Z",
    });
    vi.mocked(decideAllDayOutcome).mockReturnValue({
      outcome: "CREATED",
      matchedEventId: null,
      sameDateEvents: [],
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(arbitrateOverlap).not.toHaveBeenCalled();
    expect(createCalendarEvent).toHaveBeenCalledOnce();
    const insertCall = vi.mocked(createCalendarEvent).mock.calls[0]?.[0];
    expect(insertCall?.input.candidate.isAllDay).toBe(true);
  });

  it("10. All-day candidate, NEEDS_ARBITRATION, arbiter SAME → MATCHED, no insert", async () => {
    vi.mocked(extractCandidateEvent).mockResolvedValue({
      ...defaultCandidate(),
      isAllDay: true,
      startISO: "2026-06-01T00:00:00Z",
    });
    const sameDate = makeOverlapEvent({
      id: "evt_allday",
      start: "2026-06-01",
      end: "2026-06-02",
      isAllDay: true,
    });
    vi.mocked(decideAllDayOutcome).mockReturnValue({
      outcome: "NEEDS_ARBITRATION",
      matchedEventId: null,
      sameDateEvents: [sameDate],
    });
    vi.mocked(arbitrateOverlap).mockResolvedValue({
      verdict: "SAME",
      matchedEventId: "evt_allday",
    });

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "MATCHED", googleEventId: "evt_allday" },
    });
  });

  it("11. pathA (.ics) short-circuit (D-14): arbitrate + overlap NOT called even with overlapping events", async () => {
    vi.mocked(extractFromIcs).mockReturnValue({
      ...defaultCandidate(),
      title: "ICS Event",
      confidence: 1.0,
    });
    // Even though upcoming events overlap, pathA bypasses the entire flow.
    vi.mocked(getUpcomingEvents).mockResolvedValue([makeOverlapEvent()]);

    await reconcileMessage({
      parsedMessage: makeMessage(),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(arbitrateOverlap).not.toHaveBeenCalled();
    expect(findIntervalOverlaps).not.toHaveBeenCalled();
    expect(decideAllDayOutcome).not.toHaveBeenCalled();
    expect(createCalendarEvent).toHaveBeenCalledOnce();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: {
        outcome: "CREATED",
        googleEventId: "evt_new",
        googleEventHtmlLink: "https://cal/x",
      },
    });
  });
});
