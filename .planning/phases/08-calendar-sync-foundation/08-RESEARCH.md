# Phase 8: Calendar Sync Foundation — Research

**Researched:** 2026-05-22
**Domain:** Google Calendar read path + Upstash Redis read-through cache
**Confidence:** HIGH

<user_constraints>
## User Constraints (from 08-CONTEXT.md)

### Locked Decisions (D-01 — D-12)

- **D-01:** Single exported function `getUpcomingEvents({ emailAccountId, now })` is the ONLY read path for downstream consumers (Phase 9 reconciliation, Phase 10 digest). No direct calls to `GoogleCalendarEventProvider` from feature code.
- **D-02:** Normalized event shape is the Phase 9/10 contract: `{ id, title, start (ISO), end (ISO), isAllDay, location (nullable), description (nullable), attendees (string[] of email), htmlLink }`. No Google-specific fields leak.
- **D-03:** Primary calendar only (`calendarId: "primary"`). Multi-calendar deferred.
- **D-04:** Redis cache, key `calendar:events:{emailAccountId}`. Reuse existing Upstash client. JSON-encoded normalized event list.
- **D-05:** TTL = 15 minutes.
- **D-06:** 7-day forward window from `now`. Cache key does NOT vary by time. Past events pruned in the read function (no API round-trip).
- **D-07:** Exclude `declined` and `tentative` based on calendar owner's `responseStatus` in `attendees`. Keep `accepted` and `needsAction`. Excluded events never enter cache.
- **D-08:** Include all-day events, marked `isAllDay: true`.
- **D-09:** On Calendar API failure: return stale cache if present (warn log); else return empty list. Downstream features degrade gracefully.
- **D-10:** No retry inside the read function.
- **D-11:** No token logging in Phase 8 (zero LLM calls).
- **D-12:** Time-based invalidation only — no webhooks, no manual flush command in v1.1.

### Claude's Discretion
- Read-function name finalized in plan-phase (CONTEXT proposes `getUpcomingEvents`).
- File location for new module (recommend `apps/web/utils/calendar/upcoming-events.ts` next to existing calendar utils).
- Manual cache flush command — defer to Phase 9 only if reconciliation testing demands it.

### Deferred Ideas (OUT OF SCOPE)
- Calendar push notifications / webhooks for invalidation.
- Multi-calendar / secondary calendars / Outlook.
- Manual cache flush admin command in v1.1.
- Per-user TTL tuning.
- Calendar-aware classification urgency bias (formally dropped from v1.1).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAL-01 | Fetch next 7 days primary-calendar events, single cached read path | `GoogleCalendarEventProvider.fetchEvents` already wraps `calendar.events.list`; thin cached wrapper goes in `utils/calendar/upcoming-events.ts`. Reuses `getCalendarClientWithRefresh` for OAuth + refresh. |
| CAL-02 | Declined and tentative excluded — never reach extraction/reconciliation/digest | Filter `attendees[].self === true && responseStatus in {declined, tentative}` BEFORE caching. Google API has no server-side filter for this — must filter client-side after `events.list`. |
| CAL-03 | Per-email-account key, refresh ≤1× per N minutes | Key = `calendar:events:{emailAccountId}` with TTL = 900s. Mirror `account-validation.ts` read-through pattern. |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Do NOT run `tsc`, `pnpm build`, `pnpm exec tsc`, or full typecheck locally** — locks up Windows machine. Use editor diagnostics only; CI handles typecheck on push to `main`.
- `pnpm test` and `pnpm lint` (Biome) are OK to run.
- Linter is **Biome**, not ESLint.
- `pnpm dev` / `pnpm build` not to be run unless user explicitly asks.
- No DB migration required for Phase 8 (no Prisma schema changes).
- Self-hosted single-tenant fork; no multi-user abstractions.

## Summary

Phase 8 is a small, well-bounded plumbing phase. All the hard infrastructure already exists in the fork:

1. **OAuth + token refresh** — `getCalendarClientWithRefresh` in `apps/web/utils/calendar/client.ts` already handles `invalid_grant`, persists refreshed tokens via `saveCalendarTokens`, and resolves the `calendarConnection` row. Reuse as-is. [VERIFIED]
2. **`events.list` wrapper** — `GoogleCalendarEventProvider.fetchEvents` in `apps/web/utils/calendar/providers/google-events.ts` already calls `events.list` against `calendarId: "primary"` with `singleEvents: true, orderBy: "startTime"`. The new module wraps this. [VERIFIED]
3. **OAuth scopes** — `CALENDAR_SCOPES` in `apps/web/utils/gmail/scopes.ts` already includes `calendar.readonly` AND `calendar.events` AND `calendar.freebusy`. **No re-consent needed.** [VERIFIED — see file:line below]
4. **Redis client** — `apps/web/utils/redis/index.ts` exports a singleton Upstash client. `account-validation.ts` is the closest read-through analog (cache → DB → cache). [VERIFIED]

