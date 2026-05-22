---
phase: 08
status: clean
depth: standard
files_reviewed: 6
critical: 0
high: 0
medium: 4
low: 5
info: 5
generated: 2026-05-22
---

# Phase 8 — Calendar Sync Foundation: Code Review

**Files reviewed**

- `apps/web/utils/calendar/upcoming-events-types.ts`
- `apps/web/utils/calendar/upcoming-events-helpers.ts`
- `apps/web/utils/calendar/upcoming-events-helpers.test.ts`
- `apps/web/utils/calendar/upcoming-events.ts`
- `apps/web/utils/calendar/upcoming-events.test.ts`
- `apps/web/scripts/verify-calendar-scopes.mjs`

No CRITICAL or HIGH findings. Phase is ship-ready for the v1.1 personal-logistics use case; a small number of MEDIUM hygiene items are worth addressing before Phase 9 builds on this surface.

---

## apps/web/utils/calendar/upcoming-events-types.ts

### LOW — IN-01: Envelope shape has no schema version field
**File:** `upcoming-events-types.ts:51-55`
The cache envelope contains `data` + `fetchedAt` but no schema/version discriminator. The Redis key (`calendar:events:{emailAccountId}`) is also unversioned. If `NormalizedCalendarEvent` gains/renames a field in Phase 9 or later (e.g. a `timezone` field), existing 24-hour envelopes will deserialize with the old shape and silently feed half-formed data into downstream consumers until the hard TTL flushes them.
**Fix:** Either embed a `schemaVersion: 1` literal on the envelope and bail to live-fetch on mismatch, or bake a version suffix into the prefix (`calendar:events:v1:`). The prefix-version approach is cheaper because key changes invalidate atomically.

---

## apps/web/utils/calendar/upcoming-events-helpers.ts

### MEDIUM — WR-01: `normalize` can emit `null` typed as `string` for malformed events
**File:** `upcoming-events-helpers.ts:30-39`
`startDateTime` falls back to `null`; `isAllDay` is `false` unless `event.start?.date` is truthy. An event whose `start` object exists but has neither `dateTime` nor `date` (or whose `end` is similarly malformed) would yield `start = null as string`. The type contract advertises a non-null string. Downstream `pastPrune` would then call `new Date(null).getTime()` → `NaN`, and `NaN >= nowMs` is `false`, so the event silently disappears. The Google API in practice always populates one of the two, but a defensive guard avoids a hard-to-trace data-loss path.
**Fix:** Add an early guard, e.g.:
```ts
const startRaw = event.start?.dateTime ?? event.start?.date;
const endRaw = event.end?.dateTime ?? event.end?.date;
if (!startRaw || !endRaw) {
  // Skip: caller's filter should drop this id, not normalize it to nulls.
  throw new Error("Calendar event missing start/end");
}
```
…and have `getUpcomingEvents` filter out events lacking start/end before calling `normalize`. Alternatively widen the return type to allow undefined and document it.

### MEDIUM — WR-02: `pastPrune` all-day comparison uses UTC date, not user local date
**File:** `upcoming-events-helpers.ts:75, 77-78`
`todayString = now.toISOString().slice(0,10)` always renders the UTC date. For a user in America/New_York at 21:00 local (= next UTC day), an all-day event whose `end === today-local` will be silently dropped because the UTC date string has already rolled over. The current cron runs at 6-7am ET, so the digest path is unaffected, but Phase 9 reconciliation and any ad-hoc reads outside that window will hit this. The inline doc acknowledges the trade-off; flagging because it is a behavioral landmine for the next caller.
**Fix:** Either pass a `timezone` argument and compute the local date there (`Intl.DateTimeFormat(tz, {year, month, day})`), or document the caller's contract loudly on the exported function (not just in source comments).

### LOW — IN-02: Doc says "predicate is `end < now`", implementation uses `end >= now` to keep
**File:** `upcoming-events-helpers.ts:60-61, 78, 81`
The JSDoc reads "predicate is `end < now`" (drop predicate). The body's filter predicate keeps when `end >= now` (keep predicate). The two are mathematically equivalent so behavior is correct, but the wording invites a misread during future maintenance.
**Fix:** Reword to "keep events where `end >= now`; equivalently drop those where `end < now`. Boundary case `end === now` is kept."

---

## apps/web/utils/calendar/upcoming-events-helpers.test.ts

### INFO — IN-03: No test for malformed events missing both `dateTime` and `date`
**File:** `upcoming-events-helpers.test.ts:81-151`
The `normalize` suite covers timed/all-day/missing-summary/missing-location/missing-description/no-attendees but never asserts behavior when both `dateTime` and `date` are absent. Combined with WR-01, this is a coverage gap right where the most likely silent bug lives.
**Fix:** Add a test fixture `start: {}`, `end: {}` and assert the chosen contract (throw, or `start: null`).

