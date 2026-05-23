---
phase: 9
slug: email-calendar-reconciliation
status: draft
nyquist_compliant: false
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
| _to-be-populated-by-planner_ |  |  |  |  |  |  |  |  | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

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
