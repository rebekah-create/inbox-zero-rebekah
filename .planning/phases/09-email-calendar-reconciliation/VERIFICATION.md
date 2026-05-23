---
phase: 09-email-calendar-reconciliation
verified: 2026-05-23T00:00:00Z
status: human_needed
score: 12/13 must-haves verified (1 partial pending live Haiku run)
verdict: COMPLETE (pending operator-run RUN_AI_TESTS eval + production deploy verification)
---

# Phase 09: Email ↔ Calendar Reconciliation — Verification

**Phase Goal:** When an email references a date/time, extract the candidate event and reconcile against the cached calendar. Result lands in `MATCHED` / `CREATED` / `AMBIGUOUS`. Strictly create-or-match — never modifies existing events.

**Verdict:** **COMPLETE** — all required code paths, schema, fixtures, and tests are present and wired. The one item that cannot be verified statically (real Haiku token cost ≤ $1/mo) has a runnable, asserting test (`cost-projection.test.ts`); operator must run `RUN_AI_TESTS=true` to confirm at first deploy.

---

## Requirements Coverage

| REQ-ID | Status | Evidence |
|--------|--------|----------|
| **REC-01** Pre-filter gates LLM | SATISFIED | `index.ts:39-66` keyword backstop + `extractFromIcs` (deterministic, no LLM); `index.ts:118-132` early-return when neither Path A (.ics) nor Path B (CALENDAR-classified OR keyword) applies. |
| **REC-02** AI extraction → title/start/end/location/people | SATISFIED | `extract.ts` Zod schema includes `title`, `startISO`, `endISO`, `location`, `attendees`, `confidence`, `isAllDay`; goes through Haiku (`getModel(user, "economy")`) with cached system prompt + `promptHardening: untrusted/full`. |
| **REC-03** Three buckets MATCHED/CREATED/AMBIGUOUS | SATISFIED | `match.ts:27-81` `decideOutcome` D-06 decision tree; all-day branch + 4-step time-window logic; `index.ts:247-298` routes outcomes. |
| **REC-04** Persisted reconciliation linked to source email + event ID | SATISFIED | `ReconciliationRecord` Prisma model (`schema.prisma:898-927`) with `messageId`, `threadId`, `googleEventId`, `googleEventHtmlLink`; migration `20260523154812_add_reconciliation_record` present. |
| **REC-05** Idempotency by messageId + signature | SATISFIED | `@@unique([emailAccountId, messageId, eventSignature])`; `persist.ts:53-81` P2002 catch via `isDuplicateError`; `index.ts:138-160` early-return on existing non-stale row; stale-PENDING recovery reuses row id (D-16). |
| **REC-06** Create-or-match only, never modifies | SATISFIED | `create-event.ts` only calls `events.insert` — no `.update`/`.patch`/`.delete`; `match.ts:61-67` returns AMBIGUOUS for strong-sim time-mismatch (reschedule case) without modifying the matched event. |
| **EVT-01** `.ics` recognized by pre-filter, same flow | SATISFIED | `ics-path.ts:24-56` uses existing `hasIcsAttachment` + `analyzeCalendarEvent`; produces same `CandidateEvent` shape as Haiku Path B; orchestrator branches to same downstream code. |
| **EVT-02** Plain-text via AI extraction (no separate path) | SATISFIED | Path B (`extractCandidateEvent`) is the sole non-ics path; `index.ts:192-200` falls through. |
| **EVT-03** Source-email back-ref in description | SATISFIED | `create-event.ts:41-54` `buildBackRefDescription` writes Gmail thread URL + sender + Message-ID into `description`. |
| **EVT-04** `[AI]` tag on created events | SATISFIED | `create-event.ts:130` `summary: \`[AI] ${candidate.title}\``. |
| **EVT-05** Creation failures don't block classification/digest | SATISFIED | `create-event.ts:152-159` try/catch → `{ ok: false, reason: "api-error" }`; orchestrator (`index.ts:293-298`) writes FAILED outcome without rethrowing; wired via `after()` (`process-history-item.ts:256-274`) so it cannot affect synchronous classification. |
| **OPS-01** Calendar API failures degrade gracefully | SATISFIED | `index.ts:242-246` `getUpcomingEvents(...).catch(() => [])` — match falls to CREATED if calendar fetch fails; outer try/catch (`index.ts:299-327`) explicitly DO NOT rethrow comment; webhook integration also has `.catch()` (`process-history-item.ts:265-270`). |
| **OPS-02** Token cost measured ≤ $10/mo additional | **PARTIAL** | `cost-projection.test.ts` exists with real `saveAiUsage` spy + Haiku 4.5 pricing constants (2026-05-22 snapshot); asserts ≤ $1/mo at 90 and 200 calls/mo. The test is RUN_AI_TESTS-gated and has not been executed because (a) local run is forbidden on user's Windows machine, (b) test costs real Anthropic dollars. The assertion exists and will fail loud at first operator run — but empirical confirmation is still pending. |

