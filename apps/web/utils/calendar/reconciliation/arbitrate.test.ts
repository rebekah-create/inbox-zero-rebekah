import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared before SUT import (mirrors extract.test.ts pattern).
const mockGenerateObject = vi.fn();
vi.mock("@/utils/llms", () => ({
  createGenerateObject: vi.fn(() => mockGenerateObject),
}));
vi.mock("@/utils/llms/model", () => ({
  getModel: vi.fn(),
}));
vi.mock("@/utils/llms/config", () => ({
  Provider: { ANTHROPIC: "anthropic" },
}));

// SUT import — must come AFTER mocks so the transitive
// `import { Provider } from "@/utils/llms/config"` resolves to the mock.
import { createGenerateObject } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { arbitrateOverlap, arbitrationSchema } from "./arbitrate";

function makeMockLogger(): Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const FAKE_EMAIL_ACCOUNT = {
  user: {},
  timezone: "America/New_York",
  email: "rebekah@example.com",
  id: "acct-1",
  userId: "user-1",
} as unknown as EmailAccountWithAI;

function timed(
  id: string,
  title: string,
  start: string,
  end: string,
): NormalizedCalendarEvent {
  return {
    id,
    title,
    description: null,
    location: null,
    start,
    end,
    isAllDay: false,
    attendees: [],
    htmlLink: "",
  };
}

const DAY_SCHEDULE: NormalizedCalendarEvent[] = [
  timed("evt_1", "Music lessons", "2026-05-26T19:00:00Z", "2026-05-26T20:00:00Z"),
  timed("evt_2", "Math Class", "2026-05-26T16:00:00Z", "2026-05-26T17:00:00Z"),
];

const EMAIL = {
  subject: "Piano lesson reminder",
  from: "noreply@musicstudio.example.com",
  bodyTruncated: "Reminder: Piano lesson tomorrow at 7:30pm.",
};

const CANDIDATE = {
  title: "Piano lesson",
  startISO: "2026-05-26T19:30:00Z",
  endISO: null as string | null,
  location: null as string | null,
};

beforeEach(() => {
  mockGenerateObject.mockReset();
  vi.mocked(createGenerateObject).mockReset();
  vi.mocked(getModel).mockReset();
  vi.mocked(createGenerateObject).mockReturnValue(
    mockGenerateObject as unknown as ReturnType<typeof createGenerateObject>,
  );
  vi.mocked(getModel).mockReturnValue({
    provider: "anthropic",
    modelName: "claude-haiku-4-5",
    model: {} as any,
    fallbackModels: [],
    hasUserApiKey: false,
  });
});

