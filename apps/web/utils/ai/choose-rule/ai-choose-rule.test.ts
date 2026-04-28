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

describe("aiChooseRule — Haiku to Sonnet escalation (CLASS-02)", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    getModelMock.mockClear();
  });

  it("Haiku confidence 0.9 -> no escalation (single AI call, economy slot)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        reasoning: "match",
        ruleName: "Receipts",
        noMatchFound: false,
        confidenceScore: 0.9,
      },
    });
    const fx = makeFixtures();
    await aiChooseRule(fx);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(getModelMock).toHaveBeenCalledWith(expect.anything(), "economy");
    expect(getModelMock).not.toHaveBeenCalledWith(expect.anything(), "default");
  });

  it("Haiku confidence 0.7 -> escalation to Sonnet (two AI calls)", async () => {
    generateObjectMock
      .mockResolvedValueOnce({
        object: {
          reasoning: "weak",
          ruleName: "Receipts",
          noMatchFound: false,
          confidenceScore: 0.7,
        },
      })
      .mockResolvedValueOnce({
        object: {
          reasoning: "strong",
          ruleName: "Receipts",
          noMatchFound: false,
          confidenceScore: 0.95,
        },
      });
    const fx = makeFixtures();
    await aiChooseRule(fx);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(getModelMock).toHaveBeenCalledWith(expect.anything(), "economy");
    expect(getModelMock).toHaveBeenCalledWith(expect.anything(), "default");
  });

  it("Haiku noMatchFound=true -> escalation to Sonnet (two AI calls)", async () => {
    generateObjectMock
      .mockResolvedValueOnce({
        object: {
          reasoning: "no match",
          ruleName: null,
          noMatchFound: true,
          confidenceScore: 0.99,
        },
      })
      .mockResolvedValueOnce({
        object: {
          reasoning: "found it",
          ruleName: "Receipts",
          noMatchFound: false,
          confidenceScore: 0.9,
        },
      });
    const fx = makeFixtures();
    await aiChooseRule(fx);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(getModelMock).toHaveBeenCalledWith(expect.anything(), "default");
  });

  it("Haiku confidence exactly 0.8 -> no escalation (strict less-than per CONTEXT D-02)", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        reasoning: "borderline",
        ruleName: "Receipts",
        noMatchFound: false,
        confidenceScore: 0.8,
      },
    });
    const fx = makeFixtures();
    await aiChooseRule(fx);
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(getModelMock).not.toHaveBeenCalledWith(expect.anything(), "default");
  });
});
