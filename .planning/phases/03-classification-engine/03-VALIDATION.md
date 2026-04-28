---
phase: 3
slug: classification-engine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-27
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.4 |
| **Config file** | `apps/web/vitest.config.mts` |
| **Quick run command** | `pnpm test -- match-rules.test.ts` |
| **Full suite command** | `pnpm test` (from repo root) |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- [specific test file for task]`
- **After every plan wave:** Run `pnpm test` (full suite from repo root)
- **Before `/gsd-verify-work`:** Full suite must be green + manual CLASS-04, CLASS-05, CLASS-08 checks
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-W0-01 | W0 | 0 | CLASS-02 | unit | `pnpm test -- ai-choose-rule.test.ts` | ❌ Wave 0 | ⬜ pending |
| 3-01-01 | 01 | 1 | CLASS-03 | unit | `pnpm test -- run-rules.test.ts` | ✅ extend | ⬜ pending |
| 3-02-01 | 02 | 2 | CLASS-01 | unit | `pnpm test -- match-rules.test.ts` | ✅ extend | ⬜ pending |
| 3-03-01 | 03 | 3 | CLASS-02 | unit | `pnpm test -- ai-choose-rule.test.ts` | ❌ Wave 0 | ⬜ pending |
| 3-03-02 | 03 | 3 | CLASS-06 | unit | `pnpm test -- match-rules.test.ts` | ✅ extend | ⬜ pending |
| 3-03-03 | 03 | 3 | CLASS-07 | unit | `pnpm test -- match-rules.test.ts` | ✅ extend | ⬜ pending |
| 3-04-01 | 04 | 4 | CLASS-04 | manual | SSH: query ExecutedRule after test email | — | ⬜ pending |
| 3-04-02 | 04 | 4 | CLASS-05 | manual | Check ScheduledAction table after 2FA test email | — | ⬜ pending |
| 3-04-03 | 04 | 4 | CLASS-08 | manual | Send test email, monitor logs, verify <2min | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/web/utils/ai/choose-rule/ai-choose-rule.test.ts` — stubs for CLASS-02 escalation logic
  - Test: Haiku confidence 0.9 → no escalation to Sonnet
  - Test: Haiku confidence 0.7 → escalation to Sonnet
  - Test: Haiku `noMatchFound=true` → escalation to Sonnet
  - Test: Haiku confidence exactly 0.8 → no escalation (strict less-than)

*Wave 0 must be complete before Wave 3 (code changes).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Urgent/Uncertain stay in inbox | CLASS-04 | Requires live Gmail labels + actual email delivery | SSH into server, send test email from non-rule sender, query `ExecutedRule` and verify no ARCHIVE action fired |
| 2FA auto-deleted after 24h | CLASS-05 | Requires BullMQ delayed job execution in production | Send test 2FA-pattern email, verify `ScheduledAction` table has DELETE row with future `scheduledAt`, verify Gmail deletion after 24h |
| Classification within 2 minutes | CLASS-08 | Requires live PubSub → webhook → execution path | Send test email, monitor server logs via `docker compose logs -f app`, verify classification row appears within 120 seconds |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (ai-choose-rule.test.ts)
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