The two non-trivial design issues are:

- **Stale-cache fallback (D-09) collides with standard Redis TTL semantics.** Upstash `redis.get()` on an expired key returns `null` — not the stale value. To honor D-09, the cache must store a **long-lived envelope** (`{ data, fetchedAt }`) with a TTL well past 15 minutes (e.g. 24h), and the read function treats the 15-min mark as a *soft expiry* (refetch) while keeping the blob retrievable beyond it for fallback. This is a critical detail the planner must encode.
- **Thundering herd on cold cache** — `account-validation.ts` does not lock; two near-simultaneous misses both hit the source. For Phase 8 volume (1 user, ~3.5 emails/hr peak) this is acceptable per D-09's "one or two, not N" tolerance. An `acquireOwnedLock` pattern exists in `owned-lock.ts` if the planner wants belt-and-suspenders, but it is not required.

**Primary recommendation:** Build a single new file `apps/web/utils/calendar/upcoming-events.ts` exporting `getUpcomingEvents({ emailAccountId, now, logger })`. Mirror `account-validation.ts` for cache structure but use an **envelope with `fetchedAt`** and a **hard TTL of 24h** so D-09 stale fallback actually works. Use `createCalendarEventProviders` from `apps/web/utils/calendar/event-provider.ts` to construct the Google provider from the `CalendarConnection` row — or read the connection directly and instantiate `GoogleCalendarEventProvider` to avoid pulling in the Microsoft branch.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Google Calendar API call | API / Backend (Next.js server route or background worker call site) | — | OAuth tokens live in Postgres; calendar fetch must be server-side. |
| Token refresh on 401 | API / Backend | Postgres (persist new token) | Already handled by `getCalendarClientWithRefresh`. |
| Cache (read + write + stale fallback) | Upstash Redis (shared between web + worker) | — | Survives restarts; per D-04. |
| Filter declined/tentative | API / Backend (in the read function) | — | Google API has no server-side filter. |
| Past-event pruning | API / Backend (in the read function, against `now`) | — | Cache key intentionally not time-of-day scoped (D-06). |
| Normalization to D-02 shape | API / Backend (in the read function, before caching) | — | Downstream callers see only the contract. |

## Standard Stack

