/**
 * OPS-02 cost-projection assertion against the labeled fixture corpus from
 * plan 09-08. Spies on `saveAiUsage` (from `@/utils/usage`) across a LIVE
 * Haiku extraction run, projects monthly cost from REAL captured token counts
 * times CURRENT Haiku pricing constants, and asserts the projection stays
 * under the $1.00/month extraction budget at both the expected (90 calls/mo)
 * and pessimistic (200 calls/mo, 4x safety margin) volumes.
 *
 * METHODOLOGY (LOCKED — approach (a) per plan 09-09 checker blocker #1):
 *   Real-token capture via `saveAiUsage` spy. Hard-coding the AI-SPEC §4
 *   per-call estimate (~0.2 cents) as a tautological fallback is FORBIDDEN —
 *   it would assert AI-SPEC math against AI-SPEC math and bypass the whole
 *   point of OPS-02 cost validation.
 *
 * Default `pnpm test` runs ZERO tests from this file (RUN_AI_TESTS gating).
 * Manual local run:
 *   RUN_AI_TESTS=true pnpm test-ai -- utils/calendar/reconciliation/cost-projection
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on saveAiUsage — must be hoisted via vi.mock BEFORE importing extract.
// Per RESEARCH.md §5: saveAiUsage lives at apps/web/utils/usage.ts and is
// invoked internally by createGenerateObject (which extract.ts wraps).
const saveAiUsageSpy = vi.fn();
vi.mock("@/utils/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/usage")>();
  return {
    ...actual,
    saveAiUsage: (...args: Parameters<typeof actual.saveAiUsage>) => {
      saveAiUsageSpy(...args);
      return actual.saveAiUsage(...args);
    },
  };
});

// Import AFTER mock so the wrapper above intercepts createGenerateObject's call.
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { arbitrateOverlap } from "./arbitrate";
import { extractCandidateEvent } from "./extract";

const RUN = process.env.RUN_AI_TESTS === "true";

// ---------------------------------------------------------------------------
// Haiku 4.5 pricing constants — snapshot from Anthropic pricing page 2026-05-22.
// Update both the constants AND this date comment when pricing changes.
// Source of truth: ai-frameworks.md
// ---------------------------------------------------------------------------
const PRICE_INPUT_PER_M = 1.0; // $/1M uncached input tokens
const PRICE_CACHED_INPUT_READ_PER_M = 0.1; // $/1M cache-read tokens (90% off)
const PRICE_CACHE_WRITE_PER_M = 1.25; // $/1M cache-write tokens (25% premium)
const PRICE_OUTPUT_PER_M = 5.0; // $/1M output tokens

const MONTHLY_VOLUME = 90; // CONTEXT mid-estimate (30-90 calls/mo)
const PESSIMISTIC_VOLUME = 200; // 4x safety margin per OPS-02 review
const COST_BUDGET_PER_MONTH = 1.0; // $/mo extraction budget ($10/mo cap minus headroom)

// Phase 11 cost ceilings (11-CONTEXT.md success criterion 6 + 11-06 plan).
// Both Haiku calls (extract + arbitrate) MUST stay within these bounds:
//   - per-message worst case (extract + arbitrate combined) <= $0.01
//   - projected monthly cost at PESSIMISTIC_VOLUME=200 with 30% overlap rate
//     <= $2.00 (leaves $8/mo headroom under the $10/mo overall cap)
const PER_MESSAGE_COST_CEILING = 0.01;
const COMBINED_MONTHLY_BUDGET = 2.0;
const ARBITRATION_RATE = 0.3; // fraction of extract calls that trigger arbiter

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

type UsagePayload = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};

function perCallCost(u: UsagePayload): number {
  const i = u.inputTokens ?? 0;
  const o = u.outputTokens ?? 0;
  const cr = u.cachedInputTokens ?? 0;
  const cw = u.cacheCreationInputTokens ?? 0;
  return (
    (i / 1_000_000) * PRICE_INPUT_PER_M +
    (cr / 1_000_000) * PRICE_CACHED_INPUT_READ_PER_M +
    (cw / 1_000_000) * PRICE_CACHE_WRITE_PER_M +
    (o / 1_000_000) * PRICE_OUTPUT_PER_M
  );
}

describe.runIf(RUN)(
  "extract.ai — cost projection (OPS-02, real token capture)",
  () => {
    beforeEach(() => {
      saveAiUsageSpy.mockClear();
    });

    it("projects monthly extraction cost <= $1/mo at expected (90) and pessimistic (200) volumes", async () => {
      const FIXTURES_ROOT = join(
        import.meta.dirname,
        "../../../__tests__/fixtures/reconciliation",
      );
      const labeled = readdirSync(join(FIXTURES_ROOT, "labeled"))
        .filter((f) => f.endsWith(".json"))
        .map((f) =>
          JSON.parse(readFileSync(join(FIXTURES_ROOT, "labeled", f), "utf-8")),
        );

      expect(labeled.length).toBeGreaterThanOrEqual(5);

      // Run every labeled fixture through LIVE extraction;
      // saveAiUsageSpy collects usage.
      for (const fx of labeled) {
        await extractCandidateEvent({
          email: {
            from: fx.input.from,
            subject: fx.input.subject,
            bodyTruncated: fx.input.bodyTruncated,
          },
          emailAccount: makeEmailAccount(),
          logger: makeMockLogger(),
        });
      }

      // Aggregate real token counts across all calls. The
      // saveAiUsageSpy.mock.calls array is the source of truth — if it is
      // empty the test MUST fail (no fallback to a hard-coded estimate).
      expect(saveAiUsageSpy).toHaveBeenCalledTimes(labeled.length);

      const costs = saveAiUsageSpy.mock.calls.map((args) => {
        const usage: UsagePayload = (args[0] as { usage: UsagePayload }).usage;
        return perCallCost(usage);
      });

      const avgPerCall = costs.reduce((s, c) => s + c, 0) / costs.length;
      const projectedMonthly = avgPerCall * MONTHLY_VOLUME;
      const projectedPessimistic = avgPerCall * PESSIMISTIC_VOLUME;

      // Diagnostic output for SUMMARY.md
      console.log(
        JSON.stringify(
          {
            fixtureCount: labeled.length,
            avgPerCallCostUsd: avgPerCall,
            projectedMonthlyAtExpectedVolume: projectedMonthly,
            projectedMonthlyAtPessimisticVolume: projectedPessimistic,
            monthlyVolume: MONTHLY_VOLUME,
            pessimisticVolume: PESSIMISTIC_VOLUME,
            budget: COST_BUDGET_PER_MONTH,
            pricingSnapshotDate: "2026-05-22",
          },
          null,
          2,
        ),
      );

      expect(projectedMonthly).toBeLessThanOrEqual(COST_BUDGET_PER_MONTH);
      expect(projectedPessimistic).toBeLessThanOrEqual(COST_BUDGET_PER_MONTH);
    }, 300_000);
  },
);

// ---------------------------------------------------------------------------
// Phase 11 — arbitration cost projection (11-06).
// Mirrors the extract block above: spies on saveAiUsage across the LIVE
// arbitrateOverlap path, computes real per-call cost from captured tokens,
// then asserts both the combined per-message worst-case ceiling and the
// monthly projection under PESSIMISTIC_VOLUME with a 30% arbitration rate.
//
// Fixtures with shouldCallArbiter=false are skipped here — they make zero
// API calls by design.
// ---------------------------------------------------------------------------

type ArbitrationFixtureScheduleEvent = {
  id: string;
  title: string;
  start: string;
  end: string | null;
  location: string | null;
  isAllDay: boolean;
};

type ArbitrationFixture = {
  id: string;
  input: { from: string; subject: string; bodyTruncated: string };
  candidate: {
    title: string;
    startISO: string;
    endISO: string | null;
    location: string | null;
  };
  daySchedule: ArbitrationFixtureScheduleEvent[];
  expectedArbitration: { shouldCallArbiter: boolean };
};

function toNormalizedForCost(
  e: ArbitrationFixtureScheduleEvent,
): NormalizedCalendarEvent {
  return {
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end ?? "",
    location: e.location,
    isAllDay: e.isAllDay,
    attendees: [],
    description: null,
    htmlLink: "",
  } as NormalizedCalendarEvent;
}

describe.runIf(RUN)(
  "arbitrate.ai — cost projection (Phase 11, real token capture)",
  () => {
    beforeEach(() => {
      saveAiUsageSpy.mockClear();
    });

    it("combined extract+arbitrate per-message worst case <= $0.01 and projected monthly <= $2 at PESSIMISTIC_VOLUME", async () => {
      const FIXTURES_ROOT = join(
        import.meta.dirname,
        "../../../__tests__/fixtures/reconciliation",
      );

      // --- Pass A: capture EXTRACT costs across the labeled corpus (same
      //     as the extract block above; re-run here to keep the two passes
      //     symmetric and so this block stands alone if extract is later
      //     refactored out).
      const labeled = readdirSync(join(FIXTURES_ROOT, "labeled"))
        .filter((f) => f.endsWith(".json"))
        .map((f) =>
          JSON.parse(readFileSync(join(FIXTURES_ROOT, "labeled", f), "utf-8")),
        );
      expect(labeled.length).toBeGreaterThanOrEqual(5);

      for (const fx of labeled) {
        await extractCandidateEvent({
          email: {
            from: fx.input.from,
            subject: fx.input.subject,
            bodyTruncated: fx.input.bodyTruncated,
          },
          emailAccount: makeEmailAccount(),
          logger: makeMockLogger(),
        });
      }
      const extractCallCount = saveAiUsageSpy.mock.calls.length;
      expect(extractCallCount).toBe(labeled.length);
      const extractCosts = saveAiUsageSpy.mock.calls.map((args) =>
        perCallCost((args[0] as { usage: UsagePayload }).usage),
      );
      const avgExtractCost =
        extractCosts.reduce((s, c) => s + c, 0) / extractCosts.length;
      const maxExtractCost = Math.max(...extractCosts);

      // --- Pass B: capture ARBITRATE costs across the arbitration corpus,
      //     limited to fixtures that actually make the call.
      saveAiUsageSpy.mockClear();
      const arbitration: ArbitrationFixture[] = readdirSync(
        join(FIXTURES_ROOT, "arbitration"),
      )
        .filter((f) => f.endsWith(".json"))
        .map((f) =>
          JSON.parse(
            readFileSync(join(FIXTURES_ROOT, "arbitration", f), "utf-8"),
          ),
        );

      const callable = arbitration.filter(
        (fx) => fx.expectedArbitration.shouldCallArbiter,
      );
      expect(callable.length).toBeGreaterThanOrEqual(3);

      for (const fx of callable) {
        await arbitrateOverlap({
          email: fx.input,
          candidate: fx.candidate,
          daySchedule: fx.daySchedule.map(toNormalizedForCost),
          emailAccount: makeEmailAccount(),
          logger: makeMockLogger(),
        });
      }
      const arbitrateCallCount = saveAiUsageSpy.mock.calls.length;
      expect(arbitrateCallCount).toBe(callable.length);
      const arbitrateCosts = saveAiUsageSpy.mock.calls.map((args) =>
        perCallCost((args[0] as { usage: UsagePayload }).usage),
      );
      const avgArbitrateCost =
        arbitrateCosts.reduce((s, c) => s + c, 0) / arbitrateCosts.length;
      const maxArbitrateCost = Math.max(...arbitrateCosts);

      // --- Ceilings ----------------------------------------------------
      //
      // Worst-case per-message cost = worst-extract + worst-arbitrate.
      // (Every reconciled message extracts once; only overlap-bearing
      // messages also arbitrate. The worst-case message pays both.)
      const worstCasePerMessageCost = maxExtractCost + maxArbitrateCost;

      // Projected monthly cost = extract-per-message * volume + arbitrate
      // -per-message * (volume * ARBITRATION_RATE). Uses PESSIMISTIC_VOLUME
      // (200/mo) per the OPS-02 + Phase 11 4x safety margin.
      const projectedMonthlyCost =
        avgExtractCost * PESSIMISTIC_VOLUME +
        avgArbitrateCost * PESSIMISTIC_VOLUME * ARBITRATION_RATE;

      console.log(
        JSON.stringify(
          {
            phase: "11-06 arbitration cost projection",
            fixtureCounts: {
              labeled: labeled.length,
              arbitrationCallable: callable.length,
            },
            avgExtractCostUsd: avgExtractCost,
            avgArbitrateCostUsd: avgArbitrateCost,
            maxExtractCostUsd: maxExtractCost,
            maxArbitrateCostUsd: maxArbitrateCost,
            worstCasePerMessageCostUsd: worstCasePerMessageCost,
            projectedMonthlyCostUsd: projectedMonthlyCost,
            pessimisticVolume: PESSIMISTIC_VOLUME,
            arbitrationRate: ARBITRATION_RATE,
            perMessageCeiling: PER_MESSAGE_COST_CEILING,
            combinedMonthlyBudget: COMBINED_MONTHLY_BUDGET,
            pricingSnapshotDate: "2026-05-22",
          },
          null,
          2,
        ),
      );

      // Assertion: worstCasePerMessageCost <= 0.01 (per 11-CONTEXT.md success
      // criterion 6).
      expect(worstCasePerMessageCost).toBeLessThanOrEqual(
        PER_MESSAGE_COST_CEILING,
      );
      // Assertion: projectedMonthlyCost <= 2.00 at PESSIMISTIC_VOLUME=200
      // with 30% arbitration rate (leaves $8/mo headroom under the
      // $10/mo overall cap).
      expect(projectedMonthlyCost).toBeLessThanOrEqual(COMBINED_MONTHLY_BUDGET);
    }, 600_000);
  },
);
