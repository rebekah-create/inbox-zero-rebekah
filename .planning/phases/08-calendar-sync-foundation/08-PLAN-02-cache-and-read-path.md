---
phase: 08-calendar-sync-foundation
plan: 02
type: execute
wave: 2
depends_on: [08-01]
files_modified:
  - apps/web/utils/calendar/upcoming-events.ts
  - apps/web/utils/calendar/upcoming-events.test.ts
autonomous: true
requirements:
  - CAL-01
  - CAL-02
  - CAL-03
tags:
  - calendar
  - redis
  - cache

must_haves:
  truths:
    - "A single exported async function getUpcomingEvents({ emailAccountId, now, logger }) returns NormalizedCalendarEvent[] for the next 7 days"
    - "Fresh cache hit (within 15 minutes of fetchedAt) returns cached data without calling Google"
    - "Cache miss or soft-expired cache triggers a Google events.list call against calendarId='primary' with singleEvents=true, orderBy='startTime', timeMin=now, timeMax=now+7d, maxResults=250"
    - "Declined and tentative events (per self-attendee responseStatus) are filtered BEFORE caching, so they never enter the envelope"
    - "All-day events surface with isAllDay=true and YYYY-MM-DD strings for start/end (no UTC midnight shift)"
    - "On Google API failure with a stale envelope present (older than 15 min, younger than 24h hard TTL), the stale data is returned and logger.warn is called with stable structured fields (no full event bodies logged)"
    - "On Google API failure with no envelope present, an empty array is returned and a warn is logged"
    - "Cache key is exactly calendar:events:{emailAccountId}"
    - "Past events (end < now) are pruned before returning, both on fresh fetch and on stale-fallback paths"
    - "The function calls client.events.list directly (NOT GoogleCalendarEventProvider.fetchEvents) so responseStatus and the all-day flag survive"
  artifacts:
    - path: "apps/web/utils/calendar/upcoming-events.ts"
      provides: "getUpcomingEvents — the single read path for Phase 9/10"
      exports: ["getUpcomingEvents", "UPCOMING_EVENTS_CACHE_PREFIX"]
    - path: "apps/web/utils/calendar/upcoming-events.test.ts"
      provides: "Integration tests with mocked Redis + mocked calendar client covering all 14 cases from 08-RESEARCH.md test map"
      contains: "describe"
  key_links:
    - from: "apps/web/utils/calendar/upcoming-events.ts"
      to: "apps/web/utils/calendar/upcoming-events-helpers.ts"
      via: "import { isExcluded, normalize, pastPrune }"
      pattern: "from \"./upcoming-events-helpers\""
    - from: "apps/web/utils/calendar/upcoming-events.ts"
      to: "apps/web/utils/redis/index.ts"
      via: "import { redis }"
      pattern: "@/utils/redis"
    - from: "apps/web/utils/calendar/upcoming-events.ts"
      to: "apps/web/utils/calendar/client.ts"
      via: "getCalendarClientWithRefresh"
      pattern: "getCalendarClientWithRefresh"
    - from: "apps/web/utils/calendar/upcoming-events.ts"
      to: "Postgres CalendarConnection"
      via: "prisma.calendarConnection.findFirst"
      pattern: "calendarConnection.findFirst"
---

<objective>
Build the single cache-aware read path `getUpcomingEvents` that downstream Phase 9 (reconciliation) and Phase 10 (digest agenda) consume. The function composes the Task 1-3 helpers (Plan 01) with a Redis envelope cache (soft 15-min expiry, hard 24h TTL) and a direct `client.events.list` call. Honors all of D-01 through D-12.

Purpose: Deliver the entire Phase 8 success-criteria surface (CAL-01, CAL-02, CAL-03) in a single composable module that downstream phases import without seeing any Google or Redis types.

Output: One source module + one integration test file covering all 14 behaviors enumerated in 08-RESEARCH.md "Phase Requirements → Test Map".
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md
@.planning/phases/08-calendar-sync-foundation/08-RESEARCH.md
@.planning/phases/08-calendar-sync-foundation/08-01-SUMMARY.md
@CLAUDE.md

@apps/web/utils/calendar/upcoming-events-types.ts
@apps/web/utils/calendar/upcoming-events-helpers.ts
@apps/web/utils/redis/account-validation.ts
@apps/web/utils/calendar/client.ts

