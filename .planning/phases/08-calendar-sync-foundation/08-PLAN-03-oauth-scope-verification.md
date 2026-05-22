---
phase: 08-calendar-sync-foundation
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/web/scripts/verify-calendar-scopes.ts
autonomous: false
requirements:
  - CAL-01
tags:
  - calendar
  - oauth
  - verification

must_haves:
  truths:
    - "A standalone verification script lists the granted scopes on the live CalendarConnection row for rebekah@trueocean.com and prints whether they cover calendar.readonly, calendar.events, and calendar.freebusy"
    - "The script's output makes it obvious in <30s of reading whether Phase 8 read-path will work and whether Phase 9 event creation will work"
    - "The script does NOT modify any data — read-only against Postgres + an inspect call against Google tokeninfo or calendarList.list"
    - "A human checkpoint records the observed scope set vs. the code constants in CALENDAR_SCOPES, with explicit accept/redirect-to-reconsent disposition"
  artifacts:
    - path: "apps/web/scripts/verify-calendar-scopes.ts"
      provides: "tsx-runnable verification script — pnpm exec tsx apps/web/scripts/verify-calendar-scopes.ts"
      exports: ["main"]
  key_links:
    - from: "apps/web/scripts/verify-calendar-scopes.ts"
      to: "Postgres CalendarConnection row"
      via: "prisma.calendarConnection.findFirst({ where: { provider: 'google', isConnected: true } })"
      pattern: "calendarConnection.findFirst"
    - from: "apps/web/scripts/verify-calendar-scopes.ts"
      to: "Google OAuth tokeninfo OR calendarList.list"
      via: "getCalendarClientWithRefresh + calendarList.list (or oauth2.tokeninfo)"
      pattern: "calendarList.list|tokeninfo"
---

<objective>
Soft-verify that the live `CalendarConnection` row for the production account has been consented with the scopes the code constants (`CALENDAR_SCOPES` in `apps/web/utils/gmail/scopes.ts`) expect. This is the "soft check, not a blocker" task flagged in 08-RESEARCH.md Q5 and Risk #5: if the user consented before `calendar.events` was added to the constants, Phase 8 will work (calendar.readonly) but Phase 9 event creation will 403 — and we want to know that NOW, not later.

Purpose: Catch the silent-failure mode where Phase 8 ships green but Phase 9 trips a 403 the day it ships. The fix (re-consent) costs the user 30 seconds in a browser; the time wasted debugging in Phase 9 without this check is hours.

Output: One throwaway script + one human verification checkpoint recording the scope set actually granted.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md
@.planning/phases/08-calendar-sync-foundation/08-RESEARCH.md
@CLAUDE.md
@apps/web/utils/gmail/scopes.ts
@apps/web/utils/calendar/client.ts

<interfaces>
<!-- The code-side scope expectation that we're verifying against. -->

From `apps/web/utils/gmail/scopes.ts:14-24` (verbatim per 08-RESEARCH.md lines 242-249):
```ts
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];
```

The `CalendarConnection` Prisma row has a `scope` column (or equivalent) holding what was actually consented at the time the connection was made. Schema lookup via `apps/web/prisma/schema.prisma` confirms the exact column name.

