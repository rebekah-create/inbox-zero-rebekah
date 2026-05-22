---
phase: 08
status: verified
goal_met: true
requirements_satisfied: [CAL-01, CAL-02, CAL-03]
requirements_missing: []
non_goals_honored: true
review_status: clean (per 08-REVIEW.md — 0 CRITICAL, 0 HIGH, 4 MEDIUM advisory, 5 LOW)
verified: 2026-05-22
---

# Phase 8: Calendar Sync Foundation — Verification

**Phase Goal:** Fetch + Redis-cache the user's primary-calendar events (next 7 days, declined/tentative excluded) and expose a single read path that downstream phases consume. No prompt injection, no urgency bias — pure plumbing.

**Verified:** 2026-05-22
**Status:** verified
**Re-verification:** No — initial verification

---

## Goal Achievement

Each ROADMAP success criterion mapped to concrete code evidence.

| # | ROADMAP Success Criterion | Status | Evidence |
|---|---|---|---|
| 1 | A single cache-aware read function returns normalized events for the next 7 days | VERIFIED | `getUpcomingEvents({ emailAccountId, now, logger })` exported from `apps/web/utils/calendar/upcoming-events.ts:41-49`. Returns `NormalizedCalendarEvent[]` (D-02 contract). `LOOKAHEAD_DAYS = 7` (line 38) drives `timeMax: addDays(now, 7)` on the events.list call (line 96). Read path composes Redis read (lines 53-57) → fresh-hit shortcut (lines 59-61) → live fetch (lines 63-117) → stale-fallback (lines 118-128). The function is the only exported entry point — downstream Phase 9/10 callers cannot bypass it without explicitly importing the Google provider, which the file's JSDoc explicitly forbids. |
| 2 | Declined and tentative events are excluded at fetch time and never enter the cache | VERIFIED | `isExcluded(event)` in `upcoming-events-helpers.ts:11-18` returns true when self attendee's `responseStatus === 'declined' \|\| 'tentative'`. Filter applied BEFORE normalize and BEFORE the Redis write: `items.filter(event => !isExcluded(event)).map(event => normalize(event))` at `upcoming-events.ts:103-105`, then `redis.set(key, { data: normalized, ... })` at line 108. Declined/tentative events therefore never appear in the cached envelope. Locked by helper test 1-8 (8 cases in `upcoming-events-helpers.test.ts`) and integration tests 3, 4, 5, 6 in `upcoming-events.test.ts`. |
| 3 | Cache is keyed per email-account, TTL bounded so Calendar API calls are well within Google's free quota | VERIFIED | Key shape `calendar:events:{emailAccountId}` constructed at `upcoming-events.ts:50` from `UPCOMING_EVENTS_CACHE_PREFIX` constant. `FRESH_MS = 15 * 60 * 1000` (line 36) bounds Google calls to ≤4/hr/account — Google free quota is 1M req/day, this is ~96/day. `HARD_TTL_S = 24 * 60 * 60` (line 37) keeps the envelope retrievable for stale-fallback. Integration test 9 asserts exact key literal `calendar:events:acct_test`; test 8 asserts fresh-cache shortcut skips Google entirely. |
| 4 | On Calendar API failure with stale cache → return stale + log warn; with no cache → empty list, downstream degrades gracefully | VERIFIED | The outer try/catch at `upcoming-events.ts:118-128` implements D-09: `if (envelope) return pastPrune(envelope.data, now); return [];` with a single `logger.warn("Calendar API fetch failed; falling back", { emailAccountId, hasStale, eventCountStale, error })`. Locked by integration tests 10 (stale envelope returned + warn), 11 (empty envelope + API fail → `[]`), 14 (no connection → empty + warn, calendar client NOT called). Stale fallback also passes through `pastPrune` (line 126), so past events never resurface from a 23-hour-old envelope. |

**Score: 4 / 4 success criteria verified.**

---

## Requirements

| REQ | Description | Status | Evidence |
|---|---|---|---|
| CAL-01 | Fetch upcoming events (next 7 days, primary calendar) through a single cached read path | SATISFIED | `getUpcomingEvents` is the sole exported read path. `calendarId: "primary"` hardcoded at `upcoming-events.ts:94` (D-03). 7-day window via `LOOKAHEAD_DAYS = 7` (line 38) → `timeMax: addDays(now, 7)` (line 96). Cache layer in place per criterion 1/3 above. |
| CAL-02 | Declined or tentative events are excluded from the cached event list and never reach extraction, reconciliation, or digest rendering | SATISFIED | See criterion 2 above. The filter sits BEFORE the cache write, so the envelope itself is free of declined/tentative events — there is no code path by which an excluded event can reach a Phase 9 or Phase 10 consumer, because consumers read from `getUpcomingEvents` whose only data sources are (a) the pre-filtered cache envelope or (b) the live fetch which itself filters before returning. |
| CAL-03 | Event cache keyed per email-account, refreshed at most once per N minutes | SATISFIED | Key `calendar:events:{emailAccountId}` (line 50). Soft expiry `FRESH_MS = 15 min` (line 36) — within FRESH_MS, the function returns cached data without touching Google (`upcoming-events.ts:59-61`). At steady state on the personal-volume single-user fork (~3.5 emails/hr peak) this caps Google calls at ≤4/hr/account. |

