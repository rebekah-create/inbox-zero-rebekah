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

describe("patchEventDescription", () => {
  const OLD_EVENT_ID = "old-evt-1";
  const APPEND_TEXT = "[Possibly rescheduled? See https://link]";

  function patchInput(
    overrides: Partial<{
      emailAccountId: string;
      eventId: string;
      appendText: string;
    }> = {},
  ) {
    return {
      emailAccountId: EMAIL_ACCOUNT_ID,
      eventId: OLD_EVENT_ID,
      appendText: APPEND_TEXT,
      ...overrides,
    };
  }

  it("Test 1: returns no-connection when CalendarConnection is missing", async () => {
    (prisma.calendarConnection.findFirst as any).mockResolvedValue(null);
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: false, reason: "no-connection" });
    expect(mockEventsGet).not.toHaveBeenCalled();
    expect(mockEventsPatch).not.toHaveBeenCalled();
  });

  it("Test 2: appends to existing description with double-newline separator", async () => {
    mockConnection();
    mockEventsGet.mockResolvedValue({
      data: { description: "Existing notes." },
    });
    mockEventsPatch.mockResolvedValue({ data: { id: OLD_EVENT_ID } });
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: true });
    expect(mockEventsPatch).toHaveBeenCalledTimes(1);
    const patchArgs = mockEventsPatch.mock.calls[0][0];
    expect(patchArgs.requestBody).toEqual({
      description: `Existing notes.\n\n${APPEND_TEXT}`,
    });
    expect(patchArgs.calendarId).toBe("primary");
    expect(patchArgs.eventId).toBe(OLD_EVENT_ID);
  });

  it("Test 3: null/undefined existing description → newDescription is just appendText", async () => {
    mockConnection();
    mockEventsGet.mockResolvedValue({ data: { description: null } });
    mockEventsPatch.mockResolvedValue({ data: { id: OLD_EVENT_ID } });
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: true });
    const patchArgs = mockEventsPatch.mock.calls[0][0];
    expect(patchArgs.requestBody.description).toBe(APPEND_TEXT);
    expect(patchArgs.requestBody.description.startsWith("\n")).toBe(false);
  });

  it("Test 4: idempotent when existing description already contains appendText", async () => {
    mockConnection();
    mockEventsGet.mockResolvedValue({
      data: {
        description: `Existing notes.\n\n${APPEND_TEXT}`,
      },
    });
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: true });
    expect(mockEventsPatch).not.toHaveBeenCalled();
  });

  it("Test 5: events.get throws with code 404 → event-not-found, patch not called", async () => {
    mockConnection();
    const err: any = new Error("Not Found");
    err.code = 404;
    mockEventsGet.mockRejectedValue(err);
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: false, reason: "event-not-found" });
    expect(mockEventsPatch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        emailAccountId: EMAIL_ACCOUNT_ID,
        eventId: OLD_EVENT_ID,
      }),
    );
  });

  it("Test 6: events.get throws with response.status 404 → event-not-found", async () => {
    mockConnection();
    const err: any = new Error("Not Found");
    err.response = { status: 404 };
    mockEventsGet.mockRejectedValue(err);
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: false, reason: "event-not-found" });
    expect(mockEventsPatch).not.toHaveBeenCalled();
  });

  it("Test 7: events.get throws with 500 → api-error", async () => {
    mockConnection();
    const err: any = new Error("Server Error");
    err.response = { status: 500 };
    mockEventsGet.mockRejectedValue(err);
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: false, reason: "api-error" });
    expect(mockEventsPatch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        emailAccountId: EMAIL_ACCOUNT_ID,
        eventId: OLD_EVENT_ID,
        error: expect.any(Error),
      }),
    );
  });

  it("Test 8: events.patch throws → api-error", async () => {
    mockConnection();
    mockEventsGet.mockResolvedValue({ data: { description: "Existing." } });
    mockEventsPatch.mockRejectedValue(new Error("Patch failed"));
    const logger = makeLogger();

    const result = await patchEventDescription({
      input: patchInput(),
      logger,
    });

    expect(result).toEqual({ ok: false, reason: "api-error" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        emailAccountId: EMAIL_ACCOUNT_ID,
        eventId: OLD_EVENT_ID,
        error: expect.any(Error),
      }),
    );
  });

  it("Test 9: patch requestBody NEVER contains start/end/summary/location/attendees (D-09 invariant)", async () => {
    mockConnection();
    mockEventsGet.mockResolvedValue({
      data: { description: "Existing notes." },
    });
    mockEventsPatch.mockResolvedValue({ data: { id: OLD_EVENT_ID } });
    const logger = makeLogger();

    await patchEventDescription({ input: patchInput(), logger });

    const requestBody = mockEventsPatch.mock.calls[0][0].requestBody;
    expect(requestBody).not.toHaveProperty("start");
    expect(requestBody).not.toHaveProperty("end");
    expect(requestBody).not.toHaveProperty("summary");
    expect(requestBody).not.toHaveProperty("location");
    expect(requestBody).not.toHaveProperty("attendees");
    expect(Object.keys(requestBody)).toEqual(["description"]);
  });

  it("Test 10: PII-safe logging — error payload contains no description/title/location/summary fields", async () => {
    mockConnection();
    mockEventsGet.mockResolvedValue({
      data: { description: "Sensitive existing notes." },
    });
    mockEventsPatch.mockRejectedValue(new Error("Boom"));
    const logger = makeLogger();

    await patchEventDescription({ input: patchInput(), logger });

    const payload = (logger.error as any).mock.calls[0][1];
    expect(payload).toEqual(
      expect.not.objectContaining({
        description: expect.any(String),
        title: expect.any(String),
        location: expect.any(String),
        summary: expect.any(String),
        appendText: expect.any(String),
      }),
    );
  });

  it("Test 11: getCalendarClientWithRefresh called with emailAccountId (T-09-06)", async () => {
    mockConnection();
    mockEventsGet.mockResolvedValue({ data: { description: null } });
    mockEventsPatch.mockResolvedValue({ data: { id: OLD_EVENT_ID } });
    const logger = makeLogger();

    await patchEventDescription({ input: patchInput(), logger });

    expect(getCalendarClientWithRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: EMAIL_ACCOUNT_ID }),
    );
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
