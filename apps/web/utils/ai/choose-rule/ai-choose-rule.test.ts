import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getEmail,
  getEmailAccount,
  createTestLogger,
} from "@/__tests__/helpers";

// Mock prisma to avoid DB hits.
vi.mock("@/utils/prisma");

// Mock the LLM wrapper. Each test will set the resolved value to simulate
// Haiku's response. Wave 3 will introduce a SECOND call to the wrapper
// (Sonnet escalation); these tests assert the wrapper is called 1x or 2x
// depending on Haiku's confidence/noMatchFound.
const generateObjectMock = vi.fn();
vi.mock("@/utils/llms", () => ({
  createGenerateObject: () => generateObjectMock,
}));

// Mock the model selector so we can assert which slot was requested.
const getModelMock = vi.fn((_user: unknown, slot: string) => ({
  provider: "anthropic",
  modelName:
    slot === "economy" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6",
  slot,
}));
vi.mock("@/utils/llms/model", () => ({
  getModel: (user: unknown, slot: string) => getModelMock(user, slot),
}));

// Import AFTER mocks are declared.
import { aiChooseRule } from "./ai-choose-rule";

const logger = createTestLogger();

function makeFixtures() {
  return {
    email: getEmail({
      from: "seller@amazon.com",
      subject: "Your order has been shipped",
      content: "Your order #123 has been shipped.",
    }),
    emailAccount: getEmailAccount({ multiRuleSelectionEnabled: false }),
    rules: [
      {
        id: "r1",
        name: "Receipts",
        instructions: "Order confirmations and purchase receipts",
      },
    ] as {
      id: string;
      name: string;
      instructions: string;
      systemType?: string | null;
    }[],
    logger,
  };
}

describe("aiChooseRule — Haiku-only classification (CLASS-02)", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    getModelMock.mockClear();
  });

  it("Haiku finds a match -> returns result, single economy call, no Sonnet", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        reasoning: "match",
        ruleName: "Receipts",
        noMatchFound: false,
        confidenceScore: 0.9,
      },
    });
    const fx = makeFixtures();
    const result = await aiChooseRule(fx);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(getModelMock).toHaveBeenCalledWith(expect.anything(), "economy");
    expect(getModelMock).not.toHaveBeenCalledWith(expect.anything(), "default");
    expect(result.rules[0].rule.name).toBe("Receipts");
  });

  it("Haiku finds a match with low confidence -> still returns result, no Sonnet", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        reasoning: "weak match",
        ruleName: "Receipts",
        noMatchFound: false,
        confidenceScore: 0.5,
      },
    });
    const fx = makeFixtures();
    await aiChooseRule(fx);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(getModelMock).not.toHaveBeenCalledWith(expect.anything(), "default");
  });

  it("Haiku noMatchFound=true -> returns empty rules, single economy call, no Sonnet", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        reasoning: "no match",
        ruleName: null,
        noMatchFound: true,
        confidenceScore: 0.3,
      },
    });
    const fx = makeFixtures();
    const result = await aiChooseRule(fx);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(getModelMock).not.toHaveBeenCalledWith(expect.anything(), "default");
    expect(result.rules).toHaveLength(0);
  });
});

describe("aiChooseRule — Anthropic prompt caching request shape (OPS-03)", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    getModelMock.mockClear();
    generateObjectMock.mockResolvedValue({
      object: {
        reasoning: "x",
        ruleName: "Receipts",
        noMatchFound: false,
        confidenceScore: 0.9,
      },
    });
  });

  it("Anthropic + single-rule: passes system as SystemModelMessage[] with ephemeral cacheControl, prompt as string", async () => {
    getModelMock.mockImplementationOnce((_user: unknown, slot: string) => ({
      provider: "anthropic",
      modelName: "claude-haiku-4-5-20251001",
      slot,
    }));
    const fx = makeFixtures();
    await aiChooseRule(fx);

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const callArg = generateObjectMock.mock.calls[0][0];
    expect(Array.isArray(callArg.system)).toBe(true);
    expect(callArg.system[0].role).toBe("system");
    expect(typeof callArg.system[0].content).toBe("string");
    expect(callArg.system[0].content.length).toBeGreaterThan(100);
    expect(callArg.system[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(typeof callArg.prompt).toBe("string");
    expect(callArg.messages).toBeUndefined();
  });

  it("non-Anthropic (openai) + single-rule: keeps system+prompt shape, no messages, no cacheControl anywhere", async () => {
    getModelMock.mockImplementationOnce((_user: unknown, slot: string) => ({
      provider: "openai",
      modelName: "gpt-4o-mini",
      slot,
    }));
    const fx = makeFixtures();
    await aiChooseRule(fx);

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const callArg = generateObjectMock.mock.calls[0][0];
    expect(typeof callArg.system).toBe("string");
    expect(callArg.system.length).toBeGreaterThan(100);
    expect(typeof callArg.prompt).toBe("string");
    expect(callArg.messages).toBeUndefined();
    expect(JSON.stringify(callArg)).not.toContain("cacheControl");
  });

  it("Anthropic + multi-rule: passes system as SystemModelMessage[] with ephemeral cacheControl", async () => {
    getModelMock.mockImplementation((_user: unknown, slot: string) => ({
      provider: "anthropic",
      modelName:
        slot === "economy" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6",
      slot,
    }));
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        matchedRules: [{ ruleName: "Receipts", isPrimary: true }],
        noMatchFound: false,
        reasoning: "match",
      },
    });

    const fx = makeFixtures();
    fx.emailAccount = getEmailAccount({ multiRuleSelectionEnabled: true });
    await aiChooseRule(fx);

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const callArg = generateObjectMock.mock.calls[0][0];
    expect(Array.isArray(callArg.system)).toBe(true);
    expect(typeof callArg.system[0].content).toBe("string");
    expect(callArg.system[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(typeof callArg.prompt).toBe("string");
    expect(callArg.messages).toBeUndefined();
  });

  it("non-Anthropic (openai) + multi-rule: keeps system+prompt shape, no cacheControl", async () => {
    getModelMock.mockImplementation((_user: unknown, slot: string) => ({
      provider: "openai",
      modelName: "gpt-4o-mini",
      slot,
    }));
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValueOnce({
      object: {
        matchedRules: [{ ruleName: "Receipts", isPrimary: true }],
        noMatchFound: false,
        reasoning: "match",
      },
    });

    const fx = makeFixtures();
    fx.emailAccount = getEmailAccount({ multiRuleSelectionEnabled: true });
    await aiChooseRule(fx);

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    const callArg = generateObjectMock.mock.calls[0][0];
    expect(typeof callArg.system).toBe("string");
    expect(typeof callArg.prompt).toBe("string");
    expect(callArg.messages).toBeUndefined();
    expect(JSON.stringify(callArg)).not.toContain("cacheControl");
  });
});
