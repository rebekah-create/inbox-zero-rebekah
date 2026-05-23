# Reconciliation Fixture Corpus

This directory holds the labeled reference dataset for the Phase 9 calendar-reconciliation eval suite (`extract.ai.test.ts` + `cost-projection.test.ts` — plan 09-09).

## Provenance

10 of 10 fixtures are either pulled from real Gmail samples in `rebekah@trueocean.com` or hand-crafted as synthetic adversarial / contract probes. Each fixture's `source` field records which.

| Bucket | Count | Source |
|--------|-------|--------|
| `labeled/` (real events) | 5 | 4 real Gmail samples + 1 synthetic multi-event (no real multi-event email surfaced in the inbox during the labeling sweep) |
| `adversarial/` (injection probes) | 3 | All synthetic — real prompt-injection emails are rare in personal inboxes; these are defensive harness fixtures |
| `no-event/` (false-positive guards) | 2 | Real samples (Amazon marketing + Orlando-kids newsletter) |

## Fixture shape

See AI-SPEC §5 Reference Dataset for the canonical schema. Each fixture has:

- `id` — kebab-case, matches the filename
- `category` — `labeled` | `adversarial` | `no-event`
- `source` — provenance note (Gmail thread ID for real samples, or "synthetic" with rationale)
- `input` — `{ from, subject, bodyTruncated, timezone }` — the email the extractor sees
- `expected` — ground-truth labels (shape varies by category)
- `notes` — what this fixture is testing

## Categories

### `labeled/` (real events the extractor SHOULD pick up)

Each `expected` block holds:
- `title`, `startISO`, `endISO`, `location`, `attendees` — the canonical extraction
- `minConfidence` / `maxConfidence` — bounds on the model's confidence
- `isAllDay` — true for date-only events (e.g. multi-day camping reservations)

For multi-event fixtures, `expected.events[]` lists the plausible extractions; the eval accepts ANY ONE of them (v1.1 extracts one event per message).

### `adversarial/` (prompt-injection probes)

`expected` is inverted:
- `maxConfidence` — upper bound (extractor MUST stay below this)
- `titleMustNotContain` — substrings that, if present in the extracted title, indicate the injection succeeded
- `fieldsMustNotEcho` — flag for the eval to check that no extracted field echoes injection markers

### `no-event/` (false-positive resistance)

`expected.maxConfidence` + `expected.titleMustBeEmptyOrIrrelevant` — the extractor must return either no event or a very low-confidence one.

## Updating

Pull more real samples via the Gmail MCP and follow `01-clean-confirmation.json` as the template. Avoid PII beyond what is already in real emails (names + addresses are part of the real signal the extractor must handle).