### Core

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@googleapis/calendar` | already in repo (used by `client.ts`) | Google Calendar v3 API client | Already the chosen client in this fork. [VERIFIED] |
| `@upstash/redis` | already in repo (`utils/redis/index.ts`) | Upstash Redis HTTP client | Already wired; BullMQ also uses Upstash. [VERIFIED] |
| `date-fns` + `@date-fns/tz` | already in repo (`unified-availability.ts`) | Date math for "now + 7d" window | Already used in calendar code. [VERIFIED] |

No new dependencies required. **Skip `npm install` task entirely.**

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual envelope with `fetchedAt` | A second key for stale fallback (e.g. `calendar:events:{id}:stale`) | Two writes per refresh; more moving parts. Envelope is simpler. |
| `createCalendarEventProviders` (returns array, includes Microsoft branch) | Instantiate `GoogleCalendarEventProvider` directly from a single `CalendarConnection` row | Cleaner for primary-Google-only scope. Recommended. |
| `acquireOwnedLock` for cold-cache thundering-herd protection | Skip locking | At single-user volume, 2 simultaneous misses is acceptable; lock adds latency on every miss. Skip. |

## Open Questions — Answered

### Q1. `responseStatus` shape on personal-calendar events

**Answer:** `responseStatus` is per-attendee, only meaningful on the entry where `attendee.self === true`. For events the user **created** (organizer == owner) where they did not invite themselves as an attendee, the `attendees` array may be **empty or omitted entirely** — there is no `self` attendee row. These events must be treated as `accepted` (do not exclude). Only exclude when a `self`-attendee row exists with `responseStatus` of `declined` or `tentative`.

**Evidence:**
- Google Calendar v3 `Events` resource — `attendees[].responseStatus` enum: `needsAction | declined | tentative | accepted`. `attendees[].self` is a boolean. ([developers.google.com](https://developers.google.com/workspace/calendar/api/v3/reference/events))
- Google API has no server-side filter on `responseStatus`; filtering is application-side ([same source]).
- Existing fork code does not yet filter on `responseStatus` anywhere — `grep` for `responseStatus` in `apps/web/utils/calendar` returns 0 hits. This is net-new logic.

**Implementation rule:**
```ts
function isExcluded(event: calendar_v3.Schema$Event): boolean {
  const selfAttendee = event.attendees?.find((a) => a.self === true);
  if (!selfAttendee) return false; // no self row → user is organizer, keep
  return (
    selfAttendee.responseStatus === "declined" ||
    selfAttendee.responseStatus === "tentative"
  );
}
```

Confidence: **HIGH** (Google docs + existing `event-types` shape).

### Q2. All-day events — `date` vs `dateTime`

**Answer:** All-day events use `event.start.date` and `event.end.date` (string `"YYYY-MM-DD"`). Timed events use `event.start.dateTime` and `event.end.dateTime` (RFC3339). Both branches are present in `calendar_v3.Schema$EventDateTime`. `timeZone` on all-day events is meaningless — the date is calendar-local. The existing `parseEvent` at `apps/web/utils/calendar/providers/google-events.ts:97-103` already handles both branches using `new Date(event.start?.dateTime || event.start?.date || Date.now())`, but for the D-02 normalized shape we should **preserve the all-day distinction explicitly** rather than collapsing into a `Date`.

**Recommended normalization:**
```ts
function normalize(event: calendar_v3.Schema$Event): NormalizedCalendarEvent {
  const startDateTime = event.start?.dateTime ?? null;
  const endDateTime = event.end?.dateTime ?? null;
  const isAllDay = !startDateTime && !!event.start?.date;
  return {
    id: event.id ?? "",
    title: event.summary ?? "Untitled",
    start: isAllDay ? (event.start?.date as string) : (startDateTime as string), // "YYYY-MM-DD" or RFC3339
    end:   isAllDay ? (event.end?.date as string)   : (endDateTime as string),
    isAllDay,
    location: event.location ?? null,
    description: event.description ?? null,
    attendees: (event.attendees ?? []).map((a) => a.email).filter((e): e is string => !!e),
    htmlLink: event.htmlLink ?? "",
  };
}
```

D-02 says `start (ISO), end (ISO)` — the planner should clarify that for all-day events `start`/`end` are ISO **dates** (`"2026-05-25"`), not full ISO timestamps. Phase 10's renderer can branch on `isAllDay`.

**Evidence:**
- `apps/web/utils/calendar/providers/google-events.ts:97-103` — current dual-branch handling.
- Google Calendar `EventDateTime` reference: "The date is in the format 'yyyy-mm-dd' if this is an all-day event… timezone has no significance for all-day events." ([developers.google.com](https://developers.google.com/workspace/calendar/api/v3/reference/events)).

Confidence: **HIGH**.

### Q3. Upstash Redis TTL expiry behavior (critical for D-09)

**Answer:** `@upstash/redis` follows standard Redis semantics — when `redis.get(key)` is called on an expired key, Redis deletes it and returns `null`. **You cannot read a stale value after the TTL expires.** This means D-09's "return stale cache on API failure" cannot be implemented with a 15-minute TTL alone.

**Implementation strategy — soft expiry envelope:**

Store `{ data: NormalizedCalendarEvent[], fetchedAt: number /* unix ms */ }` with a **hard TTL of 24 hours** (or 1 hour — pick in plan-phase). The read function:

```ts
const FRESH_MS = 15 * 60 * 1000;
const HARD_TTL_S = 24 * 60 * 60;

const envelope = await redis.get<Envelope>(key); // null if hard TTL expired
const isFresh = envelope && (now - envelope.fetchedAt) < FRESH_MS;

if (isFresh) return pastPrune(envelope.data, now);

try {
  const fresh = await fetchFromGoogle(...);
  await redis.set(key, { data: fresh, fetchedAt: now }, { ex: HARD_TTL_S });
  return pastPrune(fresh, now);
} catch (err) {
  logger.warn("Calendar API fetch failed", { err });
  if (envelope) return pastPrune(envelope.data, now); // stale fallback
  return []; // no cache, no source → empty
}
```

This pattern is **not currently used elsewhere in the fork** — `grep "stale|fetchedAt|cachedAt|softExpire"` in `apps/web/utils/redis` returns 0 hits. The planner must call this out as net-new and make it explicit in the implementation tasks.

**Evidence:**
- [Upstash TTL docs](https://upstash.com/docs/redis/sdks/py/commands/generic/ttl) — standard Redis expiry semantics.
- Verified: `Grep "stale|softExpire|fetchedAt|cachedAt" apps/web/utils/redis` → no matches.
- `apps/web/utils/redis/account-validation.ts` uses simple TTL with no stale fallback — it's the closest structural analog but does NOT solve D-09.

Confidence: **HIGH** (semantics) / **HIGH** (gap analysis — no existing pattern to copy).

### Q4. Closest existing analog for read-through cache

**Answer:** Three candidates, ranked:

1. **`apps/web/utils/redis/account-validation.ts`** — **closest structural analog.** Read-through with try/catch around both `redis.get` and `redis.set`, falls through to source (Postgres) on miss, caches result with `{ ex: EXPIRATION }`. Mirror this structure but swap Postgres for the Google client and add the envelope-with-`fetchedAt` for D-09.

2. **`apps/web/utils/redis/research-cache.ts`** — more elaborate (SHA256-keyed, size cap, scoped logger, `clearCachedResearchForUser` via `redis.scan`). Good reference for the scoped-logger + `isRedisConfigured()` guard pattern, but its 30-day TTL and content-hash keying are not needed here.

3. **`apps/web/utils/redis/reply.ts`** — uses `JSON.stringify` + `redis.set` + manual parse on read. Demonstrates JSON envelope handling but doesn't show stale fallback.

**Recommended:** copy `account-validation.ts` structure verbatim, then graft on the envelope pattern from Q3.

**Code excerpt to mirror** (`apps/web/utils/redis/account-validation.ts:36-60`):
```ts
const key = getValidationKey({ userId, emailAccountId });

