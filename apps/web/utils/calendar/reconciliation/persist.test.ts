import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma", () => ({
  default: {
    reconciliationRecord: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));

import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import type { Logger } from "@/utils/logger";
import {
  createReconciliationRecord,
  findExistingReconciliationRecord,
  updateReconciliationRecord,
  findStalePendingRecord,
  type CreateReconciliationInput,
} from "./persist";

function makeMockLogger(): Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const BASE_INPUT: CreateReconciliationInput = {
  emailAccountId: "acct_test",
  messageId: "msg_test",
  threadId: "thr_test",
  eventSignature: "sig_test",
  extractedTitle: "Doctor appointment",
  extractedStart: new Date("2026-06-01T15:00:00.000Z"),
  extractedEnd: new Date("2026-06-01T16:00:00.000Z"),
  extractedLocation: "123 Main St",
  extractedAttendees: ["alice@example.com"],
  candidateConfidence: 0.92,
  extractedIsAllDay: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createReconciliationRecord", () => {
  it("writes a row with outcome=PENDING and extractedIsAllDay persisted, returns { created: true, record }", async () => {
    const created = { id: "rec_1", outcome: "PENDING" };
    vi.mocked(prisma.reconciliationRecord.create).mockResolvedValueOnce(
      created as never,
    );

    const result = await createReconciliationRecord({
      input: BASE_INPUT,
      logger: makeMockLogger(),
    });

    expect(result).toEqual({ created: true, record: created });
    expect(prisma.reconciliationRecord.create).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.reconciliationRecord.create).mock.calls[0][0];
    expect(args.data).toMatchObject({
      emailAccountId: BASE_INPUT.emailAccountId,
      messageId: BASE_INPUT.messageId,
      threadId: BASE_INPUT.threadId,
      outcome: "PENDING",
      extractedTitle: BASE_INPUT.extractedTitle,
      extractedStart: BASE_INPUT.extractedStart,
      extractedEnd: BASE_INPUT.extractedEnd,
      extractedLocation: BASE_INPUT.extractedLocation,
      extractedAttendees: BASE_INPUT.extractedAttendees,
      candidateConfidence: BASE_INPUT.candidateConfidence,
      eventSignature: BASE_INPUT.eventSignature,
      extractedIsAllDay: BASE_INPUT.extractedIsAllDay,
    });
  });

  it("returns { created: false, record: null } on P2002 (idempotency hit) without rethrow; logger payload is PII-safe", async () => {
    const dupError = new Error("p2002 mock");
    vi.mocked(prisma.reconciliationRecord.create).mockRejectedValueOnce(
      dupError,
    );
    vi.mocked(isDuplicateError).mockReturnValueOnce(true);
    const logger = makeMockLogger();

    const result = await createReconciliationRecord({
      input: BASE_INPUT,
      logger,
    });

    expect(result).toEqual({ created: false, record: null });
    expect(isDuplicateError).toHaveBeenCalledWith(dupError);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(logger.info).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({
      emailAccountId: BASE_INPUT.emailAccountId,
      messageId: BASE_INPUT.messageId,
    });
    // T-09-05: assert PII fields are NOT in the structured log payload.
    expect(payload).not.toHaveProperty("extractedTitle");
    expect(payload).not.toHaveProperty("extractedLocation");
    expect(payload).not.toHaveProperty("extractedAttendees");
    expect(payload).not.toHaveProperty("eventSignature");
  });

  it("rethrows non-P2002 errors", async () => {
    const otherError = new Error("connection refused");
    vi.mocked(prisma.reconciliationRecord.create).mockRejectedValueOnce(
      otherError,
    );
    vi.mocked(isDuplicateError).mockReturnValueOnce(false);

    await expect(
      createReconciliationRecord({
        input: BASE_INPUT,
        logger: makeMockLogger(),
      }),
    ).rejects.toThrow("connection refused");
  });
});

describe("findExistingReconciliationRecord", () => {
  it("calls prisma.reconciliationRecord.findFirst with (emailAccountId, messageId)", async () => {
    const row = { id: "rec_1" };
    vi.mocked(prisma.reconciliationRecord.findFirst).mockResolvedValueOnce(
      row as never,
    );

    const result = await findExistingReconciliationRecord({
      emailAccountId: "acct_test",
      messageId: "msg_test",
    });

    expect(result).toBe(row);
    expect(prisma.reconciliationRecord.findFirst).toHaveBeenCalledWith({
      where: { emailAccountId: "acct_test", messageId: "msg_test" },
    });
  });
});

describe("updateReconciliationRecord", () => {
  it("calls prisma.reconciliationRecord.update with where: { id } and data", async () => {
    const updated = { id: "rec_1", outcome: "CREATED" };
    vi.mocked(prisma.reconciliationRecord.update).mockResolvedValueOnce(
      updated as never,
    );

    const result = await updateReconciliationRecord({
      id: "rec_1",
      data: {
        outcome: "CREATED",
        googleEventId: "evt_abc",
        googleEventHtmlLink: "https://calendar.google.com/x",
        errorMessage: null,
      },
    });

    expect(result).toBe(updated);
    expect(prisma.reconciliationRecord.update).toHaveBeenCalledWith({
      where: { id: "rec_1" },
      data: {
        outcome: "CREATED",
        googleEventId: "evt_abc",
        googleEventHtmlLink: "https://calendar.google.com/x",
        errorMessage: null,
      },
    });
  });
});

describe("findStalePendingRecord", () => {
  it("queries PENDING rows older than 5 minutes using the injected `now`", async () => {
    const now = new Date("2026-06-01T12:00:00.000Z").getTime();
    const expectedCutoff = new Date(now - 5 * 60 * 1000);
    const row = { id: "rec_stale" };
    vi.mocked(prisma.reconciliationRecord.findFirst).mockResolvedValueOnce(
      row as never,
    );

    const result = await findStalePendingRecord({
      emailAccountId: "acct_test",
      messageId: "msg_test",
      now,
    });

    expect(result).toBe(row);
    expect(prisma.reconciliationRecord.findFirst).toHaveBeenCalledWith({
      where: {
        emailAccountId: "acct_test",
        messageId: "msg_test",
        outcome: "PENDING",
        updatedAt: { lt: expectedCutoff },
      },
    });
  });

  it("returns null when no stale PENDING row exists", async () => {
    vi.mocked(prisma.reconciliationRecord.findFirst).mockResolvedValueOnce(
      null,
    );

    const result = await findStalePendingRecord({
      emailAccountId: "acct_test",
      messageId: "msg_test",
      now: Date.now(),
    });

    expect(result).toBeNull();
  });
});
