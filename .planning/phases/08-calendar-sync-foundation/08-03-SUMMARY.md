---
phase: 08-calendar-sync-foundation
plan: 03
subsystem: calendar / oauth
tags: [calendar, oauth, verification]
requires: []
provides:
  - apps/web/scripts/verify-calendar-scopes.ts
affects:
  - production-oauth-grant-audit
tech-stack:
  added: []
  patterns:
    - one-shot tsx operator script
    - read-only DB + Google tokeninfo probe
key-files:
  created:
    - apps/web/scripts/verify-calendar-scopes.ts
  modified: []
decisions:
  - "CalendarConnection schema has no `scope` column; rely on Google `oauth2.tokeninfo` as live source of truth for granted scopes"
  - "Script is read-only by acceptance criteria (no prisma update/delete/create); never prints raw tokens"
metrics:
  completed: 2026-05-22
  tasks_completed: 1_of_2
  status: live-verification-pending-user
---

# Phase 08 Plan 03: Calendar OAuth Scope Verification — Summary

One-liner: Built a read-only tsx script that probes the production CalendarConnection row plus Google `oauth2.tokeninfo` to confirm whether `calendar.readonly` (Phase 8) and `calendar.events` (Phase 9) are actually granted on the live OAuth token.

## What was built

**`apps/web/scripts/verify-calendar-scopes.ts`** (committed: `1a887b560`)

Read-only one-shot script. It:

1. Looks up the first `CalendarConnection` row where `provider = 'google' AND isConnected = true` and prints its non-secret metadata (id, emailAccountId, email, createdAt/updatedAt/expiresAt, presence of access/refresh tokens — never the token values themselves).
2. Prints the code-side `CALENDAR_SCOPES` constant from `apps/web/utils/gmail/scopes.ts` for comparison.
3. Notes that the `CalendarConnection` Prisma model has no `scope`/`scopes` column, so a DB-side scope diff is N/A — Google's tokeninfo is the source of truth.
4. Calls `getCalendarClientWithRefresh(...)` and then `calendarList.list({ maxResults: 1 })`. Prints one of `LIVE_READ_OK`, `LIVE_READ_FAILED (401)`, `LIVE_READ_403_SCOPE_MISSING`, or `LIVE_READ_FAILED: <msg>`.
5. Fetches `https://oauth2.googleapis.com/tokeninfo?access_token=...` and prints `LIVE_TOKENINFO_SCOPES: <space-delimited string>`. This is the authoritative grant on the live token (after any refresh `getCalendarClientWithRefresh` may have performed).
6. Diffs the live scopes vs. `CALENDAR_SCOPES`: prints `expected_only` (missing on the live token) and `extras` (granted but not in the constant — informational only).
7. Prints `CALENDAR_SCOPE_VERDICT: <OK | PARTIAL | FAIL>`:
   - **OK** — live read succeeded AND `calendar.events` is granted (Phase 9 ready)
   - **PARTIAL** — `calendar.readonly` works but `calendar.events` is missing (Phase 8 ok, Phase 9 will 403)
   - **FAIL** — no connection found, or live read 401/403, or tokeninfo unavailable
8. Always `await prisma.$disconnect()` in a `finally` block.

Acceptance-criteria checks (all pass):
- File exists
- Contains `CALENDAR_SCOPES`, `calendarConnection.findFirst`, `calendarList.list`, `CALENDAR_SCOPE_VERDICT`, `prisma.$disconnect`
- Top-of-file comment marks the script as one-shot read-only
- Zero `prisma.*.update | delete | create` calls (verified by grep)

## Task 2: Live verification — DEFERRED to user

The plan's Task 2 is `checkpoint:human-verify` and requires running the script against the **live production database + Google OAuth state**. The executor agent (running in a Windows worktree with no SSH key, no `DATABASE_URL`, no Google client secret) cannot perform the live run. Per the plan's `<resume-signal>` and the parent agent objective, the verdict capture is the user's step.

### How to run

**Option A — inside the production container (recommended, matches plan instructions):**

```bash
ssh -i ~/.ssh/inbox_key ubuntu@inbox.tdfurn.com
docker exec -it $(docker ps --filter name=inbox-zero-app -q) sh
# inside the container:
pnpm exec tsx apps/web/scripts/verify-calendar-scopes.ts
```

