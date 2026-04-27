# Phase 1: Ops Fixes - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-27
**Phase:** 1-Ops Fixes
**Areas discussed:** CI/CD workflow design, Deploy step scope, Signup lockdown behavior, Phase 1 scope review

---

## CI/CD Workflow Design

| Option | Description | Selected |
|--------|-------------|----------|
| Multi-platform (arm64 + amd64) | Covers both EC2 (ARM) and x86 dev machines. Free with QEMU-based buildx. | ✓ |
| arm64-only | Faster builds, perfect for t4g.small. Excludes x86. | |
| amd64-only | Runs under emulation on ARM EC2. Simplest workflow. | |

**User's choice:** Multi-platform (arm64 + amd64)

| Option | Description | Selected |
|--------|-------------|----------|
| Push to main only | Clean signal, simple and predictable. | ✓ |
| Push to main + manual dispatch | Adds workflow_dispatch for UI-triggered rebuilds. | |

**User's choice:** Push to main only

| Option | Description | Selected |
|--------|-------------|----------|
| latest + short SHA | Enables rollback via SHA tags alongside stable latest pointer. | ✓ |
| latest only | Simplest. No rollback via tag. | |

**User's choice:** latest + short SHA

---

## Deploy Step Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Manual SSH + deploy | CI builds and pushes only. Developer SSHs and runs docker compose pull + up when ready. | ✓ |
| Auto-deploy via CI | CI SSHs into EC2 and restarts Docker after image push. More complex, SSH key in GitHub secrets. | |

**User's choice:** Manual SSH + deploy
**Notes:** User prefers control over when production restarts.

---

## Phase 1 Scope Review

User noted that most ops fixes were already worked through in a prior chat session. Codebase confirmed:
- RESEND_FROM_EMAIL default already fixed in env.ts
- CI/CD workflow already exists (but arm64-only/latest-only — needs upgrade)
- AUTH_ALLOWED_EMAILS already in codebase (needs server env var verified)
- docker-compose.yml still references upstream elie222 image (OPS-04 still open)

| Option | Description | Selected |
|--------|-------------|----------|
| Just remaining gaps | Plan only OPS-04 + server env verification | |
| Full verification of all 4 tasks | Plan to verify and confirm all 4 OPS requirements working end-to-end | ✓ |
| Skip Phase 1 | Treat as complete and move to Phase 2 | |

**User's choice:** Full verification of all 4 ops tasks

| Option | Description | Selected |
|--------|-------------|----------|
| Leave CI as-is | arm64-only/latest-only — it works | |
| Upgrade to multi-platform + SHA tags | Add amd64, add SHA tag, enable rollbacks | ✓ |

**User's choice:** Upgrade to multi-platform + SHA tags

---

## Signup Lockdown Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| @trueocean.com domain | AUTH_ALLOWED_EMAIL_DOMAINS=trueocean.com — any trueocean.com address | ✓ |
| rebekah@trueocean.com only | AUTH_ALLOWED_EMAILS=rebekah@trueocean.com — most restrictive | |

**User's choice:** @trueocean.com domain

---

## Claude's Discretion

- Order of plan execution within Phase 1
- Exact SHA tag format in CI workflow
- Whether to add workflow_dispatch trigger (user said push-to-main only, leave it out)

## Deferred Ideas

None — discussion stayed within phase scope.
