// LOCAL-DEV NOTE: may fail at module load on Windows pnpm installs when the
// per-version .pnpm/@ai-sdk+gateway+x.y.z dir's nested @ai-sdk/gateway
// package lands as an empty stub (known pnpm flat-store corruption mode).
// Test code is fine; CI's fresh install populates the package correctly.
// Repair with `pnpm install --force`, or delete the empty package dir and
// rerun `pnpm install`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

vi.mock("@/utils/calendar/upcoming-events", () => ({
  getUpcomingEvents: vi.fn(),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));

vi.mock("@inboxzero/resend", () => ({
  sendDigestV2Email: vi.fn().mockResolvedValue({ id: "resend-msg-1" }),
}));

vi.mock("@/utils/ai/digest/generate-digest-content", () => ({
  generateDigestContent: vi.fn(),
}));

// Capture the props that the digest sender receives so each test can assert
// against the agenda + calendarActivity fields independently.
import { sendDigestV2Email } from "@inboxzero/resend";
import { createEmailProvider } from "@/utils/email/provider";
import { getUpcomingEvents } from "@/utils/calendar/upcoming-events";
import { generateDigestContent } from "@/utils/ai/digest/generate-digest-content";
import { runDailyDigest } from "./run-daily-digest";

const logger = createScopedLogger("run-daily-digest-test");

const baseAccount = {
  id: "acct-1",
  userId: "user-1",
  email: "rebekah@trueocean.com",
  about: null,
  multiRuleSelectionEnabled: false,
  timezone: "America/New_York",
  calendarBookingLink: null,
  user: {
    aiProvider: "anthropic",
    aiModel: "claude-sonnet-4-6",
    aiApiKey: null,
  },
  account: { provider: "google", refresh_token: "rt-1" },
};

function makeMessage(id: string, from: string, subject = "Subject") {
  return {
    id,
    threadId: `thread-${id}`,
    headers: {
      from,
      subject,
      to: "me@example.com",
      date: new Date().toISOString(),
    },
    snippet: "",
    historyId: "h",
    subject,
    date: new Date().toISOString(),
    textPlain: "body",
    textHtml: "",
    attachments: [],
    inline: [],
    labelIds: ["INBOX"],
  };
}

function setupCommonPrismaMocks() {
  prisma.emailAccount.findMany.mockResolvedValue([baseAccount] as any);
  // No prior digest send today.
  // digestAlreadySentToday → digestSend.findFirst
  (prisma as any).digestSend.findUnique.mockResolvedValue(null);
  prisma.digest.findMany.mockResolvedValue([
    {
      id: "digest-1",
      items: [
        {
          id: "item-1",
          messageId: "msg-1",
          content: "stub",
          action: {
            executedRule: {
              rule: { name: "Urgent", id: "rule-urgent", systemType: null },
            },
          },
        },
      ],
    },
  ] as any);
  prisma.digest.updateMany.mockResolvedValue({ count: 1 } as any);
  prisma.digestItem.updateMany.mockResolvedValue({ count: 1 } as any);
  (prisma as any).digestSend.create.mockResolvedValue({ id: "ds-1" } as any);
  prisma.$transaction.mockResolvedValue([] as any);

  // generateDigestContent stub
  (generateDigestContent as any).mockResolvedValue({
    narrativeGreeting: "Good morning, Rebekah.",
    narrativeBody: "Body",
    urgent: [],
    uncertain: [],
    autoFiled: {
      receipts: [],
      newsletters: [],
      marketing: [],
      notifications: [],
    },
  });

  // createEmailProvider — return a minimal provider whose getMessagesBatch
  // returns the bucket message + any reconciliation-only senders the test
  // overrides per-case below.
  (createEmailProvider as any).mockResolvedValue({
    getMessagesBatch: vi
      .fn()
      .mockResolvedValue([makeMessage("msg-1", "Sender <sender@x.com>")]),
  });
}

describe("runDailyDigest — Phase 10 agenda + calendar activity wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonPrismaMocks();
  });

  it("populates props.agenda from getUpcomingEvents result", async () => {
    (getUpcomingEvents as any).mockResolvedValue([
      {
        id: "evt-1",
        title: "Doctor visit",
        location: "Memorial Health",
        isAllDay: false,
        start: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        end: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    (prisma as any).reconciliationRecord.findMany.mockResolvedValue([]);

    await runDailyDigest(logger);

    const call = (sendDigestV2Email as any).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.emailProps.agenda).toBeDefined();
    expect(
      call.emailProps.agenda.today.length +
        call.emailProps.agenda.tomorrow.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("populates props.calendarActivity from reconciliationRecord rows + sender map", async () => {
    (getUpcomingEvents as any).mockResolvedValue([]);
    (prisma as any).reconciliationRecord.findMany.mockResolvedValue([
      {
        id: "rec-1",
        outcome: "CREATED",
        extractedTitle: "Camping trip",
        extractedStart: new Date(Date.now() + 24 * 60 * 60 * 1000),
        threadId: "thread-rec-1",
        googleEventHtmlLink: "https://calendar.google.com/event?eid=abc",
        messageId: "msg-rec-1",
        extractedIsAllDay: false,
      },
    ]);
    // The reconciliation messageId is NOT in the existing bucket messageMap,
    // so run-daily-digest must call getMessagesBatch for the missing id.
    (createEmailProvider as any).mockResolvedValue({
      getMessagesBatch: vi.fn().mockImplementation((ids: string[]) => {
        if (ids.includes("msg-1"))
          return [makeMessage("msg-1", "Sender <sender@x.com>")];
        if (ids.includes("msg-rec-1"))
          return [makeMessage("msg-rec-1", "Scout Troop <troop@x.com>")];
        return [];
      }),
    });

    await runDailyDigest(logger);

    const call = (sendDigestV2Email as any).mock.calls[0]?.[0];
    expect(call.emailProps.calendarActivity).not.toBeNull();
    expect(call.emailProps.calendarActivity.added.length).toBe(1);
    // Sender name lookup landed in the rendered sentence.
    expect(call.emailProps.calendarActivity.added[0].sentence).toContain(
      "Scout Troop",
    );
  });

  it("degrades gracefully when getUpcomingEvents rejects (digest still sends, agenda has fallback)", async () => {
    (getUpcomingEvents as any).mockRejectedValue(new Error("calendar down"));
    (prisma as any).reconciliationRecord.findMany.mockResolvedValue([]);

    await runDailyDigest(logger);

    expect(sendDigestV2Email).toHaveBeenCalledTimes(1);
    const call = (sendDigestV2Email as any).mock.calls[0]?.[0];
    // With events = [], buildAgenda emits the D-05 fallback strings.
    expect(call.emailProps.agenda).toBeDefined();
    expect(call.emailProps.agenda.todayFallback).toBeTruthy();
  });

  it("degrades gracefully when reconciliationRecord.findMany rejects (calendarActivity is null; digest still sends)", async () => {
    (getUpcomingEvents as any).mockResolvedValue([]);
    (prisma as any).reconciliationRecord.findMany.mockRejectedValue(
      new Error("db down"),
    );

    await runDailyDigest(logger);

    expect(sendDigestV2Email).toHaveBeenCalledTimes(1);
    const call = (sendDigestV2Email as any).mock.calls[0]?.[0];
    // buildCalendarActivity returns null when no records.
    expect(call.emailProps.calendarActivity).toBeNull();
  });

  it("logs warn with structured fields only on fetch failure (no extractedTitle/extractedLocation)", async () => {
    const warnCalls: Array<{
      message: string;
      args?: Record<string, unknown>;
    }> = [];
    const makeFakeLogger = (): any => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: (message: string, args?: Record<string, unknown>) => {
        warnCalls.push({ message, args });
      },
      trace: vi.fn(),
      flush: vi.fn(),
      with: () => makeFakeLogger(),
    });
    const fakeLogger = makeFakeLogger();
    // re-route every .with() to also push into the same warnCalls array
    fakeLogger.with = () => {
      const child: any = makeFakeLogger();
      child.warn = (m: string, a?: Record<string, unknown>) =>
        warnCalls.push({ message: m, args: a });
      child.with = fakeLogger.with;
      return child;
    };

    (getUpcomingEvents as any).mockRejectedValue(
      new Error("calendar API down — sensitive payload"),
    );
    (prisma as any).reconciliationRecord.findMany.mockRejectedValue(
      new Error("db reconciliation down"),
    );

    await runDailyDigest(fakeLogger);

    const interesting = warnCalls.filter(
      (c) =>
        c.message.includes("agenda.fetch.failed") ||
        c.message.includes("reconciliations.fetch.failed"),
    );
    expect(interesting.length).toBeGreaterThanOrEqual(1);
    for (const call of interesting) {
      const payload = JSON.stringify(call.args ?? {});
      expect(payload).not.toContain("extractedTitle");
      expect(payload).not.toContain("extractedLocation");
    }
  });
});
