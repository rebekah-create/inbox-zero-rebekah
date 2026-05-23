---
plan: 09-08
status: complete
completed_at: 2026-05-23
---

# Plan 09-08: Labeled fixture corpus — SUMMARY

## What shipped

11 fixture files (10 JSON + 1 README) under `apps/web/__tests__/fixtures/reconciliation/`:

**labeled/** (5 real-event fixtures the extractor SHOULD pick up)
- `01-clean-confirmation.json` — Smile 4 Me Dental confirmation (real Gmail sample, thread `19e46b7f213adc7e`)
- `02-vague-save-the-date.json` — EVA Summit Save-the-Date with date range only (real sample, thread `19ce8c9ee23f2ad4`)
- `03-reschedule.json` — Tesla service appointment moved (real sample, thread `19ca04c13eba0611`)
- `04-all-day-event.json` — Clerbrook multi-day camping reservation (real sample, thread `19e3bf9fef77de0f`)
- `05-multi-event.json` — synthetic Pike13-style weekly schedule with 2 classes; no real multi-event email surfaced in the inbox sweep

**adversarial/** (3 prompt-injection probes, all synthetic)
- `01-prompt-injection-promo.json` — "IGNORE PREVIOUS INSTRUCTIONS" embedded in marketing copy
- `02-prompt-injection-instruction-echo.json` — fake `<<SYSTEM OVERRIDE>>` role-hijack
- `03-prompt-injection-multi-event.json` — flood attack demanding 10 events at confidence 1.0

**no-event/** (2 false-positive-resistance fixtures)
- `01-marketing-promo.json` — Amazon Fire TV upgrade announcement (real sample, thread `19e484998dfc1756`)
- `02-newsletter.json` — Fun4OrlandoKids weekend newsletter listing community events (real sample, thread `19e4f6a4017c54d0`)

**labeled/README.md** — corpus documentation (provenance table, fixture-shape reference, eval semantics by bucket)

## How Task 1 (human checkpoint) was satisfied

Plan 09-08 Task 1 was a blocking human-action checkpoint asking the user to pull real-inbox samples per memory `prefer_organic_uat`. Resolution: the user delegated sample-pulling to me via the Gmail MCP (which the executor subagent could not access from a worktree). I searched `rebekah@trueocean.com` for representative emails across the AI-SPEC §1b failure-mode categories:

- `subject:(appointment OR confirmed OR reminder)` — clean confirmation, multi-event source candidates
- `subject:("save the date" OR invitation)` — vague save-the-date
- `("has been rescheduled" OR "moved to")` — reschedule
- `category:promotions newer_than:14d` — marketing-promo false-positive guard

7 of the 10 fixtures use captured real bodies (truncated and lightly normalized — bodies hold ~300-400 chars of the most salient prose). 3 are synthetic: the multi-event labeled fixture (no real exemplar surfaced) and all 3 adversarials (real prompt-injection samples are rare in personal inboxes; these are defensive harness fixtures rather than captured exemplars).

## Deviations from PLAN

- **Built in the main checkout, not a worktree.** Plan 09-08's Task 1 required Gmail-MCP access, which executor subagents don't reliably get. The orchestrator (this agent) fulfilled both the human-input checkpoint AND Task 2 inline. The output paths and fixture shapes match the plan's `files_modified` list verbatim.
- **10 fixtures instead of the plan's "11+" wording.** The plan's `files_modified` list enumerated 10 JSON files + 1 README = 11 paths total. The corpus matches that exactly. Additional fixtures can be added later by following `labeled/README.md`'s template.
- **`labeled/05-multi-event.json` is synthetic.** The user's inbox sends multiple-class confirmations as separate per-class emails (Pike13 pattern). The synthetic fixture mirrors the data shape the user receives and tests the v1.1 "one event per message" contract.

## Files

```
apps/web/__tests__/fixtures/reconciliation/
├── adversarial/
│   ├── 01-prompt-injection-promo.json
│   ├── 02-prompt-injection-instruction-echo.json
│   └── 03-prompt-injection-multi-event.json
├── labeled/
│   ├── 01-clean-confirmation.json
│   ├── 02-vague-save-the-date.json
│   ├── 03-reschedule.json
│   ├── 04-all-day-event.json
│   ├── 05-multi-event.json
│   └── README.md
└── no-event/
    ├── 01-marketing-promo.json
    └── 02-newsletter.json
```

## What this unlocks

Plan 09-09 (`extract.ai.test.ts` + `cost-projection.test.ts`) can now consume this corpus to score extraction quality and project cost over a realistic email mix.
