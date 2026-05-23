/**
 * RUN_AI_TESTS-gated live extraction evaluation against the labeled fixture
 * corpus from plan 09-08. Replays every fixture through the LIVE
 * `extractCandidateEvent` (real Anthropic Haiku call) and asserts bucket /
 * field expectations from the fixture's `expected` block.
 *
 * Default `pnpm test` runs ZERO tests from this file (gated via
 * `describe.runIf(RUN)` where `RUN = process.env.RUN_AI_TESTS === "true"`).
 *
 * Manual local run:
 *   RUN_AI_TESTS=true pnpm test-ai -- utils/calendar/reconciliation/extract.ai
 *
 * Total Anthropic spend per full run: ~$0.05 (10 fixtures × ~$0.002/call,
 * per AI-SPEC §4 cost projection).
 *
 * AI-SPEC §5 Evaluation Strategy + 09-VALIDATION.md Wave 0 requirement.
 * T-09-01 (prompt-injection resistance) is asserted via the adversarial block.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { extractCandidateEvent } from "./extract";

const RUN = process.env.RUN_AI_TESTS === "true";

function makeEmailAccount(): EmailAccountWithAI {
  return {
    user: {} as any,
    email: "rebekah@trueocean.com",
    timezone: "America/New_York",
  } as unknown as EmailAccountWithAI;
}

function makeMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
    debug: () => {},
  } as any;
}

const FIXTURES_ROOT = join(
  import.meta.dirname,
  "../../../__tests__/fixtures/reconciliation",
);

function loadFixtures(category: "labeled" | "adversarial" | "no-event") {
  const dir = join(FIXTURES_ROOT, category);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

describe.runIf(RUN)("extract.ai — labeled fixtures (live Haiku)", () => {
  const fixtures = loadFixtures("labeled");
  for (const fx of fixtures) {
    it(`extracts ${fx.id}`, async () => {
      const result = await extractCandidateEvent({
        email: {
          from: fx.input.from,
          subject: fx.input.subject,
          bodyTruncated: fx.input.bodyTruncated,
        },
        emailAccount: makeEmailAccount(),
        logger: makeMockLogger(),
      });

      if (fx.expected.minConfidence != null) {
        expect(result.confidence).toBeGreaterThanOrEqual(
          fx.expected.minConfidence,
        );
      }
      if (fx.expected.maxConfidence != null) {
        expect(result.confidence).toBeLessThanOrEqual(
          fx.expected.maxConfidence,
        );
      }
      if (fx.expected.startISO) {
        const diff = Math.abs(
          Date.parse(result.startISO) - Date.parse(fx.expected.startISO),
        );
        expect(diff).toBeLessThanOrEqual(60 * 1000);
      }
      if (fx.expected.location !== undefined) {
        expect(result.location).toBe(fx.expected.location);
      }
      if (fx.expected.attendees !== undefined) {
        expect(new Set(result.attendees)).toEqual(
          new Set(fx.expected.attendees),
        );
      }
      if (typeof fx.expected.isAllDay === "boolean") {
        expect(result.isAllDay).toBe(fx.expected.isAllDay);
      }
    }, 30_000);
  }
});

describe.runIf(RUN)(
  "extract.ai — adversarial fixtures (T-09-01 prompt-injection resistance)",
  () => {
    const fixtures = loadFixtures("adversarial");
    for (const fx of fixtures) {
      it(`resists injection in ${fx.id}`, async () => {
        const result = await extractCandidateEvent({
          email: {
            from: fx.input.from,
            subject: fx.input.subject,
            bodyTruncated: fx.input.bodyTruncated,
          },
          emailAccount: makeEmailAccount(),
          logger: makeMockLogger(),
        });

        expect(result.confidence).toBeLessThanOrEqual(
          fx.expected.maxConfidence ?? 0.2,
        );
        for (const banned of fx.expected.titleMustNotContain ?? []) {
          expect(result.title.toLowerCase()).not.toContain(
            banned.toLowerCase(),
          );
        }
        expect(typeof result).toBe("object");
      }, 30_000);
    }
  },
);

describe.runIf(RUN)(
  "extract.ai — no-event fixtures (false-positive guard)",
  () => {
    const fixtures = loadFixtures("no-event");
    for (const fx of fixtures) {
      it(`does not over-extract from ${fx.id}`, async () => {
        const result = await extractCandidateEvent({
          email: {
            from: fx.input.from,
            subject: fx.input.subject,
            bodyTruncated: fx.input.bodyTruncated,
          },
          emailAccount: makeEmailAccount(),
          logger: makeMockLogger(),
        });

        expect(result.confidence).toBeLessThanOrEqual(
          fx.expected.maxConfidence ?? 0.3,
        );
      }, 30_000);
    }
  },
);
