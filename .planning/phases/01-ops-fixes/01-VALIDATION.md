---
phase: 1
slug: ops-fixes
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-27
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `apps/web/vitest.config.ts` |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | OPS-04 | — | N/A | code review | `grep -n "elie222" docker-compose.yml` | ✅ | ⬜ pending |
| 1-02-01 | 02 | 1 | OPS-03 | — | N/A | CI run | trigger via `git push` to main | ✅ | ⬜ pending |
| 1-03-01 | 03 | 2 | OPS-02 | — | Non-trueocean.com blocked | unit | `pnpm test -- auth-signup-policy` | ✅ | ⬜ pending |
| 1-03-02 | 03 | 2 | OPS-02 | — | N/A | manual smoke | — (requires live server) | — | ⬜ pending |
| 1-04-01 | 04 | 2 | OPS-01 | — | N/A | manual smoke | — (requires live Resend API) | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `apps/web/utils/auth-signup-policy.test.ts` — unit tests for domain-block behavior (OPS-02) — created by PLAN-03 Task 0

Check if test file already exists:
```bash
find apps/web -name "*.test.ts" | xargs grep -l "auth-signup-policy" 2>/dev/null
```

*PLAN-03 Task 0 creates this file if absent before any other Task 0 verify runs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Digest arrives from inbox-digest@tdfurn.com | OPS-01 | Requires live Resend API + active account + cron timing | SSH to server, trigger digest manually: `docker exec inbox-zero-web pnpm digest:send`; check inbox for email from inbox-digest@tdfurn.com |
| Second signup is blocked | OPS-02 | Requires live OAuth + server | Attempt sign-in with a non-trueocean.com Google account; expect rejection screen |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