<interfaces>
<!-- Existing exports the executor will consume — extracted to prevent codebase scavenger hunts. -->

From `apps/web/utils/redis/index.ts`:
```ts
// Singleton Upstash client
export const redis: Redis;
// Methods used here: redis.get<T>(key), redis.set(key, value, { ex: seconds })
// Upstash SDK auto-JSON-serializes objects on set and JSON-parses on get when generic <T> is supplied.
```

From `apps/web/utils/calendar/client.ts`:
```ts
export const getCalendarClientWithRefresh: (args: {
  accessToken?: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  emailAccountId: string;
  connectionId?: string | null;
  logger: Logger;
}) => Promise<calendar_v3.Calendar>;
// Already handles 401 + invalid_grant + token persistence via saveCalendarTokens.
```

From `apps/web/utils/prisma.ts` (default export) — query shape per 08-RESEARCH.md line 328-337:
```ts
prisma.calendarConnection.findFirst({
  where: { emailAccountId, provider: "google", isConnected: true },
  select: { id: true, accessToken: true, refreshToken: true, expiresAt: true },
});
```

From `apps/web/utils/logger.ts`:
```ts
export function createScopedLogger(scope: string): Logger;
// Logger methods: logger.warn(msg, fields?), logger.error, logger.info
```

From Plan 01 (`./upcoming-events-types`, `./upcoming-events-helpers`):
```ts
export interface NormalizedCalendarEvent { /* D-02 */ }
export interface CalendarCacheEnvelope { data: NormalizedCalendarEvent[]; fetchedAt: number }
export function isExcluded(event: calendar_v3.Schema$Event): boolean;
export function normalize(event: calendar_v3.Schema$Event): NormalizedCalendarEvent;
export function pastPrune(events: NormalizedCalendarEvent[], now: Date): NormalizedCalendarEvent[];
```

The verbatim events.list call pattern (mirror from `google-events.ts:82-90`):
```ts
const response = await client.events.list({
  calendarId: "primary",
  timeMin: now.toISOString(),
  timeMax: addDays(now, 7).toISOString(),
  maxResults: 250,
  singleEvents: true,
  orderBy: "startTime",
});
const items = response.data.items ?? [];
```

