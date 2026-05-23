import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared before SUT import.
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

// SUT import — must come AFTER mocks so its `import { Provider } from "@/utils/llms/config"` (transitive via extract-prompt) resolves to the mock.
import { createGenerateObject } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import { candidateEventSchema, extractCandidateEvent } from "./extract";

function makeMockLogger(): Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const VALID_CANDIDATE = {
  title: "Dr Jones",
  startISO: "2026-05-25T15:00:00-04:00",
  endISO: null,
  location: null,
  attendees: [],
  confidence: 0.9,
  isAllDay: false,
};

const FAKE_EMAIL_ACCOUNT = {
  user: {},
  timezone: "America/New_York",
  email: "rebekah@example.com",
  id: "acct-1",
  userId: "user-1",
} as unknown as EmailAccountWithAI;

beforeEach(() => {
  mockGenerateObject.mockReset();
  vi.mocked(createGenerateObject).mockReset();
  vi.mocked(getModel).mockReset();
  vi.mocked(createGenerateObject).mockReturnValue(
    mockGenerateObject as unknown as ReturnType<typeof createGenerateObject>,
  );
  mockGenerateObject.mockResolvedValue({ object: VALID_CANDIDATE });
});

describe("candidateEventSchema", () => {
  it("accepts a valid timed event", () => {
    const result = candidateEventSchema.safeParse(VALID_CANDIDATE);
    expect(result.success).toBe(true);
  });

  it("accepts a valid all-day event", () => {
    const result = candidateEventSchema.safeParse({
      title: "School closed",
      startISO: "2026-05-25T00:00:00-04:00",
      endISO: null,
      location: null,
      attendees: [],
      confidence: 0.8,
      isAllDay: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects object missing isAllDay (no default; required boolean)", () => {
    const { isAllDay, ...withoutIsAllDay } = VALID_CANDIDATE;
    const result = candidateEventSchema.safeParse(withoutIsAllDay);
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1", () => {
    const result = candidateEventSchema.safeParse({
      ...VALID_CANDIDATE,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects attendees: null (must be array)", () => {
    const result = candidateEventSchema.safeParse({
      ...VALID_CANDIDATE,
      attendees: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("extractCandidateEvent", () => {
  function setupModel(provider: string) {
    vi.mocked(getModel).mockReturnValue({
      provider,
      modelName: "claude-haiku-4-5",
      model: {} as any,
      fallbackModels: [],
      hasUserApiKey: false,
    });
  }

  const email = {
    subject: "Appointment reminder",
    from: "noreply@orlandohealth.com",
    bodyTruncated: "See you Monday at 3pm.",
  };

  it("calls getModel(emailAccount.user, 'economy')", async () => {
    setupModel("anthropic");
    await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    expect(getModel).toHaveBeenCalledWith(FAKE_EMAIL_ACCOUNT.user, "economy");
  });

  it("threads label 'Reconciliation extract' into createGenerateObject", async () => {
    setupModel("anthropic");
    await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    expect(createGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Reconciliation extract" }),
    );
  });

  it("passes promptHardening { trust: 'untrusted', level: 'full' }", async () => {
    setupModel("anthropic");
    await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    expect(createGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        promptHardening: { trust: "untrusted", level: "full" },
      }),
    );
  });

  it("passes temperature: 0 and maxOutputTokens: 400 to generateObject", async () => {
    setupModel("anthropic");
    await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0, maxOutputTokens: 400 }),
    );
  });

  it("wraps body in <email_body_untrusted> tags in the user prompt", async () => {
    setupModel("anthropic");
    await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain("<email_body_untrusted>");
    expect(call.prompt).toContain("</email_body_untrusted>");
    expect(call.prompt).toContain("See you Monday at 3pm.");
  });

  it("uses emailAccount.timezone ?? 'America/New_York' for the system block", async () => {
    setupModel("anthropic");
    const accountWithoutTz = {
      ...FAKE_EMAIL_ACCOUNT,
      timezone: null,
    } as unknown as EmailAccountWithAI;
    await extractCandidateEvent({
      email,
      emailAccount: accountWithoutTz,
      logger: makeMockLogger(),
    });
    const call = mockGenerateObject.mock.calls[0][0];
    // System on anthropic provider is a SystemModelMessage[]
    const systemMsg = Array.isArray(call.system) ? call.system[0] : null;
    expect(systemMsg?.content).toContain("America/New_York");
  });

  it("returns SystemModelMessage[] with cacheControl when provider is anthropic", async () => {
    setupModel("anthropic");
    await extractCandidateEvent({
      email,
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

  it("returns plain string system when provider is not anthropic", async () => {
    setupModel("openai");
    await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    const call = mockGenerateObject.mock.calls[0][0];
    expect(typeof call.system).toBe("string");
  });
});
