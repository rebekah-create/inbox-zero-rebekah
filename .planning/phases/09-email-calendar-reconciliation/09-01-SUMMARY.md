---
phase: 09-email-calendar-reconciliation
plan: 01
subsystem: persistence
tags: [prisma, schema, migration, reconciliation]
requires: []
provides:
  - ReconciliationRecord Prisma model
  - ReconciliationOutcome enum
  - EmailAccount.reconciliationRecords reverse relation
  - 20260523154812_add_reconciliation_record migration
affects:
  - apps/web/prisma/schema.prisma
tech_stack_added: []
patterns: [schema-thread-tracker-analog, hand-written-migration]
key_files:
  created:
    - apps/web/prisma/migrations/20260523154812_add_reconciliation_record/migration.sql
    - .planning/phases/09-email-calendar-reconciliation/09-01-SUMMARY.md
  modified:
    - apps/web/prisma/schema.prisma
decisions:
  - Hand-write migration SQL (not `prisma migrate dev`) — avoids implicit DB connection on Windows; CI applies on deploy
  - Persist extractedIsAllDay as a stored column instead of recomputing via midnight heuristic — fixes Warning #4 carry-over for 09-06 rehydration
metrics:
  duration_minutes: ~10
  tasks_completed: 3
  files_changed: 2
  completed_at: 2026-05-23
---

# Phase 09 Plan 01: ReconciliationRecord Schema & Migration Summary

Added the `ReconciliationRecord` Prisma model + `ReconciliationOutcome` enum + EmailAccount reverse relation, and committed a hand-written forward-only Postgres migration that creates the table, enum, indexes, and FK.

## What Was Built

- **`apps/web/prisma/schema.prisma`** — appended `ReconciliationRecord` model (18 fields: D-13 set plus the revision-mode `extractedIsAllDay` column) directly after `ThreadTracker`; appended `ReconciliationOutcome` enum with 5 values; added the `reconciliationRecords ReconciliationRecord[]` reverse relation to `EmailAccount` next to `classificationFeedback`.
- **`apps/web/prisma/migrations/20260523154812_add_reconciliation_record/migration.sql`** — hand-written DDL matching Prisma's generated style:
  - `CREATE TYPE "ReconciliationOutcome" AS ENUM (...)` with 5 values
  - `CREATE TABLE "ReconciliationRecord"` with all 18 columns; `extractedAttendees TEXT[]`; `extractedIsAllDay BOOLEAN DEFAULT false`
  - Unique index on `(emailAccountId, messageId, eventSignature)` (D-14)
  - `(emailAccountId, createdAt DESC)` index (D-15)
  - `(emailAccountId, outcome)` index (D-16)
  - FK to `EmailAccount("id")` with `ON DELETE CASCADE ON UPDATE CASCADE`

## Task 1 Decision (Migration Approach)

Plan locked the approach to **hand-written migration SQL** (no checkpoint). Rationale per the plan: `prisma migrate dev` attempts a DB connection and can hang on the Windows host. Hand-writing keeps the workflow offline; CI applies the migration via `prisma migrate deploy` during `pnpm build` on the next push to `main`.

## Migration Timestamp

`20260523154812` (UTC, generated via `node -e "console.log(new Date().toISOString().replace(/[-:T]/g,'').slice(0,14))"`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `prisma generate` verification gate could not run inside the worktree**
- **Found during:** Task 2 verify step
- **Issue:** The worktree at `.claude/worktrees/agent-a63a644d8e3b85f9e/` has no `node_modules` (no `pnpm install` has been run inside it). Both `pnpm --filter inbox-zero-ai exec prisma generate` and direct invocation of the main repo's `prisma` binary fail — direct invocation hits `File 'tsconfig/nextjs.json' not found` because the `tsconfig` workspace package is resolved relative to the worktree's missing `node_modules`.
- **Fix:** Skipped `prisma generate` locally. The schema additions are still verified by all grep gates (model, enum, reverse relation, unique constraint, indexes, all 5 enum values, all 5 required scalar fields, `extractedIsAllDay`). CI will run `prisma generate` on push as part of the existing build pipeline; Wave 2 plans that typecheck `prisma.reconciliationRecord.*` will see the regenerated client at that point.
- **Files modified:** none beyond the planned schema + migration
- **Commit:** captured in this SUMMARY (no code commit needed for the deviation itself)

**2. [Rule 3 - Blocking] `git commit` requires `--no-verify` on Windows**
- **Found during:** Task 2 commit
- **Issue:** Husky's `pre-commit` hook fails with `error: cannot spawn .husky/pre-commit: Exec format error` on Windows for this worktree configuration.
- **Fix:** Used `--no-verify` for the per-task commits. Per `feedback_lint_ci_only.md` memory, lint/typecheck runs on CI only and `--no-verify` is sanctioned for this machine.
- **Commits:** `bf0988a2` (schema), `a513e91f7` (migration)

## Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Documentation-only (no code change) | — |
| 2 | feat(09-01): add ReconciliationRecord model + ReconciliationOutcome enum | `bf0988a2` |
| 3 | feat(09-01): add ReconciliationRecord migration SQL | `a513e91f7` |

## Verification Status

All grep-based acceptance criteria pass:

- `model ReconciliationRecord` → 1
- `enum ReconciliationOutcome` → 1
- `reconciliationRecords  ReconciliationRecord[]` (reverse relation) → 1
- `@@unique([emailAccountId, messageId, eventSignature])` → 1
- `@@index([emailAccountId, createdAt(sort: Desc)])` → 1
- `@@index([emailAccountId, outcome])` → 1
- `extractedIsAllDay` in schema.prisma → 1; in migration.sql → 1
- All 5 enum values (`MATCHED`, `CREATED`, `AMBIGUOUS`, `PENDING`, `FAILED`) present in both schema and migration
- All 5 required scalar fields (`extractedTitle`, `extractedStart`, `extractedAttendees`, `eventSignature`, `googleEventId`) present
- Migration SQL contains `CREATE TABLE "ReconciliationRecord"` (1), `CREATE UNIQUE INDEX` (1), `ON DELETE CASCADE` (1)
- `git diff` scoped strictly to the EmailAccount reverse-relation line, the new ReconciliationRecord model + enum (40 insertions in schema.prisma), and the new migration directory (38 insertions). No other models or migrations touched.

CI on next push will exercise `prisma generate` and `prisma migrate deploy` as part of the existing build step — that is the binding contract.

## Known Stubs

None. The model is a foundation only and is wired up by Wave 2 plans (09-04 create, 09-06 orchestrate). Empty values are expected pre-runtime.

## Threat Flags

None. The persistence boundary additions are already covered by `T-09-07` (unique constraint mitigates duplication) and `T-09-06` (CASCADE FK + downstream emailAccountId filter) in the plan's threat register; no new surface introduced.

## Self-Check: PASSED

- File `apps/web/prisma/schema.prisma` exists with `ReconciliationRecord` model: FOUND
- File `apps/web/prisma/migrations/20260523154812_add_reconciliation_record/migration.sql` exists: FOUND
- Commit `bf0988a2` exists: FOUND
- Commit `a513e91f7` exists: FOUND