Google's `oauth2.tokeninfo` endpoint accepts an `access_token` and returns `{ scope: "space-delimited list", ... }` — this is the live source of truth for what the token is currently authorized to do. If `oauth2.tokeninfo` is awkward, `calendar.calendarList.list()` succeeding is sufficient evidence for `calendar.readonly`, and a HEAD/dry-run on `events.insert` (without actually inserting) is awkward — better to just check `tokeninfo`.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write a tsx-runnable verification script that reports live scope coverage</name>
  <files>apps/web/scripts/verify-calendar-scopes.ts</files>
  <read_first>
    - apps/web/utils/gmail/scopes.ts (CALENDAR_SCOPES constant — what code expects)
    - apps/web/utils/calendar/client.ts (getCalendarClientWithRefresh — how to obtain a live client)
    - apps/web/prisma/schema.prisma (CalendarConnection table — confirm column names: `scope` or `scopes`, `accessToken`, `refreshToken`, `expiresAt`, `provider`, `isConnected`, `emailAccountId`)
    - Glob `apps/web/scripts/**/*.ts` for an existing tsx-runnable script to mirror style (logger setup, prisma teardown via `prisma.$disconnect()`)
  </read_first>
  <action>
    Create `apps/web/scripts/verify-calendar-scopes.ts`. The script:

    1. Imports `prisma`, `CALENDAR_SCOPES` from `@/utils/gmail/scopes`, `getCalendarClientWithRefresh`, and `createScopedLogger`.

    2. Queries `prisma.calendarConnection.findFirst({ where: { provider: 'google', isConnected: true }, select: { id: true, emailAccountId: true, accessToken: true, refreshToken: true, expiresAt: true, scope: true /* or scopes */ } })`. If the column is named differently in the schema (e.g. `scopes`), use the actual name.

    3. If null → print "NO ACTIVE GOOGLE CALENDAR CONNECTION FOUND" and exit 2.

    4. Print:
       - The DB-recorded scope string (split on space)
       - The code-expected `CALENDAR_SCOPES` constant
       - A diff: `expected_only` (in code constant but NOT in DB scope), `extra` (in DB but not in code — informational only)

    5. Call `getCalendarClientWithRefresh(...)` and then `client.calendarList.list({ maxResults: 1 })`. If it succeeds → print `LIVE_READ_OK`. If it 401s → print `LIVE_READ_FAILED: <message>`. If it 403s → print `LIVE_READ_403_SCOPE_MISSING: <message>`.

    6. Optionally call Google's `oauth2.tokeninfo` (the `getCalendarClientWithRefresh` exposes the auth client — use it to issue a `https://oauth2.googleapis.com/tokeninfo?access_token=...` GET via the global fetch). Parse the response `scope` field. Print as `LIVE_TOKENINFO_SCOPES`. This is the source of truth — DB column can drift from what Google actually has on the live token.

    7. Final summary line: `CALENDAR_SCOPE_VERDICT: OK` if (a) live read succeeded AND (b) live tokeninfo scope includes `calendar.events` (Phase 9 readiness). Else `CALENDAR_SCOPE_VERDICT: PARTIAL — phase 8 ok, phase 9 will 403` if read OK but no events scope. Else `CALENDAR_SCOPE_VERDICT: FAIL — re-consent required`.

    8. Always `await prisma.$disconnect()` in a finally block.

    Add a top-of-file comment: `// One-shot operator script. Run via: pnpm exec tsx apps/web/scripts/verify-calendar-scopes.ts. Read-only. Does not modify Postgres or Google state.`
  </action>
  <verify>
    <automated>node -e "const m=require('fs').readFileSync('apps/web/scripts/verify-calendar-scopes.ts','utf8'); for (const f of ['CALENDAR_SCOPES','calendarConnection.findFirst','calendarList.list','CALENDAR_SCOPE_VERDICT','prisma.\$disconnect']) { if(!m.includes(f)){console.error('MISSING:',f);process.exit(1);} } console.log('OK');"</automated>
  </verify>
  <acceptance_criteria>
    - File `apps/web/scripts/verify-calendar-scopes.ts` exists
    - `grep -q "CALENDAR_SCOPES" apps/web/scripts/verify-calendar-scopes.ts`
    - `grep -q "calendarConnection.findFirst" apps/web/scripts/verify-calendar-scopes.ts`
    - `grep -q "calendarList.list" apps/web/scripts/verify-calendar-scopes.ts`
    - `grep -q "CALENDAR_SCOPE_VERDICT" apps/web/scripts/verify-calendar-scopes.ts`
    - `grep -q "prisma.\$disconnect" apps/web/scripts/verify-calendar-scopes.ts`
    - File contains a top comment marking it as a one-shot read-only script
    - File does NOT contain any `prisma.calendarConnection.update`, `delete`, or `create` (read-only confirmed)
  </acceptance_criteria>
  <done>The script is committed and ready to run against the live production database (or the EC2 production instance via SSM tunnel).</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Run the verification script against the production CalendarConnection and record the verdict</name>
  <what-built>
    A read-only Postgres + Google scope-verification script (`apps/web/scripts/verify-calendar-scopes.ts`). It prints the live scope set granted to the production OAuth token and tells you whether Phase 8 (readonly) and Phase 9 (events) will work.
  </what-built>
  <how-to-verify>
    1. **Decide where to run.** Local against a forwarded prod DB is fastest if the SSH tunnel + DATABASE_URL are already wired; otherwise SSH into the EC2 host (per `~/.ssh/inbox_key`, host `inbox.tdfurn.com`, user `ubuntu`) and run inside the running container:
       ```bash
       ssh -i ~/.ssh/inbox_key ubuntu@inbox.tdfurn.com
       docker exec -it $(docker ps --filter name=inbox-zero-app -q) sh
       # inside the container:
       pnpm exec tsx apps/web/scripts/verify-calendar-scopes.ts
       ```

    2. **Capture the output verbatim.** The interesting lines:
       - `LIVE_TOKENINFO_SCOPES: <space-delimited string>`
       - `CALENDAR_SCOPE_VERDICT: <OK | PARTIAL | FAIL>`

    3. **Decide disposition:**
       - **OK** → approve, no action; Phase 9 readiness confirmed.
       - **PARTIAL** → Phase 8 ships fine, but Phase 9 will 403 on event creation. Approve Phase 8, but record a known-blocker for Phase 9 to handle (re-consent via OAuth flow before Phase 9 testing).
       - **FAIL** → either no connection found or live read 401/403. Phase 8 itself is blocked. Re-consent via the OAuth flow at https://inbox.tdfurn.com/settings (or wherever the calendar connect button lives) and re-run the script.

    4. **Type one of:**
       - `approved-OK` (verdict was OK)
       - `approved-PARTIAL-phase9-followup` (Phase 8 ok, Phase 9 will need re-consent)
       - `blocked-FAIL <paste-output>` (Phase 8 blocked, action needed)

    The script is read-only — running it cannot break production.
  </how-to-verify>
  <resume-signal>Type `approved-OK`, `approved-PARTIAL-phase9-followup`, or `blocked-FAIL` followed by the script output</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Operator → production Postgres | Read-only query; no writes. |
