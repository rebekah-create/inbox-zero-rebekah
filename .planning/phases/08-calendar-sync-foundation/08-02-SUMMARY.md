---
phase: 08-calendar-sync-foundation
plan: 02
subsystem: calendar
tags: [calendar, redis, cache, tdd, integration]
dependency_graph:
  requires:
    - "Plan 01 helpers: isExcluded, normalize, pastPrune"
    - "Plan 01 types: NormalizedCalendarEvent, CalendarCacheEnvelope"
    - "@/utils/redis singleton (Upstash)"
    - "@/utils/calendar/client getCalendarClientWithRefresh"
    - "@/utils/prisma calendarConnection.findFirst"
  provides:
    - "getUpcomingEvents — the single cache-aware read path for Phase 9 (reconciliation) and Phase 10 (digest agenda)"
    - "UPCOMING_EVENTS_CACHE_PREFIX constant for cache-key introspection / future invalidation utilities"
  affects:
    - "Phase 9: reconciliation imports getUpcomingEvents to materialize today's calendar without seeing Google or Redis types"
    - "Phase 10: digest agenda imports the same function — single read path keeps Google call rate <= 4/hr/account"
tech-stack:
  added: []
  patterns:
    - "Redis envelope cache with soft (15-min) vs hard (24h) TTL — fetchedAt timestamp drives soft-freshness, hard TTL keeps stale data retrievable for D-09 fallback"
    - "Read-through cache with best-effort writes — Redis outage on read OR write does not crash the live path"
    - "Direct client.events.list call (NOT wrapped through GoogleCalendarEventProvider) so responseStatus and all-day flag survive normalization"
    - "Structured-fields-only logging on error paths — no event titles, descriptions, attendees, or tokens in warn payloads (T-08-03)"
key-files:
  created:
    - apps/web/utils/calendar/upcoming-events.ts
    - apps/web/utils/calendar/upcoming-events.test.ts
  modified: []
decisions:
  - "FRESH_MS = 15 * 60 * 1000 (D-05 soft expiry locked)"
  - "HARD_TTL_S = 24 * 60 * 60 (24h hard TTL — wider than soft expiry so stale fallback can serve)"
  - "LOOKAHEAD_DAYS = 7 (CAL-01 contract)"
  - "MAX_RESULTS = 250 (08-RESEARCH.md Q3 — covers heaviest weekly load on the single-user fork with margin)"
  - "Cache key shape calendar:events:{emailAccountId} — exact literal asserted by test 9"
  - "Stale fallback returns pastPrune(envelope.data, now), not raw envelope.data — past events never appear on the fallback path"
  - "logger.warn includes emailAccountId, hasStale, eventCountStale, error.message ONLY — no event-shape fields"
metrics:
  duration: "~30 min"
  completed: "2026-05-22"
  task_count: 2
  file_count: 2
  test_count: 18
requirements: [CAL-01, CAL-02, CAL-03]
---

# Phase 8 Plan 02: getUpcomingEvents Cache-Aware Read Path Summary

Delivered the single Phase 8 read path that Phase 9 (reconciliation) and Phase 10 (digest agenda) will consume. `getUpcomingEvents` composes the Plan 01 pure helpers (`isExcluded`, `normalize`, `pastPrune`) with a Redis envelope cache (soft 15-min, hard 24h TTL) and a direct `client.events.list` call. 18 integration tests lock CAL-01/02/03 behaviour plus the D-09 thundering-herd tolerance, log-leak guard, and Redis-down resilience.

## What Was Built

| File | Purpose |
| --- | --- |
| `apps/web/utils/calendar/upcoming-events.ts` | Exports `getUpcomingEvents({ emailAccountId, now, logger })` and `UPCOMING_EVENTS_CACHE_PREFIX`. 129 lines including jsdoc. |
| `apps/web/utils/calendar/upcoming-events.test.ts` | 18 vitest cases mocking `@/utils/redis`, `@/utils/prisma`, and `@/utils/calendar/client`. |

## Commits

| Commit | Type | Description |
| --- | --- | --- |
| `10b5ab98e` | test | Add failing integration tests for getUpcomingEvents (RED) |
| `c233aca40` | feat | Implement getUpcomingEvents cache-aware read path (GREEN) |

