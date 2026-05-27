import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma", () => ({
  default: {
    calendarConnection: {
      findFirst: vi.fn(),
    },
  },
}));

const mockEventsInsert = vi.fn();
const mockEventsGet = vi.fn();
const mockEventsPatch = vi.fn();

vi.mock("@/utils/calendar/client", () => ({
  getCalendarClientWithRefresh: vi.fn(async () => ({
    events: {
      insert: mockEventsInsert,
      get: mockEventsGet,
      patch: mockEventsPatch,
    },
  })),
}));

import prisma from "@/utils/prisma";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import type { Logger } from "@/utils/logger";
import {
  buildBackRefDescription,
  createCalendarEvent,
  type CreateCalendarEventInput,
  patchEventDescription,
} from "./create-event";

const EMAIL_ACCOUNT_ID = "test-account-id";
const MESSAGE_ID = "msg-abc-123";
const THREAD_ID = "thr-xyz-789";
const SENDER_EMAIL = "alice@example.com";
const TZ = "America/New_York";

function makeLogger(): Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeInput(
  overrides: Partial<CreateCalendarEventInput["candidate"]> = {},
  topLevel: Partial<CreateCalendarEventInput> = {},
): CreateCalendarEventInput {
  return {
    emailAccountId: EMAIL_ACCOUNT_ID,
    messageId: MESSAGE_ID,
    threadId: THREAD_ID,
    senderEmail: SENDER_EMAIL,
    timezone: TZ,
    candidate: {
      title: "Dentist appointment",
      startISO: "2026-06-01T14:00:00-04:00",
      endISO: "2026-06-01T15:00:00-04:00",
      location: "123 Main St",
      isAllDay: false,
      ...overrides,
    },
    ...topLevel,
  };
}