### INFO — IN-04: `pastPrune` boundary test only exercises `end === now`, not `end === now - 1ms` / `+1ms`
**File:** `upcoming-events-helpers.test.ts:197-200`
The boundary test is good; adding a 1ms-before / 1ms-after pair would lock the boundary firmly.
**Fix:** Optional — add `endIso = new Date(now.getTime() - 1).toISOString()` (dropped) and `+1` (kept) cases.

---

## apps/web/utils/calendar/upcoming-events.ts

### MEDIUM — WR-03: `expiresAt` Prisma value coerced via unchecked `as number | null` cast
**File:** `upcoming-events.ts:79-82`
The branch handles `instanceof Date`, then falls through to `connection.expiresAt as number | null`. Prisma typically returns `Date | null` for `DateTime` columns and `number | bigint | null` for numeric columns; the cast is asserted but not validated. If the schema ever moves to BigInt (a common token-expiry storage choice), this silently passes a BigInt through to `getCalendarClientWithRefresh`'s `expiresAt: number | null` and arithmetic comparisons break or throw at the call site.
**Fix:** Narrow explicitly:
```ts
const raw = connection.expiresAt;
const expiresAtMs =
  raw instanceof Date ? raw.getTime() :
  typeof raw === "number" ? raw :
  typeof raw === "bigint" ? Number(raw) : null;
```

### MEDIUM — WR-04: No request coalescing / single-flight; thundering herd on cold cache scales linearly
**File:** `upcoming-events.ts:53-117`; **Test:** `upcoming-events.test.ts:475-500`
Test 18 asserts "at most 2 Google calls" for two concurrent invocations. That is true for N=2 because both miss cache and both call Google; the code has no in-flight dedupe. The 08-CONTEXT verification hook explicitly calls out "only one Calendar API call hits (or at worst two, not N)" — the implementation will issue N calls for N concurrent cold reads, and the test gives false comfort by only exercising N=2. For the personal-volume use case this is unlikely to bite (one user, one webhook firing at a time), but it's a real divergence from the stated intent.
**Fix:** Either (a) add an in-process inflight-promise map keyed by `emailAccountId` to dedupe parallel callers, or (b) loosen the verification hook language to "N concurrent → ≤ N calls" and add a comment acknowledging the design choice. If keeping current behavior, change the test assertion to `expect(listMock.mock.calls.length).toBe(2)` so future regressions toward dedupe stand out instead of being silently masked.

### LOW — IN-05: `err.message` from Google client included in `logger.warn`
**File:** `upcoming-events.ts:120-125`
The catch logs `err instanceof Error ? err.message : String(err)`. Google's googleapis client error messages occasionally include the URL of the failing request; the `events.list` URL does not contain a token, so this is a low-residual-risk path, but it does mean the operator log surface depends on Google's choice of error shape. The Test 17 SENSITIVE-LOG-MARKER guard validates that event titles/descriptions don't leak, but does NOT validate that a hypothetical token-bearing error message wouldn't.
**Fix:** Either explicitly strip likely-bearer strings before logging (`String(err.message).replace(/Bearer\s+\S+/g, "Bearer [redacted]")`) or extend Test 17 to mock a calendar client rejection where the error message contains a known token substring and assert redaction.

### LOW — IN-06: Empty catch on Redis read/write swallows root cause
**File:** `upcoming-events.ts:55-57, 113-115`
Both Redis try/catch blocks have empty bodies. The comments document intent ("fall through to live fetch") but a recurring Upstash outage would produce no observability at all. The downstream warn in the outer catch only fires if Google also fails.
**Fix:** Add a `logger.warn("Redis read/write failed", { emailAccountId, error: err.message })` inside each catch (still structured fields only, no event content).

### INFO — IN-07: Stale envelope returned from `getUpcomingEvents` is not refreshed in background
**File:** `upcoming-events.ts:118-127`
On Google-fetch failure with a stale envelope present, the code returns the stale data — correct per D-09. There is no background refresh attempt, and the stale envelope will keep being returned on every read until either (a) Google recovers and the next caller pays the latency, or (b) the 24h hard TTL expires. Acceptable per plan, noting for Phase 9 awareness.
**Fix:** No action; documented design.

---

## apps/web/utils/calendar/upcoming-events.test.ts

### LOW — IN-08: Test 18 "thundering herd" test asserts `<= 2` and so cannot regress
**File:** `upcoming-events.test.ts:499`
See WR-04. The assertion can never fail unless dedupe is added, at which point it would also pass. Effectively a no-op test.
**Fix:** Pair with WR-04 — either tighten to `.toBe(2)` or rewrite once dedupe is added.

### INFO — IN-09: Mock `Logger` cast through `unknown` swallows future Logger surface changes
**File:** `upcoming-events.test.ts:39-47`
`as unknown as Logger` will keep compiling even if Logger gains required methods (`fatal`, `child`, etc.). Low risk; standard test-fixture pattern.
**Fix:** Optional — use a typed helper from a shared test-utils file.

