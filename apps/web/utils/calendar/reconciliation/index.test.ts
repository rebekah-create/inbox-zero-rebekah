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
  convertEmailHtmlToText: vi.fn(({ htmlText }: { htmlText: string }) => htmlText),
}));
vi.mock("./ics-path", () => ({ extractFromIcs: vi.fn() }));
vi.mock("./extract", () => ({ extractCandidateEvent: vi.fn() }));
vi.mock("./match", () => ({ decideOutcome: vi.fn() }));
vi.mock("./signature", () => ({ eventSignature: vi.fn(() => "sig_abc") }));
vi.mock("./persist", () => ({
  createReconciliationRecord: vi.fn(),
  findExistingReconciliationRecord: vi.fn(),
  findStalePendingRecord: vi.fn(),
  updateReconciliationRecord: vi.fn(),
}));
vi.mock("./create-event", () => ({ createCalendarEvent: vi.fn() }));

import prisma from "@/utils/prisma";
import { getUpcomingEvents } from "@/utils/calendar/upcoming-events";
import { extractFromIcs } from "./ics-path";
import { extractCandidateEvent } from "./extract";
import { decideOutcome } from "./match";
import {
  createReconciliationRecord,
  findExistingReconciliationRecord,
  findStalePendingRecord,
  updateReconciliationRecord,
} from "./persist";
import { createCalendarEvent } from "./create-event";
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

function makeMessage(
  overrides: Partial<ParsedMessage> = {},
): ParsedMessage {
  return {
    id: "msg_1",
    threadId: "thr_1",
    subject: "Test subject",
    snippet: "",
    date: new Date().toISOString(),
    historyId: "h1",
    inline: [],
    headers: {
      from: "sender@example.com",
      to: "rebekah@trueocean.com",
      subject: "Test subject",
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
  vi.mocked(decideOutcome).mockReturnValue({
    outcome: "CREATED",
    matchedEventId: null,
  });
  vi.mocked(createCalendarEvent).mockResolvedValue({
    ok: true,
    googleEventId: "evt_new",
    googleEventHtmlLink: "https://cal/x",
  });
  vi.mocked(updateReconciliationRecord).mockResolvedValue({} as never);
});

// =========================================================================
// Task 1 — pre-filter helper (kept inline; the orchestrator imports the same)
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
// Task 2 — orchestrator integration tests (boundaries-mocked).
// =========================================================================
describe("reconcileMessage", () => {
  it("Test A: Path A bypass — .ics returns candidate; Haiku never called", async () => {
    vi.mocked(extractFromIcs).mockReturnValue({
      ...defaultCandidate(),
      title: "ICS Event",
      confidence: 1.0,
    });

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage(),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(extractCandidateEvent).not.toHaveBeenCalled();
    expect(createReconciliationRecord).toHaveBeenCalledOnce();
    expect(createCalendarEvent).toHaveBeenCalledOnce();
  });

  it("Test B: Path B via CALENDAR ExecutedRule match", async () => {
    vi.mocked(prisma.executedRule.findFirst).mockResolvedValue({
      id: "er_1",
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

  it("Test H: MATCHED outcome — update with googleEventId, no create-event", async () => {
    vi.mocked(decideOutcome).mockReturnValue({
      outcome: "MATCHED",
      matchedEventId: "evt_x",
    });

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "MATCHED", googleEventId: "evt_x" },
    });
  });

  it("Test I: CREATED outcome — createCalendarEvent invoked, googleEventId persisted", async () => {
    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

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

  it("Test J: AMBIGUOUS outcome — update with matched id, no create-event (REC-06)", async () => {
    vi.mocked(decideOutcome).mockReturnValue({
      outcome: "AMBIGUOUS",
      matchedEventId: "evt_y",
    });

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateReconciliationRecord).toHaveBeenCalledWith({
      id: "rec_1",
      data: { outcome: "AMBIGUOUS", googleEventId: "evt_y" },
    });
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
      // 1st call (idempotency check): null
      .mockResolvedValueOnce(null)
      // 2nd call (best-effort FAILED lookup): returns a row
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

  it("Test M: getUpcomingEvents empty → default CREATED proceeds", async () => {
    vi.mocked(getUpcomingEvents).mockResolvedValue([]);

    await expect(
      reconcileMessage({
        parsedMessage: makeMessage({ subject: "Appointment reminder" }),
        emailAccount,
        emailAccountId: "acct_1",
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();

    expect(createCalendarEvent).toHaveBeenCalled();
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

  it("Test P: stale-PENDING reuse skips Haiku (T-09-04 cost-recovery)", async () => {
    const stale = {
      id: "rec_p",
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

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(extractCandidateEvent).not.toHaveBeenCalled();
    expect(decideOutcome).toHaveBeenCalledOnce();
    expect(updateReconciliationRecord).toHaveBeenCalled();
  });

  it("Test P-AllDay: stale-PENDING reuse with extractedIsAllDay=true → candidate.isAllDay=true", async () => {
    const stale = {
      id: "rec_pa",
      outcome: "PENDING",
      extractedTitle: "School closed",
      extractedStart: new Date("2026-06-01T00:00:00Z"),
      extractedEnd: null,
      extractedLocation: null,
      extractedAttendees: [],
      candidateConfidence: 0.95,
      extractedIsAllDay: true,
    };
    vi.mocked(findExistingReconciliationRecord).mockResolvedValue(
      stale as never,
    );
    vi.mocked(findStalePendingRecord).mockResolvedValue(stale as never);
    vi.mocked(prisma.reconciliationRecord.findUnique).mockResolvedValue(
      stale as never,
    );

    await reconcileMessage({
      parsedMessage: makeMessage({ subject: "Appointment reminder" }),
      emailAccount,
      emailAccountId: "acct_1",
      logger: makeLogger(),
    });

    expect(extractCandidateEvent).not.toHaveBeenCalled();
    const decideCall = vi.mocked(decideOutcome).mock.calls[0]?.[0];
    expect(decideCall?.candidate.isAllDay).toBe(true);
  });
});
