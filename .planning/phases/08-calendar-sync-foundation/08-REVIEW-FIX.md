---
phase: 08
status: fixed
fixes_applied: 5
fixes_deferred: 8
generated: 2026-05-22
---

# Phase 8 — Code Review Fix Report

**Source review:** `.planning/phases/08-calendar-sync-foundation/08-REVIEW.md`
**Iteration:** 1 (fixes pre-landed prior to this orchestration run)

## Summary

All 5 MEDIUM findings called out in REVIEW.md were already addressed in prior commits on `main` before this orchestration kicked off. Verification against the current source confirms each fix is present and matches the reviewer's suggested approach. No new commits were created in this run — the work was already done.

The REVIEW.md frontmatter itself declares `status: clean` and the summary explicitly verdicts "ship as-is for Phase 8", consistent with the MEDIUM follow-ups already being applied.

- Findings in scope (MEDIUM, plus IN-02/IN-03/IN-04 which sit on top of WR-01/WR-02): 5 MEDIUM
- Fixed (already present in source): 5
- Deferred (LOW/INFO not adjacent to MEDIUM fixes): 8

## Fixed Issues

### WR-01: `normalize` null-as-string in `upcoming-events-helpers.ts`

**Files modified:** `apps/web/utils/calendar/upcoming-events-helpers.ts`, `apps/web/utils/calendar/upcoming-events.ts`, `apps/web/utils/calendar/upcoming-events-helpers.test.ts`
**Commit:** `3c56ebe21 fix(08): WR-01 guard normalize against malformed calendar events`
**Applied fix:** Added `hasStartAndEnd(event)` predicate. `normalize` now throws `"Calendar event missing start or end"` instead of casting `null` to `string`. `getUpcomingEvents` filters with `hasStartAndEnd(event) && !isExcluded(event)` before mapping. Tests cover both throw paths (`start: {}, end: {}` and `start: dateTime, end: {}`). Also closes IN-03 (test coverage gap).

### WR-02: `pastPrune` all-day UTC vs local-date

**Files modified:** `apps/web/utils/calendar/upcoming-events-helpers.ts`, `apps/web/utils/calendar/upcoming-events-helpers.test.ts`
**Commit:** `d5646d9da fix(08): WR-02 add optional timezone arg + loud contract for pastPrune all-day`
**Applied fix:** Added optional `todayLocalDate?: string` arg to `pastPrune`. When omitted, falls back to UTC slice with a loudly documented CALLER CONTRACT block in JSDoc explaining the trade-off (safe for the 6-7am ET digest, must be passed by Phase 9). Test asserts both branches. Also closes IN-02 (JSDoc wording corrected to "keep events where `end >= now`") and IN-04 (±1ms boundary tests added).

### WR-03: `expiresAt` unchecked cast

**Files modified:** `apps/web/utils/calendar/upcoming-events.ts`
**Commit:** `b92f33e24 fix(08): WR-03 narrow expiresAt type explicitly instead of unchecked cast`
**Applied fix:** Replaced `connection.expiresAt as number | null` with explicit narrowing chain: `instanceof Date → getTime()`, `typeof === "number"` passthrough, `typeof === "bigint" → Number()`, else `null`. Includes inline comment referencing the BigInt schema-migration footgun.

### WR-04: Test 18 non-falsifying assertion

**Files modified:** `apps/web/utils/calendar/upcoming-events.test.ts`
**Commit:** `a31f4bf97 fix(08): WR-04 make Test 18 thundering-herd assertion honest`
**Applied fix:** Per the "honest rewrite" path (single-flight dedupe deliberately out of scope for v1.1 personal-volume use), assertion is now `expect(listMock.mock.calls.length).toBe(2)`. The test docblock explicitly states the design choice and instructs future maintainers to flip to `.toBe(1)` if dedupe is added. Closes IN-08.

### WR-05: `verify-calendar-scopes.mjs` crypto divergence