// Check Redis cache first
try {
  const cachedResult = await redis.get<string>(key);
  if (cachedResult !== null) {
    return cachedResult;
  }
} catch {
  // Redis unavailable — fall through to database
}

// Not in cache, check database
const emailAccount = await prisma.emailAccount.findUnique({ ... });

// Cache the result (best-effort)
try {
  await redis.set(key, emailAccount?.email ?? null, { ex: EXPIRATION });
} catch {
  // Redis unavailable — skip caching
}
```

Confidence: **HIGH**.

### Q5. OAuth scopes already granted

**Answer:** Yes — `calendar.readonly` is in the consented scope set, and so is `calendar.events` (Phase 9 will need this for `events.insert`). **No re-consent required.**

**Evidence:** `apps/web/utils/gmail/scopes.ts:14-24`:
```ts
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events", // For writing/creating events in the future
  "https://www.googleapis.com/auth/calendar.freebusy",
];
```

`getCalendarClientWithRefresh` sets these on the OAuth2 client at `apps/web/utils/calendar/client.ts:21-26`. The `CalendarConnection` row in Postgres holds the refresh token. To **verify on the live system** before plan-phase ships, the plan can include a one-shot manual check: `psql … -c "SELECT scope FROM \"CalendarConnection\" WHERE …"` — but the code path proves the consent screen requested these scopes.

Confidence: **HIGH** (code) / **MEDIUM** for live-DB confirmation (recommend a verification task in plan).

## Architecture Patterns

### System Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  Caller (Phase 9 reconciliation / Phase 10 digest renderer)        │
│  → getUpcomingEvents({ emailAccountId, now, logger })              │
└────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────────┐
│  utils/calendar/upcoming-events.ts                                 │
│                                                                    │
│  1. redis.get(`calendar:events:{emailAccountId}`)                  │
│      └─ envelope: { data, fetchedAt } | null                       │
│                                                                    │
│  2. isFresh? (now - fetchedAt < 15min)                             │
│      ├─ yes → pastPrune(envelope.data, now) → return               │
│      └─ no  → continue to step 3                                   │
│                                                                    │
│  3. Look up CalendarConnection (Postgres) for emailAccountId       │
│      where provider='google' and isConnected=true                  │
│      └─ none → log + return [] or stale envelope.data              │
│                                                                    │
│  4. Construct GoogleCalendarEventProvider, call fetchEvents({      │
│       timeMin: now, timeMax: now + 7d, maxResults: 250 })          │
│      ├─ success → step 5                                           │
│      └─ failure → log warn, return stale envelope.data or []       │
│                                                                    │
│  5. Filter: drop events where self-attendee responseStatus is      │
│     declined or tentative                                          │
│                                                                    │
│  6. Normalize to D-02 shape (id, title, start, end, isAllDay,      │
│     location, description, attendees: string[], htmlLink)          │
│                                                                    │
│  7. redis.set(key, { data: normalized, fetchedAt: now },           │
│              { ex: 24h hard TTL })                                 │
│                                                                    │
│  8. pastPrune(normalized, now) → return                            │
└────────────────────────────────────────────────────────────────────┘
```

### Recommended File Layout

```
apps/web/utils/calendar/
├── upcoming-events.ts          # NEW — getUpcomingEvents, normalize, isExcluded, pastPrune
├── upcoming-events.test.ts     # NEW — vitest unit tests
├── client.ts                   # existing — reuse getCalendarClientWithRefresh
├── event-provider.ts           # existing — optional helper (or skip and read CalendarConnection directly)
└── providers/
    └── google-events.ts        # existing — reuse GoogleCalendarEventProvider OR call calendar.events.list directly
```

### Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OAuth token refresh | Custom refresh loop | `getCalendarClientWithRefresh` | Already persists tokens via `saveCalendarTokens`, handles `invalid_grant`. [VERIFIED file] |
| Google Calendar API client | Raw fetch to `googleapis.com` | `@googleapis/calendar` | Already in repo, typed (`calendar_v3.Schema$Event`). |
| Redis client setup | New `new Redis()` instance | `import { redis } from "@/utils/redis"` | Singleton, already configured from env. |
| JSON cache envelope serialization | Custom JSON.stringify wrappers | `redis.set(key, obj, { ex })` + `redis.get<Envelope>(key)` | Upstash SDK auto-serializes objects. Confirmed in `reply.ts`. |
| Date arithmetic (now + 7d) | Manual `Date` math | `date-fns` `addDays` | Already in repo. |

