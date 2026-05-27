# Arbitration eval fixtures (Phase 11)

This directory holds the Phase 11 arbitration eval corpus — fixtures that
exercise the new time-interval overlap + Haiku-arbitration matching path that
replaces Phase 9's title-similarity (token-Dice) matching.

These fixtures are companions to the Phase 9 `labeled/` corpus but have a
different shape: in addition to the email input, each fixture carries the
synthetic `daySchedule` (existing calendar events for the candidate day) and
an `expectedArbitration` block describing what the arbiter should do — or
whether it should even be called at all.

## Schema

```json
{
  "id": "<NN>-<slug>",
  "category": "arbitration",
  "source": "<describe origin — synthetic vs real-thread-paraphrase>",
  "input": {
    "from": "<sender>",
    "subject": "<subject>",
    "bodyTruncated": "<<=2000 chars, mirrors the index.ts truncateBody cap>",
    "timezone": "America/New_York"
  },
  "candidate": {
    "title": "<extracted candidate title>",
    "startISO": "<ISO with tz offset>",
    "endISO": "<ISO|null>",
    "location": "<str|null>"
  },
  "daySchedule": [
    {
      "id": "evt_a",
      "title": "...",
      "start": "<ISO with tz offset>",
      "end": "<ISO with tz offset>",
      "location": "...",
      "isAllDay": false
    }
  ],
  "expectedArbitration": {
    "shouldCallArbiter": true,
    "verdict": "SAME|RESCHEDULE|SEPARATE|SKIP|null",
    "matchedEventIdRef": "evt_a|null"
  },
  "notes": "<rationale, links to incidents, decision-coverage notes>"
}
```

## Difference vs `labeled/`

`labeled/` fixtures test the **extractor** — given an email, does Haiku
produce the right `{title, start, end, location}` candidate? They have
no `daySchedule` and no arbitration block.

`arbitration/` fixtures test the **arbiter** + the upstream **overlap
substrate** together — given an extracted candidate AND a daySchedule, does
the system (a) correctly decide whether an arbiter call is even needed, and
(b) if called, return the right verdict?

The two corpora share the prompt-injection / cost-projection harness but
exercise different stages of the pipeline.

## `shouldCallArbiter: false` cases

Fixtures with `expectedArbitration.shouldCallArbiter === false` are
validated by the eval harness via a pre-check that calls
`findIntervalOverlaps` (the pure 11-02 helper) and asserts the result is
empty. The harness does NOT invoke the live arbiter for these cases — the
whole point of these fixtures is to lock in the deterministic CREATE path
that dodges the arbiter entirely. This doubles as a regression test for the
11-02 interval substrate.

Fixtures 02 (math-vs-piano disambiguation) and 03 (camping future date) use
this mode.

## `RUN_AI_TESTS` gate

The live arbiter eval (`arbitrate.ai.test.ts`) is gated behind
`RUN_AI_TESTS=true`, mirroring `extract.ai.test.ts`. Default `pnpm test`
runs zero live calls and costs zero dollars; manual local runs use:

```
RUN_AI_TESTS=true pnpm test-ai -- utils/calendar/reconciliation/arbitrate.ai
```

Per-run cost is ~$0.01 across the 3 fixtures that actually call the arbiter
(fixtures 01, 04, 05). Fixtures 02 and 03 are zero-cost — they short-circuit
on the overlap pre-check.

The extended `cost-projection.test.ts` aggregates the extract-call and
arbiter-call `saveAiUsage` payloads to enforce the Phase 11 cost ceilings:

- Worst-case combined per-message cost (extract + arbitrate) <= $0.01
- Projected monthly cost at PESSIMISTIC_VOLUME=200, assuming 30% overlap
  rate, <= $2.00 (headroom for the $10/mo total cap)

## Fixture-by-fixture summary

| # | Slug | shouldCallArbiter | Expected verdict | Decision covered |
|---|------|-------------------|------------------|------------------|
| 01 | music-class-collision | true | SAME | Piano-vs-Music regression of 2026-05-26 |
| 02 | math-vs-piano-disambiguation | false | n/a | 11-02 substrate: no-overlap CREATE |
| 03 | camping-future-date | false | n/a | >14-day-out CREATE path |
| 04 | true-reschedule | true | RESCHEDULE | D-09 explicit reschedule wording |
| 05 | marketing-skip | true | SKIP | Keyword false-positive safety valve |

## Authoring notes

- Bodies are capped at 2000 chars (matches `truncateBody` in `index.ts`).
- All ISO timestamps use `America/New_York` offset (-04:00 May, -05:00
  Nov-Feb). Dates anchor on the 2026-05-26 project baseline.
- Synthetic content is paraphrased from real inbox samples rather than
  copied verbatim. Personal details (names, addresses, confirmation
  numbers) are either fictional or redacted. The README is the place to
  call out which fixture is based on which real thread, by date — never
  by raw body content.
