---
plan: 03-04
phase: 03-classification-engine
status: complete
completed: 2026-04-28
wave: 4
commit: 42fdd8ec1
---

# Summary: Two-Call Escalation, confidenceScore Threading, Meta-Rule Guard, Deploy

## What Was Built

Three-tier classification pipeline wired end-to-end: Haiku runs first, Sonnet escalates only when
confidenceScore < 0.8 or noMatchFound. confidenceScore threads from Zod schema through to the
ExecutedRule row in Postgres. Conversation tracking meta-rule excluded from AI prompts.

## Code Changes (commit 42fdd8ec1)

### ai-choose-rule.ts
- Added `confidenceScore?: number` to `aiChooseRule()` return type
- Added `confidenceScore` to Zod schema in `getAiResponseSingleRule()`:
  `confidenceScore: z.number().min(0).max(1)`
- Replaced single `getAiResponse()` with two-call escalation:
  - Tier 2: Haiku via `getModel(user, "economy")`
  - Escalate if `noMatchFound || confidenceScore < 0.8`
  - Tier 3: Sonnet via `getModel(user, "default")` only when needed

### run-rules.ts
- Added `confidenceScore?: number | null` to `RunRulesResult` type
- Extended `executeMatchedRule()` with `confidenceScore` parameter
- Added `confidenceScore: confidenceScore ?? null` to both `prisma.executedRule.create()` calls
- Passed `results.confidenceScore` through from `runRules()` call site

### match-rules.ts
- Imported `CONVERSATION_TRACKING_META_RULE_ID` from run-rules
- Added meta-rule guard in `findPotentialMatchingRules()` per-rule loop
- Added `confidenceScore?: number` to `MatchingRulesResult`
- Threaded `confidenceScore` through `findMatchingRulesWithReasons()`

## Database Migration

Migration `20260427100000_add_confidence_score` applied manually to production:
```sql
ALTER TABLE "ExecutedRule" ADD COLUMN "confidenceScore" DOUBLE PRECISION;
```
Applied: 2026-04-28T16:19:11Z  
Method: psql -f via docker exec (image was built before migration commit, so applied directly)  
Recorded in `_prisma_migrations`: yes

## Test Results

4 RED→GREEN escalation tests in `ai-choose-rule.test.ts` — all passing:
- haiku-confident: Haiku 0.9 confidence → no escalation → returns haiku result
- haiku-low-confidence: Haiku 0.3 → escalates to Sonnet → returns sonnet result
- haiku-no-match: Haiku noMatchFound=true → escalates to Sonnet → returns sonnet result
- haiku-no-match-sonnet-no-match: both tiers noMatchFound → returns null

## Production Verification

- App health: `{"status":"ok"}`
- confidenceScore column: `double precision` in `ExecutedRule` ✓
- Migration recorded in `_prisma_migrations` ✓
- No "falling back to default model" log entries ✓

## Self-Check: PASSED

- [x] Two-call escalation in ai-choose-rule.ts (Haiku first, Sonnet on low confidence)
- [x] confidenceScore in Zod schema (min 0, max 1)
- [x] confidenceScore threads through all layers to executedRule.create()
- [x] Meta-rule guard excludes CONVERSATION_TRACKING_META_RULE_ID from AI prompts
- [x] All 4 escalation tests GREEN
- [x] confidenceScore column in production DB
- [x] Migration recorded in _prisma_migrations
- [x] App healthy post-deploy