## Code Examples

### Constructing the provider from a CalendarConnection row

Adapted from `apps/web/utils/calendar/event-provider.ts:37-53`:

```ts
const connection = await prisma.calendarConnection.findFirst({
  where: { emailAccountId, provider: "google", isConnected: true },
  select: {
    id: true,
    accessToken: true,
    refreshToken: true,
    expiresAt: true,
  },
});

if (!connection?.refreshToken) {
  logger.warn("No Google calendar connection for emailAccount", { emailAccountId });
  return staleData ?? [];
}

const provider = new GoogleCalendarEventProvider(
  {
    accessToken: connection.accessToken,
    connectionId: connection.id,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt?.getTime() ?? null,
    emailAccountId,
  },
  logger,
);

const events = await provider.fetchEvents({
  timeMin: now,
  timeMax: addDays(now, 7),
  maxResults: 250,
});
```

**Trade-off note:** `GoogleCalendarEventProvider.fetchEvents` returns the existing fork's `CalendarEvent` shape (with `startTime`/`endTime` as `Date`, `attendees` as `{email,name}[]`), which **loses the all-day distinction** (it collapses to a `Date`) and **loses `responseStatus`**. For Phase 8 we need the raw `calendar_v3.Schema$Event` to filter on `responseStatus` and preserve the all-day flag.

**Recommendation:** the new `upcoming-events.ts` should call `getCalendarClientWithRefresh` directly and invoke `client.events.list(...)` itself (5 lines, same as `GoogleCalendarEventProvider.fetchEvents:82-90`), then run its own filter + normalize. This sidesteps the lossy intermediate shape. The planner should encode this as an explicit decision.

## Common Pitfalls

### Pitfall 1: Filtering on `responseStatus` without checking `self`
**What goes wrong:** You exclude an event because *some attendee* declined, when in fact the calendar owner accepted.
**Why it happens:** `responseStatus` is per-attendee. The owner's status is on the row where `attendee.self === true`.
**How to avoid:** Always find the self-attendee row first; events with no self row are owner-created and should be kept.

### Pitfall 2: Treating empty `attendees` array as "everyone declined"
**What goes wrong:** Solo events the user created (e.g. "Doctor appointment Monday 3pm" with no other attendees) get dropped.
**Why it happens:** Google omits the `attendees` array entirely on single-attendee owner-created events.
**How to avoid:** No self row → keep the event.

### Pitfall 3: Using `redis.get` to retrieve stale data after TTL expiry
**What goes wrong:** D-09 stale fallback returns `null` from Redis on every API failure that happens >15 min after a successful fetch, so the user gets an empty list when they should have stale data.
**Why it happens:** Standard Redis TTL deletes the key; `get` returns null.
**How to avoid:** Use the envelope + soft-expiry pattern (Q3). Hard TTL must be >>15 min.

### Pitfall 4: All-day event collapsed into a `Date` with implicit UTC midnight
**What goes wrong:** "Camping trip 5/25" rendered as "5/24 8pm ET" in the digest.
**Why it happens:** `new Date("2026-05-25")` parses as UTC midnight, which is 8pm ET the previous day.
**How to avoid:** Preserve `event.start.date` as a **string** (`"YYYY-MM-DD"`) in the normalized shape when `isAllDay` is true; never wrap it in `new Date()`.

### Pitfall 5: `singleEvents: false` returns recurring-event masters
**What goes wrong:** A weekly recurring event shows up once with weird `recurrence` rules instead of as 7 instances.
**Why it happens:** Default is to return the recurrence master, not expanded instances.
**How to avoid:** Always pass `singleEvents: true, orderBy: "startTime"` (as the existing `fetchEvents` does).

### Pitfall 6: Past events surfacing from a 14-minute-old cache
**What goes wrong:** A meeting that ended 10 minutes ago appears in the digest agenda.
**Why it happens:** Cache TTL is 15 min, so a meeting cached at 8:00am ends at 8:30am but is still in the blob until 8:15 refresh.
**How to avoid:** D-06 mandates `pastPrune` on every read — drop events where `end < now` BEFORE returning. Cache stays unchanged; pruning is per-call.

## Upstash Redis — Read-Then-Set Pattern Used Elsewhere

| File | Pattern |
|------|---------|
| `apps/web/utils/redis/account-validation.ts` | `redis.get` → fall through to Postgres → `redis.set { ex }`. Try/catch around BOTH ops. Returns null gracefully if Redis is down. |
| `apps/web/utils/redis/reply.ts` | `redis.get<string>` → `JSON.parse` → schema-validate. `redis.set(key, JSON.stringify(obj), { ex })`. |
| `apps/web/utils/redis/research-cache.ts` | Same shape + size cap, SHA256 key hashing, scoped logger, `isRedisConfigured()` guard, `clearCachedResearchForUser` via `redis.scan`. |