**12/13 SATISFIED, 1 PARTIAL** — the partial (OPS-02) is gated on a deliberate operator-side action, not a code gap.

---

## Observable Truths (Phase Success Criteria)

| # | Truth | Status | Evidence |
|---|------|--------|----------|
| 1 | Cheap pre-filter gates LLM | VERIFIED | See REC-01. |
| 2 | Extraction from both .ics and plain text | VERIFIED | See EVT-01 + EVT-02. |
| 3 | Every outcome persists as a reconciliation record | VERIFIED | `persist.ts` + `index.ts:215-238`; PENDING row written before match. |
| 4 | MATCHED never creates; CREATED writes `[AI]` + link; AMBIGUOUS writes no event | VERIFIED | `index.ts:257-298` — only CREATED branch calls `createCalendarEvent`. |
| 5 | Reprocessing is idempotent | VERIFIED | See REC-05. |
| 6 | Failures log + don't block | VERIFIED | See OPS-01, EVT-05. |
| 7 | Token cost projects ≤ $10/mo | PARTIAL | See OPS-02 — assertion exists, run pending. |

---

## Artifact Verification (Levels 1–3)

| Artifact | Exists | Substantive | Wired | Status |
|----------|--------|-------------|-------|--------|
| `apps/web/utils/calendar/reconciliation/index.ts` | yes (329 lines) | yes | imported by `process-history-item.ts:14` | VERIFIED |
| `extract.ts` + `extract-prompt.ts` | yes | yes | imported by index.ts + cost-projection test | VERIFIED |
| `ics-path.ts` | yes | yes | imported by index.ts | VERIFIED |
| `match.ts` + `dice.ts` + `signature.ts` | yes | yes | imported by index.ts | VERIFIED |
| `persist.ts` | yes | yes | imported by index.ts | VERIFIED |
| `create-event.ts` | yes | yes (uses `events.insert` directly per CONTEXT) | imported by index.ts | VERIFIED |
| Prisma `ReconciliationRecord` model | yes (schema.prisma:898) | yes (all required cols + unique + indexes) | migration `20260523154812_add_reconciliation_record` present | VERIFIED |
| Fixture corpus | yes (`__tests__/fixtures/reconciliation/{labeled,adversarial,no-event}`) | 5 labeled + 3 adversarial + 2 no-event = 10 | consumed by both AI test files | VERIFIED |
| `extract.ai.test.ts` | yes | yes (3 describe blocks: labeled / adversarial / no-event) | RUN_AI_TESTS gated | VERIFIED |
| `cost-projection.test.ts` | yes | yes (real saveAiUsage spy + projection assertion) | RUN_AI_TESTS gated | VERIFIED |

---

## Key Link Verification (Wiring)

| From | To | Via | Status |
|------|----|----|--------|
| `process-history-item.ts` | `reconcileMessage` | `after(() => runWithBackgroundLoggerFlush(...))` block at line 256 | WIRED |
| Orchestrator | Haiku extraction | `extractCandidateEvent` via `createGenerateObject` (OPS-02 telemetry path) | WIRED |
| Orchestrator | Google Calendar | `client.events.insert` via `getCalendarClientWithRefresh` | WIRED |
| Orchestrator | Phase 8 calendar cache | `getUpcomingEvents({ emailAccountId, now, logger })` | WIRED |
| Orchestrator | Persistence | `createReconciliationRecord` / `findStalePendingRecord` / `updateReconciliationRecord` | WIRED |
| Failure isolation | webhook handler | outer try/catch + `.catch()` on `after()` callback | WIRED |

---

## Anti-Pattern Scan

- No TBD/FIXME/XXX markers found in shipped reconciliation code.
- One `TODO` in `ics-path.ts:22` — documented architectural follow-up (expose `VALUE=DATE` from underlying parser to remove all-day inference heuristic). **Not blocking** — heuristic is documented + tested.
- `console.log` in `cost-projection.test.ts:152` — explicitly `// biome-ignore lint/suspicious/noConsole` because the diagnostic JSON is captured by exec summary tooling. Intentional.
- No empty handlers, no stub returns, no `return null/return []` in production paths.

