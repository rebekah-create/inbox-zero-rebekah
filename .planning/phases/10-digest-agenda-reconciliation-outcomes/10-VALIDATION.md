---
phase: 10
slug: digest-agenda-reconciliation-outcomes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-23
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Filled by planner during plan-phase; planner reads `10-RESEARCH.md` § "Validation Architecture" for the dimensions to cover.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (per `apps/web` + `packages/resend` existing setup) |
| **Config file** | {path or "none — Wave 0 installs"} |
| **Quick run command** | `{quick command — e.g. pnpm test -- path/to/phase-10-helpers.test.ts}` |
| **Full suite command** | `{full command — e.g. pnpm --filter inbox-zero-ai test -- digest}` |
| **Estimated runtime** | ~{N} seconds |

---

## Sampling Rate

- **After every task commit:** Run `{quick run command}`
- **After every plan wave:** Run `{full suite command}`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** {N} seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| {10-01-01} | 01 | 1 | DIG-{XX} | — | {expected behavior or "N/A"} | unit | `{command}` | ✅ / ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Pure-helper test stubs (overlap detection, agenda transformer, sentence renderers)
- [ ] Fixture extension in `packages/resend/emails/digest-v2.tsx` `PreviewProps` (sample agenda + reconciliation data)
- [ ] Render snapshot harness via `packages/resend/scripts/render-digest-v2.ts`

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real Gmail rendering of overlap pill + Calendar Activity section | DIG-03, DIG-05 | Gmail CSS stripping cannot be unit-tested | Send a test digest to rebekah@trueocean.com via `send-digest-v2-test.ts`, open in real Gmail, confirm pill renders and section borders look correct |
| Sonnet narrative weaves agenda naturally without inventing items | DIG-01 (narrative integration) | Subjective voice quality | Render 3 fixture digests, review narrative text for D-19/D-22 compliance |
| Token-delta ≤ +1000 tokens/digest | OPS-02 (cost ceiling) | Live LLM call required | Capture `saveAiUsage` `promptTokens` for 3 digests pre/post merge from Tinybird |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < {N}s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
