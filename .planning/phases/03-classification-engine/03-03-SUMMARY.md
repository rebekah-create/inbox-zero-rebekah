---
plan: 03-03
phase: 03-classification-engine
status: complete
completed: 2026-04-27
wave: 3
---

# Summary: Seed 8 Canonical Classification Rules

## What Was Built

8 Phase 3 classification rules seeded into production Postgres and 6 old content rules removed. Production now has exactly 12 rules: 4 conversation rules (untouched) + 8 new classification rules.

## Pre-Seed State (10 rules)

| Name | systemType | Actions |
|------|-----------|---------|
| Actioned | ACTIONED | LABEL |
| Awaiting Reply | AWAITING_REPLY | LABEL |
| Calendar | CALENDAR | LABEL |
| Cold Email | COLD_EMAIL | LABEL,ARCHIVE |
| FYI | FYI | LABEL |
| Marketing | MARKETING | LABEL,ARCHIVE |
| Newsletter | NEWSLETTER | LABEL,DIGEST |
| Notification | NOTIFICATION | LABEL |
| Receipt | RECEIPT | LABEL |
| To Reply | TO_REPLY | DRAFT_EMAIL,LABEL |

## Post-Seed State (12 rules — verified via psql)

| Name | systemType | Actions |
|------|-----------|---------|
| 2FA | null | LABEL,ARCHIVE |
| Actioned | ACTIONED | LABEL |
| Awaiting Reply | AWAITING_REPLY | LABEL |
| Deals | null | LABEL,ARCHIVE,DIGEST |
| FYI | FYI | LABEL |
| Greers List | null | LABEL,ARCHIVE |
| Marketing | null | LABEL,ARCHIVE |
| Newsletters | null | LABEL,ARCHIVE,DIGEST |
| Receipts | null | LABEL,ARCHIVE,DIGEST |
| To Reply | TO_REPLY | LABEL,DRAFT_EMAIL |
| Uncertain | null | LABEL,DIGEST |
| Urgent | null | LABEL,DIGEST |

## Execution Notes

- **Seed method:** SQL DO block via psql in Postgres container (no tsx in production image)
- **Script committed:** `apps/web/scripts/seed-phase3-rules.ts` (TypeScript, for future use when CI includes scripts dir)
- **Marketing rule:** Old rule (systemType=MARKETING) was overwritten in-place by upsert; deleted count shows 5 but 6 old content rules are gone — correct
- **DIGEST continuity guard:** Passed — Newsletters rule verified to have DIGEST action before old Newsletter rule was removed
- **Greers List:** `from='greers@trueocean.com'`, `conditionalOperator=OR` ✓
- **SSH note:** Security group temporarily opened for execution, revoked immediately after

## CLASS-07 Gap (2FA auto-delete)

2FA rule has LABEL+ARCHIVE only. Auto-delete after 24h (delayInMinutes: 1440) requires a DELETE ActionType not present in the upstream schema. Deferred to future phase. CLASS-07 is partially satisfied: 2FA emails are classified, labeled, and archived — they are not auto-deleted.

## Self-Check: PASSED

- [x] 12 rules in production (4 conversation + 8 new)
- [x] All 8 new rules have systemType=null
- [x] 6 old content rules absent (Calendar, Cold Email, Newsletter, Notification, Receipt deleted; Marketing updated in-place)
- [x] Newsletters has DIGEST action — digest pipeline continuity preserved
- [x] Greers List has from='greers@trueocean.com' and conditionalOperator=OR
- [x] Urgent and Uncertain have no ARCHIVE action (stay in inbox)
- [x] Temporary SSH access revoked after execution
