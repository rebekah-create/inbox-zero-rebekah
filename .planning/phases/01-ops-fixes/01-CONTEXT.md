# Phase 1: Ops Fixes - Context

**Gathered:** 2026-04-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the server infrastructure fully operational and locked down for single-tenant use. This phase verifies and closes four specific operational requirements that were partially implemented in prior work sessions. No new features are built — only ops tasks verified, fixed, and confirmed working.

</domain>

<decisions>
## Implementation Decisions

### OPS-01: Digest from address
- **D-01:** The code fix is already committed — `RESEND_FROM_EMAIL` defaults to `Inbox Zero <inbox-digest@tdfurn.com>` in `apps/web/env.ts`. The remaining task is verifying `RESEND_FROM_EMAIL=inbox-digest@tdfurn.com` is set in the server `.env` (via AWS Parameter Store) and that a digest email actually arrives from that address.

### OPS-02: Signup lockdown
- **D-02:** Lock by **domain** — `AUTH_ALLOWED_EMAIL_DOMAINS=trueocean.com`. Any `@trueocean.com` address can sign in; all others are blocked. The env var mechanism already exists in `apps/web/utils/auth-signup-policy.ts`. Needs verification that it's set on the server.

### OPS-03: CI/CD pipeline
- **D-03:** **Upgrade** the existing `docker-build.yml` workflow. Current state: arm64-only, `latest` tag only. Target state: **multi-platform** (linux/arm64 + linux/amd64) using standard QEMU-based buildx (no Depot dependency), tagged with both `latest` and **short SHA** (e.g., `abc1234`). Trigger: push to main only. Registry: `ghcr.io/rebekah-create/inbox-zero-rebekah`.
- **D-04:** Deployment step is **manual** — CI builds and pushes only. Server update is done by SSH + `docker compose pull && docker compose up -d` when ready.

### OPS-04: Fork image in docker-compose.yml
- **D-05:** Update `docker-compose.yml` in the repo to reference the fork image (`ghcr.io/rebekah-create/inbox-zero-rebekah:latest`) instead of the upstream image (`ghcr.io/elie222/inbox-zero:latest`) for the `web` and `worker` services.

### Verification scope
- **D-06:** Phase 1 plans must **verify** all 4 OPS requirements end-to-end — not just confirm code is present. A requirement is done when it can be demonstrated working (digest arrives from correct address, second signup is blocked, CI workflow runs successfully, server runs fork image).

### Claude's Discretion
- Order of plan execution (suggest: OPS-04 first since it's a code change, then CI/CD upgrade, then server env verification last since it requires SSH access)
- Exact format of SHA tag in CI workflow (short SHA from `github.sha`)
- Whether to add `workflow_dispatch` trigger to CI as a quality-of-life improvement (user said push-to-main only, so leave it out unless it adds no complexity)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Infrastructure & deployment
- `docker-compose.yml` — current service definitions; `web` and `worker` services reference upstream image, need to be updated to fork image
- `.github/workflows/docker-build.yml` — existing CI workflow to be upgraded (arm64-only → multi-platform + SHA tags)
- `CLAUDE.md` — fork context, production deployment process, secret management (AWS Parameter Store)
- `deploy/` — systemd service, secret-loading script, and rebuild runbook

### Auth & signup
- `apps/web/utils/auth-signup-policy.ts` — signup allowlist logic; reads `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_EMAIL_DOMAINS` from env
- `apps/web/env.ts` — Zod env schema; `AUTH_ALLOWED_EMAIL_DOMAINS` and `RESEND_FROM_EMAIL` definitions

### Email (digest)
- `apps/web/env.ts` lines 200-210 — `RESEND_FROM_EMAIL` definition with `inbox-digest@tdfurn.com` default

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/web/utils/auth-signup-policy.ts` — already handles domain-level and email-level allowlists; no code change needed, only env var
- `apps/web/env.ts` — `RESEND_FROM_EMAIL` default already set correctly; no code change needed, only server env var

### Established Patterns
- Secrets are stored in AWS Parameter Store under `/inbox-zero/` and loaded to `/opt/inbox-zero/.env` at boot via `deploy/load-secrets.sh` — any new env vars must be added there
- The CI workflow uses `ubuntu-24.04-arm` runner for native arm64 builds; multi-platform will need to switch to `ubuntu-latest` + QEMU for cross-compilation

### Integration Points
- `docker-compose.yml` `web` and `worker` services are the deployment units; image change here is the OPS-04 fix
- GitHub Actions `GITHUB_TOKEN` is already used for GHCR push (no new secrets needed for the registry push)

</code_context>

<specifics>
## Specific Ideas

- CI should use `ubuntu-latest` (x86) + QEMU for multi-platform builds rather than the arm runner (arm runners can't cross-compile to amd64 natively without QEMU anyway)
- SHA tag format: `type=sha,prefix=` produces `abc1234`-style tags — use docker/metadata-action for consistent tag generation

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 1-Ops Fixes*
*Context gathered: 2026-04-27*
