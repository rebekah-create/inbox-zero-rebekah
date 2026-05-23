---
phase: 9
slug: email-calendar-reconciliation
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-22
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Populated from 09-RESEARCH.md `## Validation Architecture` and 09-AI-SPEC.md Section 5.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) — `apps/web/` workspace |
| **Config file** | `apps/web/vitest.config.ts` (existing) |
| **Quick run command** | `pnpm test -- path/to/file.test.ts` (from `apps/web`) |
| **Full suite command** | `pnpm test` (non-AI) + `RUN_AI_TESTS=true pnpm test-ai` (manual, pre-merge) + `pnpm test-integration` (manual) |
| **Estimated runtime** | unit ~10s; AI tests ~60s (manual); integration ~30s (manual) |

---

## Sampling Rate

- **After every task commit:** Run the new test file added by that task (`pnpm test -- path/to/new.test.ts`).
- **After every plan wave:** Run `pnpm test` (full non-AI suite in `apps/web`).
- **Before `/gsd-verify-work`:** `pnpm test` must be green + `RUN_AI_TESTS=true pnpm test-ai` run once locally against the reconciliation fixtures + integration suite run once.
- **CI gate:** `pnpm test` + `pnpm exec ultracite check` on every push (existing GitHub Actions).
- **Max feedback latency:** 30s for unit; 90s for full suite excluding AI tests.

---

## Per-Task Verification Map