The read-through cache structure to mirror (`account-validation.ts:36-60`) — but ADDS envelope + soft expiry:
```ts
const KEY_PREFIX = "calendar:events:";
const FRESH_MS = 15 * 60 * 1000;        // D-05 soft expiry
const HARD_TTL_S = 24 * 60 * 60;        // 24h hard TTL — see 08-RESEARCH.md Q3

// Read envelope
let envelope: CalendarCacheEnvelope | null = null;
try { envelope = await redis.get<CalendarCacheEnvelope>(KEY_PREFIX + emailAccountId); } catch { /* Redis down — fall through */ }

const isFresh = envelope && (now.getTime() - envelope.fetchedAt) < FRESH_MS;
if (isFresh) return pastPrune(envelope.data, now);

// Try live fetch; on failure use stale envelope (if any) or [].
try {
  const fresh = await fetchAndNormalize(...);
  try { await redis.set(KEY_PREFIX + emailAccountId, { data: fresh, fetchedAt: now.getTime() }, { ex: HARD_TTL_S }); } catch { /* Redis down — skip caching */ }
  return pastPrune(fresh, now);
} catch (err) {
  logger.warn("Calendar API fetch failed; falling back", { emailAccountId, hasStale: !!envelope, err: errMsg(err) });
  if (envelope) return pastPrune(envelope.data, now);
  return [];
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Write failing integration tests for getUpcomingEvents with mocked redis + calendar client</name>
  <files>apps/web/utils/calendar/upcoming-events.test.ts</files>
  <read_first>
    - .planning/phases/08-calendar-sync-foundation/08-RESEARCH.md (lines 460-499 — full "Failure Modes" + "Test Map" tables; lines 169-187 — envelope reference implementation)
    - apps/web/utils/redis/account-validation.ts (read-through pattern to mirror)
    - apps/web/utils/calendar/upcoming-events-types.ts (Plan 01)
    - apps/web/utils/calendar/upcoming-events-helpers.ts (Plan 01 — but tests should treat helpers as already-trusted; this file tests the orchestration layer)
    - Run `grep -rn "vi.mock" apps/web/utils/calendar/` (or any existing test) to find the project's preferred mocking style for `@/utils/redis` and `@/utils/calendar/client` and `@/utils/prisma`. Mirror that style.
  </read_first>
  <behavior>
    Vitest suite with `vi.mock` for `@/utils/redis`, `@/utils/prisma`, and `@/utils/calendar/client`. Each test sets up the mock return values then calls `getUpcomingEvents({ emailAccountId: 'acct_test', now: fixedDate, logger: mockLogger })`.

    Required test cases (mirroring 08-RESEARCH.md test map):

    1. "normalized shape" — happy path: cache miss, prisma returns a connection, calendar client returns a mix of timed + all-day events; result matches D-02 shape (no Google fields leak)
    2. "events.list params" — assert `client.events.list` was called with `calendarId: "primary"`, `singleEvents: true`, `orderBy: "startTime"`, `timeMin` = now ISO, `timeMax` = now+7d ISO, `maxResults: 250`
    3. "excludes declined" — fixture with self-declined event → not in result
    4. "excludes tentative" — fixture with self-tentative event → not in result
    5. "keeps owner-created (empty attendees)" — fixture with `attendees: undefined` → kept
    6. "keeps accepted needsAction" — fixture mix → both kept
    7. "all-day surfaces with YYYY-MM-DD" — fixture with `start.date: '2026-05-25'` → result.start === '2026-05-25', isAllDay true
    8. "fresh cache hit skips Google" — redis.get returns envelope with fetchedAt = now - 10min → client.events.list called zero times
    9. "cache key is calendar:events:{id}" — assert `redis.get` called with `calendar:events:acct_test`
    10. "stale fallback on API failure" — envelope fetchedAt = now - 20min (older than FRESH_MS but within hard TTL), calendar client throws → result === envelope.data (past-pruned); logger.warn called once
    11. "empty on no cache + failure" — redis.get returns null, calendar client throws → result === [], logger.warn called
    12. "past-event pruning on fresh fetch" — calendar returns events including one with end < now → not in result
    13. "past-event pruning on stale fallback" — envelope contains past + future events; API fails → result excludes past
    14. "no calendar connection" — prisma returns null → result === [], logger.warn called with "No Google calendar connection" or similar; calendar client NOT called
    15. "Redis down on read" — redis.get throws → falls through to live fetch (does not crash); result still returns fetched events
    16. "Redis down on write" — redis.set throws → does not crash; result still returns fetched events
    17. "logger.warn never receives full event body" — when logging stale-fallback or failure, the logged fields contain only `emailAccountId`, optionally `hasStale` / `eventCount` / error message — assert that no field equals or contains a full event description or summary string (use `expect(loggedFields).not.toHaveProperty('description')` and an explicit string-content check that the serialized log args don't include the fixture's secret-marker title like "Doctor: HIV results 5/24" → which we'll plant in a fixture)
    18. "concurrent cold reads → at most 2 Google calls" — Promise.all of two `getUpcomingEvents` invocations with same id, cold cache; assert `events.list` mock invocation count <= 2 (D-09 tolerance per 08-RESEARCH.md line 421)

    Tests should FAIL when run before Task 2 implements `getUpcomingEvents` (module does not exist).
  </behavior>
  <action>
    Create `apps/web/utils/calendar/upcoming-events.test.ts`. Use `vi.mock("@/utils/redis", () => ({ redis: { get: vi.fn(), set: vi.fn() } }))`, `vi.mock("@/utils/prisma", () => ({ default: { calendarConnection: { findFirst: vi.fn() } } }))`, `vi.mock("@/utils/calendar/client", () => ({ getCalendarClientWithRefresh: vi.fn() }))`.

    Build a helper `makeEvent({ id, isAllDay, selfResponse, end })` that returns a `calendar_v3.Schema$Event` fixture. Build a `mockLogger` exposing `warn`, `error`, `info` as `vi.fn()`.

    Use a fixed `now = new Date("2026-05-22T12:00:00-04:00")`. Compute `now + 7d` for assertions.

    For test 17, plant a fixture event with `summary: "SENSITIVE-LOG-MARKER"` and after invocation assert `JSON.stringify(mockLogger.warn.mock.calls)` does NOT include `"SENSITIVE-LOG-MARKER"`.

    For test 18, the calendar client mock should return a promise that resolves after a microtask, and both `getUpcomingEvents` calls go through `Promise.all`. Acceptable count <= 2 per D-09 tolerance.

    All tests use `import { describe, it, expect, vi, beforeEach } from "vitest"`. Reset mocks in `beforeEach`.
  </action>
  <verify>
    <automated>cd apps/web && pnpm test -- utils/calendar/upcoming-events.test.ts --run 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - File `apps/web/utils/calendar/upcoming-events.test.ts` exists
    - `grep -c "it(" apps/web/utils/calendar/upcoming-events.test.ts` returns at least 17
    - `grep -q "vi.mock(.@/utils/redis" apps/web/utils/calendar/upcoming-events.test.ts`
    - `grep -q "vi.mock(.@/utils/prisma" apps/web/utils/calendar/upcoming-events.test.ts`
    - `grep -q "vi.mock(.@/utils/calendar/client" apps/web/utils/calendar/upcoming-events.test.ts`
    - `grep -q "calendar:events:acct_test" apps/web/utils/calendar/upcoming-events.test.ts` (cache key assertion)
    - `grep -q "SENSITIVE-LOG-MARKER" apps/web/utils/calendar/upcoming-events.test.ts` (log-leak guard)
    - `grep -q "maxResults: 250" apps/web/utils/calendar/upcoming-events.test.ts` (D-recommended max)
    - `grep -q "fetchedAt" apps/web/utils/calendar/upcoming-events.test.ts` (envelope shape exercised)
    - Running suite before Task 2 fails with module-not-found OR all tests fail because `getUpcomingEvents` is not yet exported (RED — expected)
  </acceptance_criteria>
  <done>Failing integration suite exists with full coverage of CAL-01/02/03 + D-09 + log-leak + thundering-herd; ready for Task 2 to turn GREEN.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Implement getUpcomingEvents and turn the integration suite GREEN</name>
  <files>apps/web/utils/calendar/upcoming-events.ts</files>
  <read_first>
    - apps/web/utils/calendar/upcoming-events.test.ts (Task 1 — locks behavior)
    - apps/web/utils/redis/account-validation.ts lines 36-60 (read-through pattern)
    - apps/web/utils/calendar/client.ts lines 39-125 (getCalendarClientWithRefresh contract)
    - apps/web/utils/calendar/providers/google-events.ts lines 82-90 (events.list call shape — mirror, do NOT layer on top)
    - apps/web/utils/calendar/event-provider.ts lines 37-66 (CalendarConnection query shape)
    - apps/web/utils/calendar/upcoming-events-helpers.ts (Plan 01)
    - apps/web/utils/calendar/upcoming-events-types.ts (Plan 01)
    - apps/web/utils/redis/research-cache.ts (for isRedisConfigured() guard pattern + createScopedLogger usage, lines 14-129)
  </read_first>
  <behavior>
    Export `getUpcomingEvents({ emailAccountId, now, logger })` and the constant `UPCOMING_EVENTS_CACHE_PREFIX = "calendar:events:"`. Function signature:

    ```ts
    export async function getUpcomingEvents(args: {
      emailAccountId: string;
      now: Date;
      logger: Logger;
    }): Promise<NormalizedCalendarEvent[]>;
    ```

    Behavior (mirrors the pseudocode in <interfaces>):

    1. Build cache key = `UPCOMING_EVENTS_CACHE_PREFIX + emailAccountId` (per D-04).
    2. Try `redis.get<CalendarCacheEnvelope>(key)`; on throw, treat as null + continue (Redis-down tolerance per account-validation.ts pattern).
    3. If envelope present AND `(now.getTime() - envelope.fetchedAt) < 15*60*1000` → return `pastPrune(envelope.data, now)` immediately. No Google call. (D-05 fresh hit.)
    4. Look up CalendarConnection via prisma: `provider: "google"`, `isConnected: true`, `emailAccountId`. If none, `logger.warn("No Google calendar connection found", { emailAccountId })` and return `envelope ? pastPrune(envelope.data, now) : []`.
    5. Get the calendar client via `getCalendarClientWithRefresh` (passes through token + connection IDs to honor the existing refresh path).
    6. Call `client.events.list` directly with the exact params in <interfaces>. Pass `maxResults: 250`.
    7. Filter raw events through `isExcluded` (drop where true), map through `normalize`, store the result.
    8. Best-effort `redis.set(key, { data: normalized, fetchedAt: now.getTime() }, { ex: 24 * 60 * 60 })`. On throw, swallow (Redis-down tolerance).
    9. Return `pastPrune(normalized, now)`.
    10. On any error in steps 5-7 (Google API failure / token refresh failure):
        - `logger.warn("Calendar API fetch failed; falling back", { emailAccountId, hasStale: !!envelope, eventCountFresh: envelope?.data.length ?? 0, error: err instanceof Error ? err.message : String(err) })` — STRUCTURED FIELDS ONLY. Never include event titles, descriptions, attendees, or any normalized event data in the log fields.
        - If `envelope` exists: return `pastPrune(envelope.data, now)`. Else: return `[]`.

    Use `createScopedLogger("calendar/upcoming-events")` as a fallback default logger only if the test exposes it — but the function signature requires logger to be passed in (no implicit logger creation inside the function; that's the caller's responsibility per existing fork convention).

    No retries inside (D-10). No webhooks (D-12). No token logging (D-11).
  </action>
  <action>
    Create `apps/web/utils/calendar/upcoming-events.ts`. Import:

    ```ts
    import "server-only";
    import type { calendar_v3 } from "@googleapis/calendar";
    import { addDays } from "date-fns";
    import { redis } from "@/utils/redis";
    import prisma from "@/utils/prisma";
    import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
    import type { Logger } from "@/utils/logger";
    import type {
      CalendarCacheEnvelope,
      NormalizedCalendarEvent,
    } from "./upcoming-events-types";
    import { isExcluded, normalize, pastPrune } from "./upcoming-events-helpers";
    ```

    Implement per <behavior>. Constants:
    ```ts
    export const UPCOMING_EVENTS_CACHE_PREFIX = "calendar:events:";
    const FRESH_MS = 15 * 60 * 1000;
    const HARD_TTL_S = 24 * 60 * 60;
    const LOOKAHEAD_DAYS = 7;
    const MAX_RESULTS = 250;
    ```

    Wrap the live-fetch path in try/catch as in <interfaces>. The Redis get and Redis set are each wrapped in their own try/catch so a Redis outage during read does not block the live fetch, and a Redis outage during write does not lose the result.

    Iterate until `pnpm test -- utils/calendar/upcoming-events.test.ts --run` is fully green. Adjust implementation, not tests — except that if a test from Task 1 contradicts this plan's behavior section, fix the test.
  </action>
  <verify>
    <automated>cd apps/web && pnpm test -- utils/calendar/upcoming-events.test.ts --run 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - File `apps/web/utils/calendar/upcoming-events.ts` exists
    - `grep -q "export async function getUpcomingEvents" apps/web/utils/calendar/upcoming-events.ts`
    - `grep -q "UPCOMING_EVENTS_CACHE_PREFIX" apps/web/utils/calendar/upcoming-events.ts`
    - `grep -q "calendar:events:" apps/web/utils/calendar/upcoming-events.ts` (D-04 key prefix literal)
    - `grep -q "15 \* 60 \* 1000" apps/web/utils/calendar/upcoming-events.ts` OR `grep -q "FRESH_MS" apps/web/utils/calendar/upcoming-events.ts` (D-05 soft expiry)
    - `grep -q "24 \* 60 \* 60" apps/web/utils/calendar/upcoming-events.ts` OR `grep -q "HARD_TTL" apps/web/utils/calendar/upcoming-events.ts` (24h hard TTL for stale fallback)
    - `grep -q "client.events.list" apps/web/utils/calendar/upcoming-events.ts` (direct call, NOT GoogleCalendarEventProvider)
    - `grep -vE "^\s*(//|\*)" apps/web/utils/calendar/upcoming-events.ts | grep -c "GoogleCalendarEventProvider" | xargs -I{} test {} -eq 0` (does NOT use the lossy wrapper)
    - `grep -q "fetchedAt" apps/web/utils/calendar/upcoming-events.ts` (envelope shape used)
    - `grep -q "isExcluded" apps/web/utils/calendar/upcoming-events.ts` (Plan 01 helper composed)
    - `grep -q "normalize" apps/web/utils/calendar/upcoming-events.ts` (Plan 01 helper composed)
    - `grep -q "pastPrune" apps/web/utils/calendar/upcoming-events.ts` (Plan 01 helper composed)
    - `grep -q "maxResults: 250" apps/web/utils/calendar/upcoming-events.ts`
    - `grep -q "singleEvents: true" apps/web/utils/calendar/upcoming-events.ts`
    - `grep -q "orderBy: \"startTime\"" apps/web/utils/calendar/upcoming-events.ts`
    - `grep -q "calendarId: \"primary\"" apps/web/utils/calendar/upcoming-events.ts`
    - `cd apps/web && pnpm test -- utils/calendar/upcoming-events.test.ts --run` exits 0
    - All 17+ integration tests pass
  </acceptance_criteria>
  <done>The single Phase 8 read path is committed and fully tested; Phase 9/10 can import `getUpcomingEvents` and trust the contract.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| App → Google Calendar API | OAuth-authenticated request; tokens flow through `getCalendarClientWithRefresh`. Already mitigated upstream. |
| App → Upstash Redis | HTTP-authenticated singleton; key namespace owned by this app. |
| App → Postgres CalendarConnection | Internal trust boundary; row read-only here. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-08-03 | Information disclosure | logger.warn during stale-fallback or API failure | mitigate | Test 17 in Task 1 asserts no event title/description/attendee email appears in logger.warn arguments — `SENSITIVE-LOG-MARKER` fixture proves negative. Logged fields are restricted to `emailAccountId`, `hasStale`, `eventCountFresh`, `error.message`. |
| T-08-04 | Tampering | Cache key collision across email accounts | mitigate | Key includes `emailAccountId` (D-04); test 9 asserts exact key string. Single-tenant fork so cross-tenant exposure is not a vector, but key scoping is still encoded. |
| T-08-05 | Denial of service | Thundering herd on cold cache | accept | D-09 tolerance is "at most 2 calls, not N". Single-user volume (≤3.5 emails/hr peak per CONTEXT) makes simultaneous misses negligible. Test 18 caps at <= 2 invocations under Promise.all. |
| T-08-06 | Spoofing | OAuth token theft | mitigate (upstream) | Token refresh + persistence handled by `getCalendarClientWithRefresh` (already in fork). This module does not log tokens. No `console.log(args)` of the connection object. |
| T-08-07 | Repudiation | Stale-vs-fresh confusion in incident review | mitigate | The stale-fallback warn message string differs from any fresh-fetch log; on-call grepping `"falling back"` finds only stale paths. |
| T-08-08 | Elevation of privilege | Cross-tenant data leak via cache | n/a | Single-tenant deployment; only one email account exists. Key scoping still defensive. |
</threat_model>

<verification>
- Integration suite passes: `cd apps/web && pnpm test -- utils/calendar/upcoming-events.test.ts --run` exits 0
- Direct events.list call enforced: `grep` shows `client.events.list` and NOT `GoogleCalendarEventProvider` in non-comment code
- Envelope soft/hard TTL implemented: `grep` shows both `FRESH_MS` (or `15 * 60 * 1000`) and `HARD_TTL` (or `24 * 60 * 60`)
- Single export contract: `grep -c "^export" apps/web/utils/calendar/upcoming-events.ts` shows 2 (the function + the cache prefix constant)
- Log-leak guard active: SENSITIVE-LOG-MARKER test case passes
- Thundering-herd tolerance: Promise.all test passes with <= 2 calendar client invocations
</verification>

<success_criteria>
- CAL-01 satisfied: single cache-aware function returns normalized D-02 events for next 7 days
- CAL-02 satisfied: declined/tentative filtered at fetch time, never enter the cache envelope
- CAL-03 satisfied: per-account cache key with 15-min soft expiry (Google call rate <= 4/hr/account, well within free quota)
- D-09 satisfied: stale envelope returned on API failure when fetchedAt within hard TTL; empty list when no envelope
- D-09 corollary satisfied: 24h hard TTL implemented so stale data is actually retrievable from Redis after soft expiry
- D-12 satisfied: no flush command, no webhook handler, TTL is the only invalidation
- Log-leak threat (T-08-03) mitigated by test 17
</success_criteria>

<output>
After completion, create `.planning/phases/08-calendar-sync-foundation/08-02-SUMMARY.md` listing:
- Files created
- Test counts (helpers vs integration)
- Final values chosen for FRESH_MS, HARD_TTL_S, LOOKAHEAD_DAYS, MAX_RESULTS
- Any test cases that revealed a missing behavior in <behavior> (and the fix applied)
- Confirmation that no `console.log` or `logger.warn` call in the module contains an event title/description/attendee
</output>