Note: this script was committed to a feature branch in a worktree (`worktree-agent-a0c191f0c3b781c17`, commit `1a887b560`). To run it on prod you must either (a) merge the branch to `main` and wait for the auto-deploy that publishes the new image, or (b) `git fetch && git checkout 1a887b560 -- apps/web/scripts/verify-calendar-scopes.ts` inside the container's `/app` directory (the container has the repo path baked in at build time — confirm with `pwd` after `docker exec`). Option (a) is the cleanest path once the verifier passes.

**Option B — local with SSH tunnel to prod DB:**

Only useful if you also have `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`NEXT_PUBLIC_BASE_URL` in `apps/web/.env`. The tokeninfo call would still hit live Google for the production token. Less convenient than Option A.

### What to look for

Capture these lines verbatim from the script output:

- `LIVE_READ_OK` (or one of the failure variants)
- `LIVE_TOKENINFO_SCOPES: <space-delimited string>`
- `CALENDAR_SCOPE_VERDICT: <OK | PARTIAL | FAIL>`

### Disposition matrix

| Verdict | Action | Resume signal |
|---|---|---|
| `OK` | Approve. Phase 9 readiness confirmed. No follow-up. | `approved-OK` |
| `PARTIAL` | Approve Phase 8. Record blocker for Phase 9: must re-consent before Phase 9 event-creation testing. | `approved-PARTIAL-phase9-followup` |
| `FAIL` | Phase 8 is blocked. Re-consent via the OAuth flow (Settings → Connect calendar) and re-run the script. | `blocked-FAIL <paste-output>` |

### Recording the verdict

Once the user runs the script and provides the verdict, the result should be:

1. Pasted into this SUMMARY.md under a new `## Live Verification Result` section (verbatim `LIVE_TOKENINFO_SCOPES` line + verdict + disposition).
2. If `PARTIAL` or `FAIL`: a Pending Todo added to `.planning/STATE.md` capturing the follow-up (Phase 9 re-consent prerequisite, or Phase 8 re-consent + re-run, respectively).

## Deviations from Plan

### Schema vs. plan assumption (informational — no functional change)

**Trigger:** Plan `<read_first>` lists `scope` / `scopes` as candidate column names on `CalendarConnection` and instructs the script to print "the DB-recorded scope string" and diff it vs. `CALENDAR_SCOPES`.

**Finding:** `apps/web/prisma/schema.prisma` lines 1131-1149 show `CalendarConnection` has **no scope column at all** (only `id`, timestamps, `provider`, `email`, `accessToken`, `refreshToken`, `expiresAt`, `isConnected`, `emailAccountId`, relations).

**Resolution:** Script prints an explicit note that the DB-side scope diff is N/A, and treats Google `oauth2.tokeninfo` as the sole source of truth. The diff section now compares **live tokeninfo scopes** vs. `CALENDAR_SCOPES` (rather than DB-scope vs. CALENDAR_SCOPES). This actually matches Q5 of 08-RESEARCH.md — tokeninfo is the authoritative source for "what was actually granted on this token at this moment."

**Classification:** Not a code bug, not a security gap — a plan-text mismatch corrected at implementation time. Recorded here for traceability; no Rule 1–4 action required.

### Auth gates / blockers

None at code-write time. Live verification (Task 2) is a planned human-verify checkpoint, not a deviation.

## Verification

- `grep -q "CALENDAR_SCOPE_VERDICT" apps/web/scripts/verify-calendar-scopes.ts` → match
- `grep -q "prisma.\$disconnect" apps/web/scripts/verify-calendar-scopes.ts` → match
- `grep -nE 'prisma\.[a-zA-Z]+\.(update|delete|create)' apps/web/scripts/verify-calendar-scopes.ts` → no matches (read-only confirmed)
- Acceptance-criteria token-search node one-liner → `OK`

## Self-Check: PASSED

- File `apps/web/scripts/verify-calendar-scopes.ts` exists at HEAD
- Commit `1a887b560` (this worktree) contains the script as a new file
- No STATE.md / ROADMAP.md modifications (executor scope respected)

## Pending — for orchestrator / user

- Run the script against the live prod CalendarConnection (Option A above)
- Append `## Live Verification Result` to this SUMMARY.md with the verbatim tokeninfo line + verdict + disposition
- If `PARTIAL` or `FAIL`: record the appropriate follow-up in STATE.md