| Operator → Google tokeninfo / calendarList endpoints | Read-only API calls; no modification. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-08-09 | Information disclosure | Script prints access token to stdout if author isn't careful | mitigate | Acceptance criteria forbids any token/secret in script output — script prints `scope` strings only, not the raw `accessToken` value. Operator runs in a private terminal session. |
| T-08-10 | Tampering | Operator accidentally edits production state | mitigate | Acceptance criteria checks that script contains no `update/delete/create` calls; explicit top-of-file comment marks it read-only. |
</threat_model>

<verification>
- Script committed: `grep -q "CALENDAR_SCOPE_VERDICT" apps/web/scripts/verify-calendar-scopes.ts`
- Read-only enforced: no `prisma.*.update`, `prisma.*.delete`, `prisma.*.create` in the script
- Human checkpoint completed with explicit verdict and disposition recorded in the SUMMARY
</verification>

<success_criteria>
- We KNOW (not assume) that the production OAuth grant covers `calendar.readonly` — Phase 8 read path will work in prod
- We KNOW whether Phase 9 will need a re-consent before it ships
- The script remains in-repo as a future operator tool (re-runnable if OAuth state ever drifts)
</success_criteria>

<output>
After completion, create `.planning/phases/08-calendar-sync-foundation/08-03-SUMMARY.md` listing:
- Files created
- The verbatim `LIVE_TOKENINFO_SCOPES` line from the run
- The `CALENDAR_SCOPE_VERDICT` outcome
- Disposition: approve, approve-with-Phase-9-followup, or blocked-redo
- If PARTIAL or FAIL, the exact follow-up action recorded as a Pending Todo in STATE.md
</output>