**Files modified:** `apps/web/scripts/verify-calendar-scopes.mjs`
**Commit:** `9a618079d fix(08): WR-05 align verify-calendar-scopes.mjs crypto with canonical impl`
**Applied fix:** Added the `// SECURITY: keep in sync with apps/web/utils/encryption.ts` comment at the top of the decrypt function. All three behavioral divergences fixed: (1) unknown `v{N}:` versions throw `Unknown encryption version: v${version}` instead of silently decrypting with v1 key, (2) short versioned payload throws `Ciphertext too short` instead of returning the still-encrypted input, (3) legacy unversioned decrypt failure emits a `console.warn` before treating as plaintext.

## Deferred Issues

These were either explicitly out of scope per the objective (LOW/INFO with no MEDIUM adjacency) or marked "no action" by the reviewer.

### IN-01: Cache envelope schema version field

**File:** `apps/web/utils/calendar/upcoming-events-types.ts:51-55`
**Reason:** LOW, not adjacent to a MEDIUM fix. Reviewer noted as cheap to add "while the cache is empty in prod" but did not class it as a blocker. Cache key currently unversioned; carries forward to Phase 9 plan if cache shape changes.

### IN-05: `err.message` from Google client included in logger.warn

**File:** `apps/web/utils/calendar/upcoming-events.ts:120-125`
**Reason:** LOW, low residual risk. Reviewer noted `events.list` URL doesn't carry tokens; the SENSITIVE-LOG-MARKER guard already exists for event content. Bearer-token redaction can be added as part of Phase 9 token instrumentation (REC-02) where logging surface gets a broader pass.

### IN-06: Empty catch on Redis read/write

**File:** `apps/web/utils/calendar/upcoming-events.ts:55-57, 113-115`
**Reason:** LOW. Reviewer's suggestion (`logger.warn("Redis read/write failed", ...)`) is reasonable but deferred to keep diff focused on MEDIUMs. Worth pairing with IN-01 in a single Phase 9 follow-up commit.

### IN-07: Stale envelope not refreshed in background

**File:** `apps/web/utils/calendar/upcoming-events.ts:118-127`
**Reason:** INFO, marked "no action; documented design" by reviewer.

### IN-09: Mock Logger cast through `unknown`

**File:** `apps/web/utils/calendar/upcoming-events.test.ts:39-47`
**Reason:** INFO, standard test-fixture pattern, marked "optional" by reviewer.

### IN-10: Refresh response body logged verbatim on failure

**File:** `apps/web/scripts/verify-calendar-scopes.mjs:96, 108`
**Reason:** LOW, not adjacent to a MEDIUM fix. Operator script runs ad-hoc against production via SSM; the captured log surface is operator-only. Worth tightening before any wider operational rollout but not blocking for v1.1.

### IN-11: `JSON.parse(r.body).access_token` not validated

**File:** `apps/web/scripts/verify-calendar-scopes.mjs:103`
**Reason:** LOW. Operator script is one-shot, the failure mode (unhandled rejection → non-zero exit but no VERDICT line) is observable. Reviewer's wrap-in-try suggestion is sound but deferred.

### IN-12 / IN-13: Token in URL query / no `unhandledRejection` handler

**File:** `apps/web/scripts/verify-calendar-scopes.mjs`
**Reason:** IN-12 marked "no action" by reviewer (Google API contract). IN-13 is INFO-level pairing with IN-11; deferred together.

## Test Verification

`pnpm test` was attempted via `apps/web` but `cross-env` / `vitest` are not resolvable (node_modules not installed in `apps/web` on this machine; per CLAUDE.md, full installs are not run locally). The 5 fix commits each landed on `main` at the time of their original implementation; the corresponding test changes (WR-01 throw paths, WR-02 todayLocalDate test, WR-04 `.toBe(2)`) are present in the test files and were green when those commits originally landed. CI on push will be the canonical pass.

---

_Fixed: 2026-05-22_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1 (no new commits; all MEDIUM fixes were already present on `main`)_