## Test Coverage (18 cases)

1. Normalized D-02 shape on cache miss — no Google fields leak
2. `client.events.list` called with exact params (`calendarId: "primary"`, `singleEvents: true`, `orderBy: "startTime"`, `timeMin`, `timeMax`, `maxResults: 250`)
3. Declined events excluded
4. Tentative events excluded
5. Owner-created (no attendees) kept
6. Accepted + needsAction both kept
7. All-day events surface with `YYYY-MM-DD` strings and `isAllDay: true`
8. Fresh cache hit (< 15 min) skips Google call entirely
9. Cache key is exactly `calendar:events:acct_test`
10. Stale envelope returned on API failure + single `logger.warn`
11. Empty list returned when no envelope AND API fails
12. Past events pruned on fresh fetch
13. Past events pruned on stale fallback
14. No calendar connection → empty list, `logger.warn`, calendar client NOT called
15. Redis read outage falls through to live fetch
16. Redis write outage does not crash; result still returned
17. **Log-leak guard** — `SENSITIVE-LOG-MARKER` planted in stale envelope is NEVER present in `logger.warn` arguments (T-08-03 mitigation)
18. **Thundering herd** — two concurrent cold reads result in ≤ 2 `client.events.list` invocations (D-09 tolerance)

## Test Run

```
Test Files  1 passed (1)
     Tests  18 passed (18)
  Duration  2.70s
```

## Final Configuration Values

| Constant | Value | Rationale |
| --- | --- | --- |
| `FRESH_MS` | `15 * 60 * 1000` | D-05 — Google call rate ≤ 4/hr/account on steady state |
| `HARD_TTL_S` | `24 * 60 * 60` | 24h stale-fallback window per 08-RESEARCH.md Q3 |
| `LOOKAHEAD_DAYS` | `7` | CAL-01 contract |
| `MAX_RESULTS` | `250` | Single-user volume buffer; 08-RESEARCH.md Q3 |
| `UPCOMING_EVENTS_CACHE_PREFIX` | `"calendar:events:"` | D-04 |

## Deviations from Plan

None. Behaviour matches the plan's `<behavior>` section exactly. No tests had to be rewritten during the GREEN phase — the contract surfaced in Task 1 held on first implementation pass.

The plan's success-criteria grep for "no GoogleCalendarEventProvider in non-comment code" passes: the only occurrence in `upcoming-events.ts` is a JSDoc warning instructing future readers NOT to wrap through it — exactly the negative reference the plan requested.

## Threat Model Compliance

| Threat | Status | Evidence |
| --- | --- | --- |
| T-08-03 (info disclosure via logs) | mitigated | Test 17 — `SENSITIVE-LOG-MARKER` planted in envelope title + description + attendees, asserted absent from serialized `logger.warn` calls. `logger.warn` payload restricted to `emailAccountId`, `hasStale`, `eventCountStale`, `error.message`. |
| T-08-04 (cross-tenant cache collision) | mitigated | Test 9 asserts exact key string `calendar:events:acct_test`. Key always namespaces by `emailAccountId`. |
| T-08-05 (thundering herd) | accepted with bound | Test 18 caps concurrent cold reads at ≤ 2 Google calls. Single-user volume makes this a non-issue in practice. |
| T-08-06 (token theft via logs) | mitigated upstream | This module never logs the connection object; only `emailAccountId` and `error.message` appear in logs. |
| T-08-07 (stale-vs-fresh log ambiguity) | mitigated | Stale-fallback string is `"Calendar API fetch failed; falling back"` — distinct from any fresh-fetch log. |

## Confirmation

- No `console.log` calls in `upcoming-events.ts` (grep clean).
- No `logger.warn` invocation includes an event title, description, or attendee field.
- No token, access token, or refresh token value appears in any log argument.

## Self-Check: PASSED

- File `apps/web/utils/calendar/upcoming-events.ts` FOUND
- File `apps/web/utils/calendar/upcoming-events.test.ts` FOUND
- Commit `10b5ab98e` FOUND
- Commit `c233aca40` FOUND
- All 18 vitest cases pass (verified locally, 2.70s)
- All acceptance-criteria grep checks pass (manual sweep)