describe("arbitrationSchema", () => {
  it("accepts verdict=SAME with a string matchedEventId", () => {
    const result = arbitrationSchema.safeParse({
      verdict: "SAME",
      matchedEventId: "evt_1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts verdict=RESCHEDULE with a string matchedEventId", () => {
    const result = arbitrationSchema.safeParse({
      verdict: "RESCHEDULE",
      matchedEventId: "evt_old",
    });
    expect(result.success).toBe(true);
  });

  it("accepts verdict=SEPARATE with matchedEventId null", () => {
    const result = arbitrationSchema.safeParse({
      verdict: "SEPARATE",
      matchedEventId: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts verdict=SKIP with matchedEventId null", () => {
    const result = arbitrationSchema.safeParse({
      verdict: "SKIP",
      matchedEventId: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects legacy AMBIGUOUS verdict (not in the literal union)", () => {
    const result = arbitrationSchema.safeParse({
      verdict: "AMBIGUOUS",
      matchedEventId: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("arbitrateOverlap", () => {
  it("returns SAME with the matched id when model output passes the whitelist", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SAME", matchedEventId: "evt_1" },
    });

    const result = await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    expect(result).toEqual({ verdict: "SAME", matchedEventId: "evt_1" });
  });

  it("throws arbiter_invalid_matched_id when SAME points at an unknown id", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SAME", matchedEventId: "evt_does_not_exist" },
    });

    await expect(
      arbitrateOverlap({
        email: EMAIL,
        candidate: CANDIDATE,
        daySchedule: DAY_SCHEDULE,
        emailAccount: FAKE_EMAIL_ACCOUNT,
        logger: makeMockLogger(),
      }),
    ).rejects.toThrow(/arbiter_invalid_matched_id/);
  });

  it("throws arbiter_invalid_matched_id when SAME returns null id", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SAME", matchedEventId: null },
    });

    await expect(
      arbitrateOverlap({
        email: EMAIL,
        candidate: CANDIDATE,
        daySchedule: DAY_SCHEDULE,
        emailAccount: FAKE_EMAIL_ACCOUNT,
        logger: makeMockLogger(),
      }),
    ).rejects.toThrow(/arbiter_invalid_matched_id/);
  });

  it("normalizes matchedEventId to null when verdict is SEPARATE even if model returned an id", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SEPARATE", matchedEventId: "evt_1" },
    });

    const result = await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    expect(result).toEqual({ verdict: "SEPARATE", matchedEventId: null });
  });

  it("returns SKIP with matchedEventId null when model returns SKIP", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SKIP", matchedEventId: null },
    });

    const result = await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    expect(result).toEqual({ verdict: "SKIP", matchedEventId: null });
  });

  it("returns RESCHEDULE with the matched OLD event id when whitelisted", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "RESCHEDULE", matchedEventId: "evt_2" },
    });

    const result = await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    expect(result).toEqual({ verdict: "RESCHEDULE", matchedEventId: "evt_2" });
  });

  it("re-throws when the underlying generateObject call fails (D-08: caller owns the fallback)", async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error("haiku-down"));

    await expect(
      arbitrateOverlap({
        email: EMAIL,
        candidate: CANDIDATE,
        daySchedule: DAY_SCHEDULE,
        emailAccount: FAKE_EMAIL_ACCOUNT,
        logger: makeMockLogger(),
      }),
    ).rejects.toThrow(/haiku-down/);
  });

  it("builds a user prompt containing <email_body_untrusted> and <calendar_context> delimiters with each daySchedule id", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SEPARATE", matchedEventId: null },
    });

    await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain("<email_body_untrusted>");
    expect(call.prompt).toContain("</email_body_untrusted>");
    expect(call.prompt).toContain("<calendar_context>");
    expect(call.prompt).toContain("</calendar_context>");
    expect(call.prompt).toContain("id=evt_1");
    expect(call.prompt).toContain("id=evt_2");
    expect(call.prompt).toContain(EMAIL.bodyTruncated);
  });

  it("threads promptHardening untrusted/full into createGenerateObject", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SKIP", matchedEventId: null },
    });

    await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    expect(createGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Reconciliation arbitrate",
        promptHardening: { trust: "untrusted", level: "full" },
      }),
    );
  });

  it("passes the Anthropic cacheControl system block when provider is anthropic", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SKIP", matchedEventId: null },
    });

    await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    const call = mockGenerateObject.mock.calls[0][0];
    expect(Array.isArray(call.system)).toBe(true);
    const systemMsg = call.system[0];
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.providerOptions?.anthropic?.cacheControl?.type).toBe(
      "ephemeral",
    );
  });

  it("falls back to a plain string system when provider is NOT anthropic", async () => {
    vi.mocked(getModel).mockReturnValueOnce({
      provider: "openai",
      modelName: "gpt-x",
      model: {} as any,
      fallbackModels: [],
      hasUserApiKey: false,
    });
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SKIP", matchedEventId: null },
    });

    await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    const call = mockGenerateObject.mock.calls[0][0];
    expect(typeof call.system).toBe("string");
  });

  it("passes temperature: 0 and maxOutputTokens: 100 to the model call", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { verdict: "SKIP", matchedEventId: null },
    });

    await arbitrateOverlap({
      email: EMAIL,
      candidate: CANDIDATE,
      daySchedule: DAY_SCHEDULE,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0, maxOutputTokens: 100 }),
    );
  });
});