function mockConnection() {
  (prisma.calendarConnection.findFirst as any).mockResolvedValue({
    id: "conn_1",
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: BigInt(Date.now() + 3_600_000),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEventsInsert.mockReset();
  mockEventsGet.mockReset();
  mockEventsPatch.mockReset();
});

describe("createCalendarEvent", () => {
  it("Test 1: returns no-connection when CalendarConnection is missing", async () => {
    (prisma.calendarConnection.findFirst as any).mockResolvedValue(null);
    const logger = makeLogger();

    const result = await createCalendarEvent({ input: makeInput(), logger });

    expect(result).toEqual({ ok: false, reason: "no-connection" });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      emailAccountId: EMAIL_ACCOUNT_ID,
    });
  });

  it("Test 2: returns ok with googleEventId + htmlLink on success", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: {
        id: "evt_123",
        htmlLink: "https://calendar.google.com/event?eid=evt_123",
      },
    });
    const logger = makeLogger();

    const result = await createCalendarEvent({ input: makeInput(), logger });

    expect(result).toEqual({
      ok: true,
      googleEventId: "evt_123",
      googleEventHtmlLink: "https://calendar.google.com/event?eid=evt_123",
    });
  });

  it("Test 3: returns api-error and PII-safe logger.error when insert throws", async () => {
    mockConnection();
    mockEventsInsert.mockRejectedValue(new Error("Google 500"));
    const logger = makeLogger();

    const result = await createCalendarEvent({ input: makeInput(), logger });

    expect(result).toEqual({ ok: false, reason: "api-error" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        emailAccountId: EMAIL_ACCOUNT_ID,
        messageId: MESSAGE_ID,
        error: expect.any(Error),
      }),
    );
    const payload = (logger.error as any).mock.calls[0][1];
    expect(payload).toEqual(
      expect.not.objectContaining({
        summary: expect.any(String),
        description: expect.any(String),
        title: expect.any(String),
        location: expect.any(String),
      }),
    );
  });

  it("Test 4: timed event uses dateTime + timeZone shape", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({
      input: makeInput({ isAllDay: false }),
      logger,
    });

    const requestBody = mockEventsInsert.mock.calls[0][0].requestBody;
    expect(requestBody.start).toEqual({
      dateTime: "2026-06-01T14:00:00-04:00",
      timeZone: TZ,
    });
    expect(requestBody.end).toEqual({
      dateTime: "2026-06-01T15:00:00-04:00",
      timeZone: TZ,
    });
  });

  it("Test 4b: timed event with null endISO computes start+1h", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({
      input: makeInput({
        isAllDay: false,
        startISO: "2026-06-01T14:00:00.000Z",
        endISO: null,
      }),
      logger,
    });

    const requestBody = mockEventsInsert.mock.calls[0][0].requestBody;
    expect(requestBody.start).toEqual({
      dateTime: "2026-06-01T14:00:00.000Z",
      timeZone: TZ,
    });
    expect(requestBody.end).toEqual({
      dateTime: "2026-06-01T15:00:00.000Z",
      timeZone: TZ,
    });
  });

  it("Test 5: all-day event uses date-only shape (D-08)", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({
      input: makeInput({
        isAllDay: true,
        startISO: "2026-06-01T00:00:00-04:00",
        endISO: null,
      }),
      logger,
    });

    const requestBody = mockEventsInsert.mock.calls[0][0].requestBody;
    expect(requestBody.start).toEqual({ date: "2026-06-01" });
    expect(requestBody.end).toEqual({ date: "2026-06-02" });
  });

  it('Test 6: summary is prefixed with "[AI] " (D-17)', async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({
      input: makeInput({ title: "Dentist appointment" }),
      logger,
    });

    const requestBody = mockEventsInsert.mock.calls[0][0].requestBody;
    expect(requestBody.summary).toBe("[AI] Dentist appointment");
  });

  it("Test 7: description contains Gmail deep link and Message-ID line (D-18)", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({ input: makeInput(), logger });

    const requestBody = mockEventsInsert.mock.calls[0][0].requestBody;
    expect(requestBody.description).toContain(
      `https://mail.google.com/mail/u/0/#inbox/${THREAD_ID}`,
    );
    expect(requestBody.description).toContain(`Message-ID: ${MESSAGE_ID}`);
  });

  it("Test 8: requestBody does NOT include attendees", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({ input: makeInput(), logger });

    const requestBody = mockEventsInsert.mock.calls[0][0].requestBody;
    expect(requestBody).not.toHaveProperty("attendees");
  });

  it("Test 9: getCalendarClientWithRefresh called with emailAccountId (T-09-06)", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({ input: makeInput(), logger });

    expect(getCalendarClientWithRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: EMAIL_ACCOUNT_ID }),
    );
  });

  it("calendarId is hardcoded to primary", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: "evt_1", htmlLink: "https://x" },
    });
    const logger = makeLogger();

    await createCalendarEvent({ input: makeInput(), logger });

    expect(mockEventsInsert.mock.calls[0][0].calendarId).toBe("primary");
  });

  it("returns api-error if insert returns no id", async () => {
    mockConnection();
    mockEventsInsert.mockResolvedValue({
      data: { id: null, htmlLink: "https://x" },
    });
    const logger = makeLogger();

    const result = await createCalendarEvent({ input: makeInput(), logger });
    expect(result).toEqual({ ok: false, reason: "api-error" });
  });
});

describe("patchEventDescription (RED smoke)", () => {
  it("RED: helper exists and returns no-connection when CalendarConnection is missing", async () => {
    (prisma.calendarConnection.findFirst as any).mockResolvedValue(null);
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: {
        emailAccountId: EMAIL_ACCOUNT_ID,
        eventId: "old-evt-1",
        appendText: "[Possibly rescheduled? See https://link]",
      },
      logger,
    });

    expect(result).toEqual({ ok: false, reason: "no-connection" });
  });
});

describe("buildBackRefDescription", () => {
  it("contains Gmail deep link and Message-ID line", () => {
    const out = buildBackRefDescription({
      threadId: "T1",
      senderEmail: "bob@example.com",
      messageId: "M1",
    });
    expect(out).toContain("https://mail.google.com/mail/u/0/#inbox/T1");
    expect(out).toContain("(Source: bob@example.com");
    expect(out).toContain("Message-ID: M1");
  });
});