---

## apps/web/scripts/verify-calendar-scopes.mjs

### MEDIUM — WR-05: Inline AES-GCM decrypt diverges from canonical `encryption.ts` in error semantics
**File:** `scripts/verify-calendar-scopes.mjs:41-54` vs `apps/web/utils/encryption.ts:69-110`
The inline implementation differs from `encryption.ts` in three ways:
1. Unknown version digits (`v2:`, `v3:`, ...) are silently accepted and decrypted with the v1-derived key. The canonical implementation throws `Unknown encryption version`.
2. A versioned payload that is too short returns the original (still-encrypted) `value` string. The canonical implementation throws `Ciphertext too short`.
3. The legacy plaintext-passthrough path in the canonical implementation logs a warn on failed decrypt; the inline path silently returns `value`.
For the present operator use case (v1 only, verdict already captured `OK`) the divergence is invisible. After a hypothetical key rotation (v1 → v2), this script would silently produce garbage "decrypted" output and likely emit `FAIL — token refresh failed` — at best confusing, at worst leaking the wrong-decryption gibberish to console if any future caller prints it.
**Fix:** Either (a) add a top-of-file comment locking the script to v1 explicitly and erroring out on `v\d+:` where `\d != 1`, or (b) when the project gains a v2 key, port the canonical version-dispatch table into the script. A `// SECURITY: keep in sync with apps/web/utils/encryption.ts` comment is the minimum.

### LOW — IN-10: Refresh response body logged verbatim on failure
**File:** `scripts/verify-calendar-scopes.mjs:96, 108`
`console.log(\`Refresh failed: ${r.status} ${r.body.slice(0, 300)}\`)` and the equivalent tokeninfo line print up to 300 chars of an upstream response body. Google's documented error shape for the token endpoint is `{"error":"invalid_grant","error_description":"..."}` and does not echo the refresh token, but the contract is Google's, not ours. If a future Google API change starts echoing request parameters, the refresh token (passed in the POST body) could leak to the operator's terminal — which in production gets captured by SSM session logs.
**Fix:** Whitelist the fields you log: `JSON.parse(body).error` and `.error_description`, falling back to status only. Same on the tokeninfo path.

### LOW — IN-11: `JSON.parse(r.body).access_token` has no validation
**File:** `scripts/verify-calendar-scopes.mjs:103`
If Google ever returns 2xx with non-JSON or JSON missing `access_token`, this throws with an unhandled rejection. The script ends with non-zero exit but no `CALENDAR_SCOPE_VERDICT:` line, which is the contract the operator runbook expects.
**Fix:** Wrap in try/catch, emit `CALENDAR_SCOPE_VERDICT: FAIL — refresh response malformed` and `process.exit(2)`.

### INFO — IN-12: Access token passed in URL query string to tokeninfo endpoint
**File:** `scripts/verify-calendar-scopes.mjs:56-62`
Per Google's tokeninfo API contract; matches their documented usage. Standard tradeoff — query strings show up in access logs on the Google side, but this is Google's logs, not ours.
**Fix:** No action.

### INFO — IN-13: No `process.on("unhandledRejection")` handler
**File:** `scripts/verify-calendar-scopes.mjs` (top-level)
A throw anywhere in the async chain will cause a Node default-handler dump that may include partial state. Currently low risk because most paths are explicitly try/catched, but `JSON.parse` (IN-11) and any future addition can leak via this default.
**Fix:** Add at top:
```js
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err?.message ?? String(err));
  process.exit(2);
});
```

---

## Summary

**Verdict: ship as-is for Phase 8.**

The phase is plumbing only, single-tenant, and the verdict-bearing script has already been executed against production with the verified `OK` outcome. None of the findings are correctness-or-security blockers for the present scope.

**Recommended for follow-up before Phase 9 consumers come online:**

- **WR-01 (`normalize` null-as-string)** — Phase 9 reconciliation will iterate over `start`/`end` heavily; a malformed event silently becoming NaN-typed will be much harder to root-cause once the AI extraction surface is layered on.
- **WR-03 (`expiresAt` cast)** — cheap to harden now, painful to debug later.
- **WR-04 (no in-flight dedupe + misleading test)** — at minimum tighten the test assertion so a future regression to dedupe stands out.
- **IN-01 (envelope schema version)** — add the `v1:` prefix now while the cache is empty in prod; almost free.

**Recommended for follow-up before any future key rotation:**

- **WR-05 (inline crypto divergence)** — add a sync comment to the operator script.

Nothing in this list blocks merging Phase 8. The phase's stated boundary (D-01..D-12) is honored: single read path, primary calendar only, declined/tentative excluded, 15-min soft / 24h hard TTL, stale-fallback on error, no retries, no token logging hooks, time-based invalidation only.

---

_Reviewed: 2026-05-22_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