> Populated by `gsd-planner` as PLAN.md tasks are written. Each task's `<automated>` block lands here.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-T1 | 09-01 | 1 | REC-04, REC-05 | — | Doc-only: locks migration approach | doc | `echo` (no-op) | ✅ | ⬜ pending |
| 09-01-T2 | 09-01 | 1 | REC-04, REC-05 | T-09-07 | Schema declares ReconciliationRecord + D-14 unique | schema | `grep -c "model ReconciliationRecord" apps/web/prisma/schema.prisma` + `pnpm --filter inbox-zero-ai exec prisma generate` | ❌ W0 | ⬜ pending |
| 09-01-T2b | 09-01 | 1 | REC-04 | — | extractedIsAllDay revision column present (so 09-06 stale-PENDING rehydration reads the persisted LLM flag instead of guessing) | schema | `grep -c "extractedIsAllDay" apps/web/prisma/schema.prisma` (expect ≥ 1) + `grep -c "extractedIsAllDay" apps/web/prisma/migrations/*_add_reconciliation_record/migration.sql` (expect ≥ 1) | ❌ W0 | ⬜ pending |
| 09-01-T3 | 09-01 | 1 | REC-04, REC-05 | T-09-07 | Forward migration SQL created with FK CASCADE + unique index | migration | `grep -c "CREATE TABLE \"ReconciliationRecord\"" apps/web/prisma/migrations/*_add_reconciliation_record/migration.sql` | ❌ W0 | ⬜ pending |
| 09-02-T1 | 09-02 | 1 | REC-03 (Dice) | — | Pure titleSimilarity Dice on whitespace bigrams | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/dice --run` | ❌ W0 | ⬜ pending |
| 09-02-T2 | 09-02 | 1 | REC-05 | T-09-07 | eventSignature deterministic hash | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/signature --run` | ❌ W0 | ⬜ pending |
| 09-02-T3 | 09-02 | 1 | REC-03, REC-06 | — | decideOutcome decision tree (D-08, D-23) | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/match --run` | ❌ W0 | ⬜ pending |
| 09-03-T1 | 09-03 | 2 | REC-01, REC-02 | T-09-01 | SYSTEM_PROMPT_TEMPLATE + buildExtractionSystem cache shape | unit/grep | `grep -B5 "cacheControl" extract-prompt.ts \| grep -c 'type: "text"'` (expect 0) + node sibling-check | ❌ W0 | ⬜ pending |
| 09-03-T2 | 09-03 | 2 | REC-02, OPS-02 | T-09-01, T-09-04 | candidateEventSchema + extractCandidateEvent + label="Reconciliation extract" | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/extract --run` | ❌ W0 | ⬜ pending |
| 09-03-T3 | 09-03 | 2 | EVT-01, REC-01 | T-09-02 | extractFromIcs LLM-free | unit/grep | `cd apps/web && pnpm test -- utils/calendar/reconciliation/ics-path --run` + grep gate for no LLM imports | ❌ W0 | ⬜ pending |
| 09-04-T1 | 09-04 | 2 | REC-04, REC-05 | T-09-05, T-09-07 | persist.ts P2002 catch via isDuplicateError + PII-safe logging | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/persist --run` | ❌ W0 | ⬜ pending |
| 09-05-T1 | 09-05 | 2 | EVT-03, EVT-04 | — | createCalendarEvent with [AI] prefix + source-email back-ref | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/create-event --run` | ❌ W0 | ⬜ pending |
| 09-06-T1 | 09-06 | 3 | REC-01 | — | matchesKeywordBackstop pure helper (D-02) | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/index --run -t matchesKeywordBackstop` | ❌ W0 | ⬜ pending |
| 09-06-T2 | 09-06 | 3 | REC-01, REC-02, REC-03, REC-05, REC-06, EVT-05, OPS-01 | T-09-04, T-09-05, T-09-07 | reconcileMessage D-12 sequence + stale-PENDING reuse skips Haiku + no rethrow | unit | `cd apps/web && pnpm test -- utils/calendar/reconciliation/index --run` + grep `throw` count=0 | ❌ W0 | ⬜ pending |
| 09-07-T1 | 09-07 | 4 | OPS-01, EVT-05 | — | Pre-edit verification of process-history-item.ts integration site | checkpoint | (human verify) | ✅ | ⬜ pending |
| 09-07-T2 | 09-07 | 4 | OPS-01, EVT-05, REC-01 | T-09-05 | Insert new after() block with reconcileMessage call | grep | `grep -c "reconcile-message" apps/web/utils/webhook/process-history-item.ts` (expect 1) + after() count >= 3 | ✅ | ⬜ pending |
| 09-07-T3 | 09-07 | 4 | OPS-01, EVT-05 | — | reconciliation invocation + failure-isolation tests (runRules / handleOutboundMessage) | unit | `cd apps/web && pnpm test -- utils/webhook/process-history-item --run` | ✅ | ⬜ pending |
| 09-08-T1 | 09-08 | 4 | OPS-02 | T-09-01 | User-curated fixture corpus | checkpoint | (human action) | ✅ | ⬜ pending |
| 09-08-T2 | 09-08 | 4 | OPS-02 | T-09-01 | Fixture JSON files conform to AI-SPEC §5 shape + isAllDay present on labeled | shape | `ls apps/web/__tests__/fixtures/reconciliation/labeled/*.json` + node isAllDay check | ❌ W0 | ⬜ pending |
| 09-09-T1 | 09-09 | 5 | OPS-02 | T-09-01 | extract.ai.test.ts gated by RUN_AI_TESTS | manual-AI | `cd apps/web && pnpm test -- utils/calendar/reconciliation/extract.ai --run` (expect 0 tests gated) + manual `RUN_AI_TESTS=true pnpm test-ai` | ❌ W0 | ⬜ pending |
| 09-09-T2 | 09-09 | 5 | OPS-02 | T-09-04 | cost-projection.test.ts with real saveAiUsage spy capture (approach a LOCKED) | manual-AI | `cd apps/web && pnpm test -- utils/calendar/reconciliation/cost-projection --run` (gated) + grep tautology=0 + manual AI run | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky · File Exists: ✅ exists · ❌ W0 = executor creates*

---

## Wave 0 Requirements

- [ ] `apps/web/utils/calendar/reconciliation/__tests__/match.test.ts` — pure-function tests for Dice + decision tree (REC-03, REC-06)
- [ ] `apps/web/utils/calendar/reconciliation/__tests__/extract.test.ts` — Zod schema validation tests (no live LLM call)
- [ ] `apps/web/utils/calendar/reconciliation/__tests__/extract.ai.test.ts` — `RUN_AI_TESTS=true` gated tests against labeled fixtures (REC-01, REC-02, prompt-injection T-09-01)
- [ ] `apps/web/utils/calendar/reconciliation/__tests__/persist.test.ts` — Prisma idempotency tests with mocked Prisma client (REC-04, REC-05)
- [ ] `apps/web/utils/calendar/reconciliation/__tests__/reconcile.test.ts` — orchestrator integration tests with mocked `getUpcomingEvents`, mocked Google client, real Zod (EVT-05, OPS-01)
- [ ] `apps/web/__tests__/fixtures/reconciliation/` — directory with 20–30 labeled real-inbox fixtures per 09-AI-SPEC.md §5 Reference Dataset spec

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `cache_read_input_tokens > 0` for extraction prompt within 24h of deploy | OPS-03 / D-19 inheritance | Anthropic Console only — no API to assert from CI | Open Anthropic Console → Usage → filter by `claude-haiku` → confirm cache-read tokens > 0 for reconciliation calls |
| Real-inbox per-month cost projection ≤ $1/mo extraction (well inside $10/mo cap) | OPS-02 | Requires accumulated real traffic | Tail `AiUsage` rows tagged with reconciliation label after 7 days of prod; project to monthly |
| `[AI]`-prefixed event appears in Google Calendar UI with source-email back-ref in description | EVT-03, EVT-04 | Visual confirmation in Google Calendar | After a CREATED outcome, open Google Calendar web UI, find the event, verify title prefix + clickable Gmail thread link in description |
| Calendar rule enabled on rebekah@trueocean.com's account | D-09, REC-01 | Per-account DB state | Prisma query: `prisma.rule.findFirst({ where: { emailAccountId, systemType: 'CALENDAR' }, select: { enabled: true } })` — must return `enabled: true` before merge (assumption A2 in RESEARCH §additional findings) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s for full non-AI suite
- [ ] `nyquist_compliant: true` set in frontmatter
- [ ] Three RESEARCH.md assumptions (A1: ECONOMY_LLM_MODEL SSM, A2: Calendar rule enabled, A3: ephemeral 1024-tok floor) verified

**Approval:** pending