---

## Non-Goals

Phase 8 is explicitly scoped as "pure plumbing — no prompt injection, no urgency bias." Each non-goal confirmed honored:

| Non-Goal | Honored? | Evidence |
|---|---|---|
| No prompt injection into the classification prompt | YES | `upcoming-events.ts` has zero imports from `utils/ai/**`. Imports are limited to `date-fns`, `@/utils/redis`, `@/utils/prisma`, `@/utils/calendar/client`, `@/utils/logger`, and the local helpers/types. No reference to `chooseRule`, `getCategories`, classification prompt builders, or any v1.0 classifier surface. |
| No urgency bias from calendar proximity | YES | Confirmed in two layers: (a) no code in `upcoming-events.ts` reads or writes anything classifier-adjacent; (b) grep of the file shows no references to `urgency`, `urgent`, `priority`, `bias`, or `score`. The function returns a raw event list; it does not annotate or rank emails. |
| No AI/LLM calls | YES | No imports from `@anthropic-ai/sdk`, no `aiCompletion`/`aiCall` invocations, no model identifiers. The file pulls events from Google and stores them in Redis — pure I/O. |
| No event creation (write path) | YES | `client.events.list` is the only Calendar API call (`upcoming-events.ts:93`). No `client.events.insert`, `.update`, `.patch`, or `.delete`. The OAuth scope verification script (`verify-calendar-scopes.mjs`) also reads only — script header explicitly says "Read-only: makes no DB writes." |
| No changes to existing classification flow | YES | `key-files.modified: []` in both 08-01-SUMMARY and 08-02-SUMMARY (and only the script removal in 08-03). No existing file in `utils/ai/`, `utils/rule/`, `app/api/google/webhook`, or the worker pipeline was touched. The three files created are net-new and not imported by any v1.0 surface. |
| No multi-calendar, no Outlook | YES | `calendarId: "primary"` hardcoded (D-03 lock). No Microsoft Graph imports. |
| No token logging hooks (D-11) | YES | The `logger.warn` payload at `upcoming-events.ts:120-125` includes only `emailAccountId`, `hasStale`, `eventCountStale`, `error.message`. Integration test 17 plants a `SENSITIVE-LOG-MARKER` in the envelope title/description/attendees and asserts it never appears in `logger.warn` call args. Threat T-08-03 mitigated. |

**Non-goals fully honored.**

---

## Live Verification (per 08-03-SUMMARY)

The OAuth scope verification script (`apps/web/scripts/verify-calendar-scopes.mjs`) was executed against production on 2026-05-22 inside the `inbox-zero-app` container. Live result captured in 08-03-SUMMARY.md:

- `LIVE_TOKENINFO_SCOPES` includes both `calendar.readonly` (Phase 8) and `calendar.events` (Phase 9 readiness)
- `CALENDAR_SCOPE_VERDICT: OK`
- Disposition: `approved-OK` — no re-consent required, no Phase 9 follow-up needed

This confirms the read path will actually succeed against the live OAuth grant (not just the integration tests' mocked client). Credited.

---

## Code Review Cross-Reference

Per `08-REVIEW.md` (depth: standard, 6 files, 0 CRITICAL / 0 HIGH / 4 MEDIUM / 5 LOW / 5 INFO):

The MEDIUM findings (WR-01 normalize null-as-string, WR-02 all-day UTC date, WR-03 expiresAt cast, WR-04 no in-flight dedupe, WR-05 inline crypto divergence) are **advisory**, not goal misses. The reviewer explicitly concludes "ship as-is for Phase 8" and recommends WR-01/WR-03/WR-04/IN-01 for follow-up before Phase 9 consumers go live — not as Phase 8 blockers. The phase boundary (D-01..D-12) is honored.

These advisory items are NOT re-litigated here; per the verifier objective, code review is already done.

---

## Gaps

None. All four ROADMAP success criteria are satisfied by concrete code, all three CAL requirements map to verified evidence, and every non-goal is honored.

The advisory MEDIUMs from 08-REVIEW.md are hygiene items for Phase 9 readiness, not Phase 8 goal misses, and do not change this verdict.

---

## Verdict

Phase 8 delivers exactly what the ROADMAP promised: a single cache-aware read path (`getUpcomingEvents`) that returns normalized 7-day primary-calendar events, with declined/tentative events filtered before they reach the Redis envelope, per-account cache keys with a 15-minute soft expiry that bounds Google API calls well inside free quota, and a stale-fallback failure mode that lets downstream Phase 9/10 consumers degrade gracefully. Non-goals (no prompt injection, no urgency bias, no AI calls, no event writes, no classifier changes) are honored by construction — the file has no imports from any AI/classifier surface and no writes to anything classifier-adjacent. Production OAuth scope verification ran 2026-05-22 and returned `OK`. Pure plumbing, on contract. Ready for Phase 9 to consume.

---

_Verified: 2026-05-22_
_Verifier: Claude (gsd-verifier)_
