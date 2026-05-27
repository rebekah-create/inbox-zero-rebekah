/**
 * RUN_AI_TESTS-gated live arbitration evaluation against the Phase 11
 * arbitration fixture corpus from plan 11-06. Replays every fixture through
 * the LIVE `arbitrateOverlap` (real Anthropic Haiku call) and asserts the
 * expected verdict + matchedEventId from the fixture's `expectedArbitration`
 * block.
 *
 * Each fixture is also pre-filtered through the pure
 * `findIntervalOverlaps` helper (Phase 11 D-01 / 11-02 substrate). Fixtures
 * that set `shouldCallArbiter: false` MUST short-circuit at the overlap
 * pre-check with zero overlaps and no arbiter call. This validates both the
 * 11-02 substrate and the arbiter in a single eval pass.
 *
 * Default `pnpm test` runs ZERO tests from this file (gated via
 * `describe.runIf(RUN)` where `RUN = process.env.RUN_AI_TESTS === "true"`).
 *
 * Manual local run:
 *   RUN_AI_TESTS=true pnpm test-ai -- utils/calendar/reconciliation/arbitrate.ai
 *
 * Total Anthropic spend per full run: ~$0.01 (3 live arbiter calls — fixtures
 * 01, 04, 05; fixtures 02 and 03 short-circuit at the overlap pre-check and
 * make zero API calls).
 *
 * Phase 11 D-15 / D-16 (eval corpus + RUN_AI_TESTS gating).
 *
 * LOCAL-DEV NOTE: same pnpm flat-store caveat as extract.ai.test.ts. If the
 * file fails at module load on Windows, run `pnpm install --force`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { arbitrateOverlap } from "./arbitrate";
import { findIntervalOverlaps } from "./overlap";

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
  category: "arbitration";
  input: { from: string; subject: string; bodyTruncated: string };
  candidate: {
    title: string;
    startISO: string;
    endISO: string | null;
    location: string | null;
  };
  daySchedule: ArbitrationFixtureScheduleEvent[];
  expectedArbitration: {
    shouldCallArbiter: boolean;
    verdict: "SAME" | "RESCHEDULE" | "SEPARATE" | "SKIP" | null;
    matchedEventIdRef: string | null;
  };
  notes?: string;
};

function loadArbitrationFixtures(): ArbitrationFixture[] {
  const dir = join(FIXTURES_ROOT, "arbitration");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) =>
        JSON.parse(readFileSync(join(dir, f), "utf-8")) as ArbitrationFixture,
    );
}

// The fixture schedule shape is a strict subset of NormalizedCalendarEvent;
// pad missing fields (attendees, description, htmlLink) with empty defaults
// so the arbiter and overlap helper see the canonical shape.
function toNormalized(
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

describe.runIf(RUN)("arbitrate.ai — arbitration fixtures (live Haiku)", () => {
  const fixtures = loadArbitrationFixtures();
  for (const fx of fixtures) {
    it(`fixture ${fx.id}: ${fx.notes ?? ""}`.slice(0, 200), async () => {
      const daySchedule = fx.daySchedule.map(toNormalized);

      // Step 1 — pure overlap pre-check (validates 11-02 substrate too).
      const overlaps = findIntervalOverlaps({
        candidateStartISO: fx.candidate.startISO,
        candidateEndISO: fx.candidate.endISO,
        existingEvents: daySchedule,
      });

      if (!fx.expectedArbitration.shouldCallArbiter) {
        // Fixtures 02 + 03: NO overlap expected, NO arbiter call.
        expect(overlaps).toHaveLength(0);
        return;
      }

      expect(overlaps.length).toBeGreaterThan(0);

      // Step 2 — live arbiter call.
      const result = await arbitrateOverlap({
        email: fx.input,
        candidate: fx.candidate,
        daySchedule,
        emailAccount: makeEmailAccount(),
        logger: makeMockLogger(),
      });

      expect(result.verdict).toBe(fx.expectedArbitration.verdict);

      if (
        fx.expectedArbitration.verdict === "SAME" ||
        fx.expectedArbitration.verdict === "RESCHEDULE"
      ) {
        const expectedId = fx.daySchedule.find(
          (e) => e.id === fx.expectedArbitration.matchedEventIdRef,
        )?.id;
        expect(expectedId).toBeTruthy();
        expect(result.matchedEventId).toBe(expectedId);
      } else {
        expect(result.matchedEventId).toBeNull();
      }
    }, 30_000);
  }
});