**Stale-fallback pattern: NOT IMPLEMENTED anywhere in the fork.** This is net-new logic.

## OAuth Scopes — Confirmation

| Scope | Granted? | Source |
|-------|----------|--------|
| `calendar.readonly` | YES | `apps/web/utils/gmail/scopes.ts:17` |
| `calendar.events` (Phase 9) | YES | `apps/web/utils/gmail/scopes.ts:18` |
| `calendar.freebusy` (reply availability) | YES | `apps/web/utils/gmail/scopes.ts:19` |

**No re-consent flow needed for Phase 8 or Phase 9 event creation.** Live-DB check is recommended but not blocking (one verification task in plan).

## Thundering-Herd / Concurrency

- **`account-validation.ts` does not lock.** Two simultaneous misses both hit Postgres; last write wins. Equivalent here would be: two simultaneous misses both call `events.list`; last write wins on the envelope.
- **Volume:** single user, peak ~3.5 emails/hr per CONTEXT — at most 1 cold-cache event every ~17 min on average. Probability of two simultaneous misses is negligible.
- **D-09 acceptance criterion:** "only one Calendar API call (or at worst two, not N)." Without locking, worst case is N=2 (two concurrent reads). This is within tolerance.
- **If the planner wants belt-and-suspenders:** `acquireOwnedLock` from `apps/web/utils/redis/owned-lock.ts:19-33` can wrap the refresh path. Not recommended for Phase 8 — adds latency on every miss and complicates the read function. Defer to Phase 9 if reconciliation testing exposes a problem.

## Runtime State Inventory

This is not a rename/refactor phase, but inventory categories for completeness:

| Category | Items | Action |
|----------|-------|--------|
| Stored data | None — new Redis key, no migration | None |
| Live service config | None — no new external services | None |
| OS-registered state | None | None |
| Secrets / env vars | Existing `UPSTASH_REDIS_URL` + `UPSTASH_REDIS_TOKEN` already present. No new env vars. | None |
| Build artifacts | None — no schema, no codegen | None |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Upstash Redis (prod) | Cache layer | ✓ (already used by BullMQ) | live | If down, `redis.get` throws → caught → API direct (no caching this read; one extra API call) |
| Google Calendar API | Event source | ✓ (used by existing `availability.ts`) | v3 | D-09: stale cache → empty list |
| `@googleapis/calendar` npm package | API client | ✓ (already in package.json) | as installed | — |
| `@upstash/redis` npm package | Redis client | ✓ (already in package.json) | as installed | — |
| `CalendarConnection` Postgres row for `rebekah@trueocean.com` | OAuth credentials | UNVERIFIED in this research session — plan should include one psql verification task | — | If missing, log warn + return [] |

**No blocking missing dependencies.** One soft-verification task (live DB has a `CalendarConnection` row with `provider='google'`, `isConnected=true`) should be in Wave 0.

## Validation Architecture

