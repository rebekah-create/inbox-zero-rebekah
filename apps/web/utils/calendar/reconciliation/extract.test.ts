import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

  it("accepts confidence outside [0, 1] at the schema layer (clamping happens in extractCandidateEvent)", () => {
    // Anthropic's structured-output validator rejects min/max on number, so we
    // can't enforce the 0..1 range in the schema. The contract is documented
    // via .describe() to the model and the clamp lives in extractCandidateEvent.
    expect(
      candidateEventSchema.safeParse({ ...VALID_CANDIDATE, confidence: 1.5 })
        .success,
    ).toBe(true);
    expect(
      candidateEventSchema.safeParse({ ...VALID_CANDIDATE, confidence: -0.2 })
        .success,
    ).toBe(true);
  });

  it("emits a JSON Schema with no numeric range constraints (Anthropic structured-output compat)", () => {
    // Regression guard for the bug where `confidence: z.number().min(0).max(1)`
    // caused every reconciliation call in prod to fail with:
    //   output_config.format.schema: For 'number' type, properties maximum,
    //   minimum are not supported
    // If anyone re-introduces .min/.max/.lt/.gt on a number field in this
    // schema, this test will fail before it reaches prod.
    const json = z.toJSONSchema(candidateEventSchema) as Record<
      string,
      unknown
    >;
    const banned = [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ];
    const findBanned = (node: unknown, path: string): string[] => {
      if (!node || typeof node !== "object") return [];
      const obj = node as Record<string, unknown>;
      const hits: string[] = [];
      for (const key of banned) {
        if (key in obj) hits.push(`${path}.${key}`);
      }
      for (const [k, v] of Object.entries(obj)) {
        hits.push(...findBanned(v, `${path}.${k}`));
      }
      return hits;
    };
    expect(findBanned(json, "$")).toEqual([]);
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
    // System is a plain string (prompt caching removed — see v1.1 audit).
    expect(typeof call.system).toBe("string");
    expect(call.system).toContain("America/New_York");
  });

  it("passes system as a plain string with no cacheControl (caching removed)", async () => {
    setupModel("anthropic");
    await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    const call = mockGenerateObject.mock.calls[0][0];
    expect(typeof call.system).toBe("string");
    expect(JSON.stringify(call)).not.toContain("cacheControl");
  });

  it("clamps confidence > 1 down to 1", async () => {
    setupModel("anthropic");
    mockGenerateObject.mockResolvedValueOnce({
      object: { ...VALID_CANDIDATE, confidence: 1.7 },
    });
    const out = await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    expect(out.confidence).toBe(1);
  });

  it("clamps confidence < 0 up to 0", async () => {
    setupModel("anthropic");
    mockGenerateObject.mockResolvedValueOnce({
      object: { ...VALID_CANDIDATE, confidence: -0.4 },
    });
    const out = await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    expect(out.confidence).toBe(0);
  });

  it("coerces non-finite confidence to 0", async () => {
    setupModel("anthropic");
    mockGenerateObject.mockResolvedValueOnce({
      object: { ...VALID_CANDIDATE, confidence: Number.NaN },
    });
    const out = await extractCandidateEvent({
      email,
      emailAccount: FAKE_EMAIL_ACCOUNT,
      logger: makeMockLogger(),
    });
    expect(out.confidence).toBe(0);
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
