---
phase: 01-ops-fixes
plan: 01
subsystem: infra
tags: [docker, docker-compose, ghcr, containers]

requires: []
provides:
  - "docker-compose.yml references fork image (ghcr.io/rebekah-create/inbox-zero-rebekah:latest) for web and worker"
  - "Production server running fork image, not upstream elie222"
affects: [01-ops-fixes-plan-03, future-deploy]

tech-stack:
  added: []
  patterns: ["Fork image reference in docker-compose.yml — all future deploys pull from fork registry"]

key-files:
  created: []
  modified:
    - docker-compose.yml

key-decisions:
  - "Server compose file was already updated (fork image present before git pull) — docker compose pull + up -d confirmed running containers"

patterns-established:
  - "docker-compose.yml is the authoritative deploy config; server must match git"

requirements-completed:
  - OPS-04

duration: 15min
completed: 2026-04-27
---

# Plan 01-01: Fix docker-compose.yml Image References — Summary

**Fork image (`ghcr.io/rebekah-create/inbox-zero-rebekah:latest`) now used for both web and worker on server; upstream elie222 image fully replaced**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-04-27
- **Tasks:** 2 (1 auto + 1 human-action checkpoint)
- **Files modified:** 1

## Accomplishments
- Changed web service image from `ghcr.io/elie222/inbox-zero:latest` to `ghcr.io/rebekah-create/inbox-zero-rebekah:latest`
- Changed worker service image from `ghcr.io/elie222/inbox-zero:latest` to `ghcr.io/rebekah-create/inbox-zero-rebekah:latest`
- Server's `/opt/inbox-zero/docker-compose.yml` confirmed up to date with fork image
- Running containers confirmed via `docker ps` to be using the fork image

## Task Commits

1. **Task 1: Update image references** — `c9ca4cf` (ops(OPS-04): use fork image in docker-compose.yml)
2. **Task 2: Server deploy** — human-action checkpoint; confirmed via `docker ps` output

## Files Created/Modified
- `docker-compose.yml` — web and worker image references changed to fork

## Decisions Made
- Server compose file was already showing the fork image before the deploy step (possibly updated manually or via prior git pull). Ran `docker compose pull && docker compose up -d` to ensure running containers reflected the correct image.

## Deviations from Plan
None — plan executed exactly as written.

## Issues Encountered
None.

## Self-Check: PASSED

## Next Phase Readiness
- OPS-04 closed: production containers now pull from fork registry
- Plan 01-03 (Wave 2) can proceed once CI (Plan 01-02) is confirmed green

---
*Phase: 01-ops-fixes*
*Completed: 2026-04-27*