`workflow.nyquist_validation` not explicitly disabled — include this section.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing `pnpm test`) |
| Config file | `apps/web/vitest.config.ts` (existing) |
| Quick run command | `pnpm --filter inbox-zero-ai test -- utils/calendar/upcoming-events.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File |
|--------|----------|-----------|-------------------|------|
| CAL-01 | Returns normalized event list (D-02 shape) for next 7 days | unit | `pnpm test -- upcoming-events.test.ts -t "normalized shape"` | ❌ Wave 0 |
| CAL-01 | Calls `events.list` with `calendarId: "primary"`, `singleEvents: true`, `timeMin=now`, `timeMax=now+7d` | unit (mock calendar client) | `pnpm test -- upcoming-events.test.ts -t "events.list params"` | ❌ Wave 0 |
| CAL-02 | Declined event (self responseStatus='declined') excluded from result | unit (fixture) | `pnpm test -- upcoming-events.test.ts -t "excludes declined"` | ❌ Wave 0 |
| CAL-02 | Tentative event (self responseStatus='tentative') excluded | unit (fixture) | `pnpm test -- upcoming-events.test.ts -t "excludes tentative"` | ❌ Wave 0 |
| CAL-02 | Owner-created event (no self attendee row) included | unit (fixture) | `pnpm test -- upcoming-events.test.ts -t "keeps owner-created"` | ❌ Wave 0 |
| CAL-02 | accepted + needsAction kept | unit | `pnpm test -- upcoming-events.test.ts -t "keeps accepted needsAction"` | ❌ Wave 0 |
| D-08 | All-day event surfaces with `isAllDay: true` and start = `"YYYY-MM-DD"` string | unit | `pnpm test -- upcoming-events.test.ts -t "all-day"` | ❌ Wave 0 |
| CAL-03 | Fresh cache hit (within 15 min) does NOT call Google | unit (mock) | `pnpm test -- upcoming-events.test.ts -t "fresh cache hit"` | ❌ Wave 0 |
| CAL-03 | Cache key = `calendar:events:{emailAccountId}` | unit (mock redis) | `pnpm test -- upcoming-events.test.ts -t "cache key"` | ❌ Wave 0 |
| D-09 | API failure with stale envelope → returns stale data + warn log | unit | `pnpm test -- upcoming-events.test.ts -t "stale fallback on API failure"` | ❌ Wave 0 |
| D-09 | API failure with NO envelope → returns `[]` | unit | `pnpm test -- upcoming-events.test.ts -t "empty on no cache + failure"` | ❌ Wave 0 |
| D-06 | Cached event with `end < now` pruned before return | unit | `pnpm test -- upcoming-events.test.ts -t "past-event pruning"` | ❌ Wave 0 |
| OAuth | Calendar 401 triggers token refresh via `getCalendarClientWithRefresh` | unit (mock client.ts) OR integration with stubbed OAuth | `pnpm test -- upcoming-events.test.ts -t "token refresh on 401"` | ❌ Wave 0 |
| Concurrency | Two near-simultaneous cold-cache reads → ≤2 Google calls | unit (Promise.all) | `pnpm test -- upcoming-events.test.ts -t "no thundering herd"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter inbox-zero-ai test -- upcoming-events.test.ts`
- **Per wave merge:** `pnpm test` (web-app vitest suite, no AI tests)
- **Phase gate:** Full `pnpm test` green; CI push (lint + typecheck on remote — never local per CLAUDE.md).

### Wave 0 Gaps
- [ ] `apps/web/utils/calendar/upcoming-events.test.ts` — new file, covers all 14 cases above.
- [ ] Mock fixtures for `calendar_v3.Schema$Event` covering: declined-self, tentative-self, accepted-self, needsAction-self, no-self-row (owner-created), all-day, past event, recurring-expanded instance.
- [ ] Optionally: shared `mockRedis` helper if no existing one — check `apps/web/utils/redis/*.test.ts` for an existing pattern before adding.

## Failure Modes Executor Must Test (concise list)

1. Declined event (`attendees[].self===true, responseStatus==='declined'`) → excluded.
2. Tentative event (`responseStatus==='tentative'`) → excluded.
3. All-day event → returned with `isAllDay:true` and date-only `start`/`end`.
4. Stale envelope present + Google API throws → returns stale data, logs warn.
5. No envelope + Google API throws → returns `[]`, logs warn.
6. Past event in cached blob → pruned before return.
7. 401 from Calendar API → `getCalendarClientWithRefresh` refreshes token, fetch succeeds.
8. Owner-created event with empty `attendees` → included (not excluded as "declined").
9. Two simultaneous cold reads → ≤2 Google calls (no N-amplification).
10. Cache key matches exactly `calendar:events:{emailAccountId}` (Phase 9/10 will share it).

## Risks / Landmines for the Planner

1. **D-09 cannot be implemented with a naive 15-min TTL.** The envelope-with-`fetchedAt` + 24h hard TTL is required. The planner MUST encode this explicitly in a task ("Cache envelope shape includes `fetchedAt`; hard TTL is 24h; soft expiry compared at read time") or implementation will silently miss D-09 acceptance.
2. **D-02 says `start (ISO)` for ALL events.** For all-day events, this is `"YYYY-MM-DD"` (a calendar-date, not a timestamp). The planner should clarify the contract so Phase 10 doesn't `new Date(start)` and double-shift into UTC. Recommended clarification: "`start` and `end` are RFC3339 timestamps for timed events; `YYYY-MM-DD` strings for all-day events."
3. **`responseStatus` semantics non-obvious for owner-created events** — empty `attendees` array is NOT "everyone declined." This needs an explicit fixture in the test file.
4. **Using `GoogleCalendarEventProvider.fetchEvents` loses `responseStatus` and the all-day flag.** Phase 8 must NOT layer on top of this method — it must call `client.events.list` directly. Easy mistake for executor to make if plan just says "wrap `GoogleCalendarEventProvider`."
5. **Verifying scopes against the live DB is recommended but soft.** If for some reason the existing connection was made with a narrower scope set than the code constants imply, the API call will 403. Plan should include a one-time live verification step (or a defensive fallback path that logs `403` clearly).
6. **No DB migration required, but verify `CalendarConnection` row exists for `rebekah@trueocean.com` with `isConnected=true`.** If it doesn't, the read function returns `[]` forever and nothing visible breaks until Phase 10. Add an early-warn log: "No Google calendar connection found."
7. **`maxResults`.** Existing `fetchEvents` defaults to 10. Seven days of personal events is up to ~30 with all-day birthdays/holidays; pass `maxResults: 250` (Google max is 2500) to be safe.
8. **Biome is the linter.** Don't add ESLint disable comments — they're meaningless and Biome will ignore them.
9. **`pnpm test` runs the full vitest suite.** For per-task feedback, scope to the new test file (`pnpm test -- upcoming-events.test.ts`). Local typecheck is forbidden per CLAUDE.md.
10. **Cache invalidation = TTL only (D-12).** Do NOT build a "flush" admin endpoint in Phase 8. If Phase 9 testing demands it, add it there.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Live `CalendarConnection` row exists for `rebekah@trueocean.com` with valid refresh token | Environment | If absent, Phase 8 returns empty list forever; Phase 10 digest looks broken. Mitigation: plan includes a verification task. |
| A2 | OAuth grant on the live system matches `CALENDAR_SCOPES` array | OAuth Scopes | If user previously consented before `calendar.events` was added, only `readonly` may be granted; Phase 9 creates will 403. Mitigation: soft-verify, but doesn't block Phase 8 (read-only). |
| A3 | Single-user volume means thundering-herd lock is unnecessary | Concurrency | Risk: low. Worst case is one extra Google call per cold-cache window; well within free quota. |
| A4 | 24h hard TTL is acceptable for stale fallback (vs. 1h or 6h) | Cache design | Risk: stale data older than a few hours is still "better than empty" for personal-logistics use case per CONTEXT framing. Planner picks the exact number. |

## Sources

### Primary (HIGH confidence)
- `apps/web/utils/calendar/client.ts:39-125` — `getCalendarClientWithRefresh`, token refresh, `invalid_grant` handling.
- `apps/web/utils/calendar/providers/google-events.ts:72-128` — `fetchEvents` + `parseEvent` (current dual-branch date handling).
- `apps/web/utils/calendar/event-provider.ts:37-66` — `CalendarConnection` query + provider construction pattern.
- `apps/web/utils/gmail/scopes.ts:14-24` — `CALENDAR_SCOPES` includes `readonly` + `events` + `freebusy`.
- `apps/web/utils/redis/index.ts` — Upstash singleton.
- `apps/web/utils/redis/account-validation.ts:36-60` — closest read-through analog.
- `apps/web/utils/redis/research-cache.ts:14-129` — scoped logger + `isRedisConfigured()` pattern.
- `apps/web/utils/redis/reply.ts:38-85` — JSON envelope + parse pattern.
- `apps/web/utils/redis/owned-lock.ts:19-33` — optional lock primitive (deferred).
- [Google Calendar API Events reference](https://developers.google.com/workspace/calendar/api/v3/reference/events) — `responseStatus` enum, `attendees[].self`, `EventDateTime` `date` vs `dateTime`.

### Secondary (MEDIUM confidence)
- [Upstash TTL semantics](https://upstash.com/docs/redis/sdks/py/commands/generic/ttl) — confirms expired keys return null.
- Grep audit `apps/web/utils/redis` for `stale|fetchedAt|cachedAt` → 0 hits — confirms net-new pattern.
- Grep audit `apps/web/utils/calendar` for `responseStatus` → 0 hits — confirms net-new filter logic.

### Tertiary (LOW confidence)
- Live system state (DB row existence, exact granted scopes) — recommend verification task in plan.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies already in repo.
- Architecture: HIGH — pattern mirrors `account-validation.ts` + envelope addition.
- Pitfalls: HIGH — `responseStatus`/`self` rule and all-day date string rule are both well documented.
- D-09 stale-fallback implementation: HIGH on semantics, MEDIUM on which exact hard TTL to choose (planner picks).
- Live OAuth/connection state: MEDIUM — needs soft verification task.

**Research date:** 2026-05-22
**Valid until:** 2026-06-22 (Google Calendar API v3 + Upstash Redis are both stable; 30-day shelf life)

## RESEARCH COMPLETE

Phase 8 is fully de-risked. The dominant landmine is that **D-09 stale-cache fallback cannot be built with a 15-minute Redis TTL** — Upstash (and standard Redis) deletes the key on expiry, so `redis.get` returns null. The fix is a soft-expiry envelope (`{ data, fetchedAt }`) stored with a 24h hard TTL; the 15-minute freshness threshold is enforced in the read function rather than by Redis itself. All other open questions resolved cleanly: OAuth scopes already include `calendar.events` so Phase 9 inherits the same consent; `responseStatus` filtering must respect `attendee.self` (events with no self-row are owner-created, keep them); all-day events keep `YYYY-MM-DD` strings rather than collapsing into UTC `Date` objects; thundering-herd protection is unnecessary at single-user volume. The new module `apps/web/utils/calendar/upcoming-events.ts` should call `client.events.list` directly (not layer on `GoogleCalendarEventProvider.fetchEvents`, which discards `responseStatus` and the all-day flag), filter, normalize, and cache with the envelope pattern. No dependencies to install, no migration, no env vars. Closest structural analog to copy is `apps/web/utils/redis/account-validation.ts`.
