# Phase 8: Calendar Sync Foundation — Context

**Gathered:** 2026-05-22 (reframed after step-back conversation; supersedes 08-CONTEXT.md.old which was scoped around classification urgency-bias)
**Status:** Ready for planning
**Requirements:** CAL-01, CAL-02, CAL-03

<domain>
## Phase Boundary

Build the single read path that returns the user's primary Google Calendar events for the next 7 days, Redis-cached per email-account, declined/tentative excluded at fetch time. This phase is pure plumbing — it produces a normalized event list that Phase 9 (reconciliation) and Phase 10 (digest agenda) consume. No prompt injection, no urgency bias, no calendar-aware classification.

**Not in scope for Phase 8:**
- AI extraction from email bodies, calendar reconciliation, event creation — all Phase 9
- Digest agenda rendering — Phase 10
- Any change to the v1.0 three-tier classifier or its prompt
- Bias toward Urgent/Uncertain based on event proximity — dropped from v1.1 entirely (didn't fit the personal-logistics use case)
- Multi-calendar / non-primary calendar / Outlook / Microsoft
- Calendar OAuth flow — already connected for `rebekah@trueocean.com`
- Reply-time availability hints — separate code path (`utils/ai/calendar/availability.ts`) used by the assistant
</domain>

<carry_forward>
## Carry-Forward Facts

- **Use case is personal logistics, not business meetings.** 1–3 events/day, senders are usually `noreply@orlandohealth.com` / REI / school portals — NOT human attendees. The earlier draft of this phase (sender→attendee match, urgency bias) was a business-email heuristic that didn't fit. See `.planning/REQUIREMENTS.md` use-case framing.
- **Three-tier AI is locked.** Phase 8 makes no LLM calls. AI cost in v1.1 lives in Phase 9 extraction.
- **Substantial calendar infrastructure already exists in the fork:**
  - `apps/web/utils/calendar/client.ts` — `getCalendarClientWithRefresh()` handles OAuth + token refresh.
  - `apps/web/utils/calendar/providers/google-events.ts` — `GoogleCalendarEventProvider` wraps `calendar.events.list`.
  - `apps/web/utils/ai/calendar/availability.ts` — separate reply-drafting code path; reference only.
- **Redis is already a hard dependency** (BullMQ via Upstash). Reuse existing client; no new infra.
- **OAuth scopes already include Calendar read** — no new consent screen needed.
</carry_forward>

<decisions>
## Implementation Decisions

### Read Path

- **D-01: Single exported function** `getUpcomingEvents({ emailAccountId, now })` (name finalized in plan-phase) returns a normalized event list for the next 7 days. This is the ONLY read path downstream consumers (Phase 9 reconciliation, Phase 10 digest) should use — no direct calls to `GoogleCalendarEventProvider` from feature code.
- **D-02: Normalized event shape** is the contract for Phase 9/10. Fields: `id`, `title`, `start` (ISO), `end` (ISO), `isAllDay`, `location` (nullable), `description` (nullable), `attendees` (string[] of email addresses), `htmlLink`. No Google-specific fields leak through. (Phase 9/10 transform to their own rendering shape from this.)
- **D-03: Primary calendar only.** Calendar ID = `primary` per Google Calendar API. Multi-calendar deferred.

### Cache

- **D-04: Redis cache, key `calendar:events:{emailAccountId}`.** Reuse the existing Upstash client. Cache value is the JSON-encoded normalized event list (D-02 shape). Survives app restarts; shared across web + worker processes.
- **D-05: TTL = 15 minutes.** At ~3.5 emails/hour peak that bounds Calendar API calls to ≤4/hr per account, well inside Google's free quota. 15-min freshness window is acceptable for personal email — a meeting added now influences digest/reconciliation within 15 min.
- **D-06: Window = next 7 days from `now` at fetch time.** Cache key does NOT vary by time of day. Past events are pruned by the read function before returning to callers (no Calendar API round-trip needed to drop them).

### Filtering at Fetch Time (CAL-02)

- **D-07: Exclude declined and tentative events** based on the calendar owner's `responseStatus` in the event's `attendees` array. Keep `accepted` and `needsAction`. Excluded events never enter the cache, so they never reach Phase 9 or Phase 10.
- **D-08: Include all-day events.** They're legitimate calendar entries (birthdays, camping trips). Marked via `isAllDay: true` in the normalized shape so Phase 10's digest renderer can show them differently from timed events.

### Failure Modes

- **D-09: Stale-cache fallback on Calendar API failure.** If the live fetch fails (auth, network, quota) and a stale cached blob exists, return the stale data with a `logger.warn` so downstream features still work. If no cache exists at all, return an empty event list (downstream features degrade gracefully — Phase 9 skips extraction-triggered reconciliation against calendar, Phase 10 digest renders empty agenda with a fallback message).
- **D-10: No retry inside the read function.** Calendar API has its own client-level retry behavior; layering more retry here would just stack latency. One failed fetch → fall back per D-09 → log → move on.

### Operational

- **D-11: Token logging hooks are NOT added in Phase 8.** This phase has zero LLM cost. Token instrumentation lands in Phase 9 (REC-02 extraction).
- **D-12: Cache invalidation is time-based only.** No event-change webhooks, no manual flush command in v1.1 — TTL is the entire invalidation strategy. (A manual flush command could be added in Phase 9 if reconciliation testing demands it — defer to plan-phase.)
</decisions>

<deferred>
## Deferred Ideas / Out-of-Scope Captures

- **Calendar push notifications / webhooks** for instant cache invalidation — TTL is sufficient for personal-volume use.
- **Multi-calendar / secondary calendar support** — primary only for v1.1.
- **Microsoft / Outlook calendar** — Google only.
- **Manual cache flush admin command** — only build if Phase 9 testing demands it.
- **Per-user TTL tuning** — 15-min static for now.
- **Calendar-aware classification urgency bias** (the original Phase 8 scope) — formally dropped from v1.1; the calendar→email surface is reconciliation (Phase 9) + digest (Phase 10), not classification bias.
</deferred>

<folded_todos>
## Folded Todos (none)

No pending todos matched Phase 8 scope.
</folded_todos>

<canonical_refs>
## Canonical References (MUST read before planning)

**Project / milestone artifacts:**
- `.planning/ROADMAP.md` — Phase 8 section ("Calendar Sync Foundation") with success criteria.
- `.planning/REQUIREMENTS.md` — CAL-01, CAL-02, CAL-03 (and the use-case framing block at the top, which reshapes priorities).
- `.planning/PROJECT.md` — three-tier AI cost ceiling, single-tenant constraints.
- `.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md.old` — superseded earlier scope (classification urgency bias). Kept for reference only; do not implement against it.

**Codebase entry points:**
- `apps/web/utils/calendar/client.ts` — `getCalendarClientWithRefresh` (OAuth + token refresh; reuse, do not reimplement).
- `apps/web/utils/calendar/providers/google-events.ts` — `GoogleCalendarEventProvider` (already wraps `calendar.events.list`; build the cached read function on top).
- `apps/web/utils/redis/` — existing Redis utility patterns (e.g. `research-cache.ts` for read-through cache shape).

**Reference (do not modify in this phase):**
- `apps/web/utils/ai/calendar/availability.ts` — separate reply-drafting code path; uses calendar in a different way.
</canonical_refs>

<code_context>
## Reusable Assets and Patterns

- **`getCalendarClientWithRefresh`** in `utils/calendar/client.ts` — token refresh + OAuth client. Reuse directly.
- **`GoogleCalendarEventProvider.fetchEvents*`** in `utils/calendar/providers/google-events.ts` — already speaks `calendar_v3.Calendar`. Phase 8 needs a thin "next 7 days, primary calendar, exclude declined/tentative, normalize" wrapper on top — NOT a new provider.
- **Existing Redis cache patterns** in `utils/redis/research-cache.ts` (and siblings) — copy the TTL + JSON-blob read-through shape.
- **No DB migration needed** for Phase 8. No Prisma schema changes.
</code_context>

<open_questions_for_research>
## For gsd-phase-researcher

1. **`responseStatus` shape from the Google Calendar API** — confirm it's reliably present on personal-calendar events (organizer == owner case may behave differently than invited-to-meeting case).
2. **All-day event time fields** — Google returns `date` instead of `dateTime` for all-day events. Confirm the normalized shape handles both branches cleanly.
3. **Stale-cache detection** — Upstash Redis client behavior when TTL has expired (returns null vs throws vs returns stale). May affect D-09 implementation.
4. **Existing `utils/redis/` patterns** — which sibling cache file is the closest analog for read-through with stale fallback? Plan-phase should mirror that file's structure.
5. **Calendar scopes already granted** — verify the existing OAuth grant for `rebekah@trueocean.com` includes `calendar.readonly` (or broader); if not, this phase blocks on a re-consent step.
</open_questions_for_research>

<verification_hooks>
## Things plan-phase / verify-work should check

- [ ] Read function returns normalized shape; downstream callers never see `calendar_v3.Schema$Event`.
- [ ] Declined event present in Google Calendar → absent from returned list (test against a real declined event on the dev calendar if possible, or a fixture).
- [ ] Tentative event present → absent from returned list.
- [ ] All-day event present → returned with `isAllDay: true` and start/end as date-only.
- [ ] Calendar API returns 401 (expired token) → token refresh attempted, succeeds, fetch returns normally.
- [ ] Calendar API returns 5xx → stale cache returned if present; empty list if not; warning logged either way.
- [ ] Cold cache + two near-simultaneous reads → only one Calendar API call hits (or at worst two, not N — confirm no thundering-herd issue in the chosen Redis pattern).
- [ ] Past events are pruned from cached blob before returning (15-min-old cache should not surface a meeting that ended 10 min ago).
</verification_hooks>