---

## Known Deviations (acknowledged in summaries, not gaps)

1. **SENT-path divergence (09-07)** — Plan 09-07 Test 3 originally suggested reconcile fires on SENT messages; live code returns early for outbound mail (`process-history-item.ts:148-149`), so reconcile is never registered for SENT. Test was reframed as positive assertion `reconcileMessage NOT called for SENT`. Documented in `09-07-SUMMARY.md` §Deviations. **Verdict: acceptable** — outbound mail doesn't need reconciliation (user already created the event when they scheduled the outgoing message), and the SENT-path early-return predates this phase.

2. **Inline executor work for 09-07 Tasks 2-3** — subagent runtime couldn't resume after human-verify checkpoint; orchestrator completed inline. Code is identical to what an executor would have produced; grep gates all pass.

3. **09-08 fixtures built inline by orchestrator** — executor couldn't reach Gmail MCP. 10 fixtures present and correctly shaped (each labeled fixture has `id`/`input`/`expected` blocks; adversarial fixtures have `titleMustNotContain`).

4. **No local `pnpm test`/`tsc` run** — forbidden on user's Windows machine per CLAUDE.md. CI on push to main will catch any type/lint regression. All static grep gates documented in plan summaries passed.

---

## Human Verification Required

The following cannot be verified statically and require operator action before phase close:

### 1. Run `RUN_AI_TESTS=true pnpm test-ai -- utils/calendar/reconciliation` from a machine that isn't this Windows host

- **Test:** `cd apps/web && RUN_AI_TESTS=true pnpm test-ai -- utils/calendar/reconciliation`
- **Expected:** All 5 labeled fixtures pass field assertions; all 3 adversarial fixtures keep `confidence ≤ 0.2` AND don't echo banned strings (T-09-01); all 2 no-event fixtures keep `confidence ≤ 0.3`; cost-projection diagnostic prints `projectedMonthlyAtPessimisticVolume ≤ $1.00`. Total Anthropic spend ~$0.05.
- **Why human:** Live Anthropic call; costs real money; can't run locally on Windows; needs a real `ANTHROPIC_API_KEY`.

### 2. Verify production deploy reconciles a real inbound email end-to-end

- **Test:** After deploy to inbox.tdfurn.com, send a test appointment email; check Postgres `ReconciliationRecord` table for the row (`outcome`, `googleEventId`); check Google Calendar for the `[AI]`-prefixed event with Gmail back-ref in description.
- **Expected:** One row per inbound calendar-bearing email; `[AI] <title>` event on calendar; description contains `https://mail.google.com/mail/u/0/#inbox/<threadId>`.
- **Why human:** Requires real Google OAuth grant, real Gmail webhook, real calendar — none of which exist in CI.

### 3. Verify production cost telemetry after 1 week

- **Test:** Query `AiUsage` table (or Tinybird) for rows with `label = "Reconciliation extract"` after 7 days of production traffic; project monthly cost from observed volume.
- **Expected:** Total reconciliation spend trending ≤ $1/mo (OPS-02 budget).
- **Why human:** Needs real production traffic + telemetry inspection.

---

## Open Follow-Ups (Backlog Candidates)

1. `ics-path.ts` TODO: extend `analyzeCalendarEvent` to expose `VALUE=DATE` DTSTART type so the midnight-UTC heuristic can be removed.
2. `analyzeCalendarEvent` does not surface `LOCATION` or `ATTENDEE` lines for .ics path — currently `location: null`, `attendees: []` for Path A. Acceptable for v1.1 (user's .ics usage is sparse — mostly invites from automated systems where the title carries the location).
3. Phase 10 (digest agenda) consumes `ReconciliationRecord` — depends on this phase shipping cleanly.

---

## Score & Verdict

- **12/13 must-haves SATISFIED**, 1 PARTIAL (OPS-02 — code present, real-token run pending operator).
- **All 9 plans complete**, all summaries present, no stubs, no unresolved blockers.
- **Phase goal achieved** at the code level; observability of cost + production correctness needs the three human checks above.

**Status: human_needed** — phase is code-complete; awaiting operator-side eval run + production smoke test.

---

_Verified: 2026-05-23_
_Verifier: Claude (gsd-verifier), goal-backward methodology_
