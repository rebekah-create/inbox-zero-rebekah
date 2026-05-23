---
phase: 09-email-calendar-reconciliation
plan: 06
subsystem: calendar/reconciliation
tags: [orchestrator, after-block, idempotency, failure-isolation, d-12]
requires:
  - apps/web/utils/calendar/reconciliation/ics-path.ts (extractFromIcs — 09-03)
  - apps/web/utils/calendar/reconciliation/extract.ts (extractCandidateEvent, CandidateEvent — 09-03)
  - apps/web/utils/calendar/reconciliation/match.ts (decideOutcome — 09-02)
  - apps/web/utils/calendar/reconciliation/signature.ts (eventSignature — 09-02)
  - apps/web/utils/calendar/reconciliation/persist.ts (4 helpers — 09-04)
  - apps/web/utils/calendar/reconciliation/create-event.ts (createCalendarEvent — 09-05)
  - apps/web/utils/calendar/upcoming-events.ts (getUpcomingEvents — Phase 8)
  - apps/web/utils/mail.ts (convertEmailHtmlToText)
provides:
  - reconcileMessage (D-12 orchestrator entry point — used from after() in 09-07)
  - matchesKeywordBackstop (exported D-02 pre-filter helper)
affects:
  - downstream Phase 9 webhook integration (plan 09-07 mounts reconcileMessage inside the after() fan-out)
tech-stack:
  added: []
  patterns:
    - "D-12 sequence: pre-filter → idempotency fast-path → stale-PENDING recovery → extract → signature/persist → match → outcome update → CREATED-only Google call"
    - "Outer-try/catch failure isolation (OPS-01, EVT-05) — orchestrator never rethrows"
    - "T-09-04 cost-recovery: stale-PENDING rehydrates candidate from persisted columns so Haiku is not double-charged on retry"
    - "T-09-05 logger discipline: structured ids only on warn/error; never extractedTitle/Location/Attendees/raw body/subject"
key-files:
  created:
    - apps/web/utils/calendar/reconciliation/index.ts
    - apps/web/utils/calendar/reconciliation/index.test.ts
  modified: []
decisions:
  - "Stale-PENDING recovery (D-16) implemented as UPDATE-IN-PLACE — reuse existing row id, skip createReconciliationRecord, skip Haiku. Picks the simpler of the two options in the plan's <interfaces> block."
  - "isAllDay sourced DIRECTLY from candidate.isAllDay (LLM-produced via schema for Path B, ics-adapter-derived for Path A). No midnight-shape heuristic in the orchestrator."
  - "convertEmailHtmlToText invoked with the object form `{ htmlText }` (matches mail.ts:105 signature; plan sketch used a positional string call)."
  - "Subject sourced from `headers?.subject ?? parsedMessage.subject` (both populate to the same value in ParsedMessage but headers is the canonical home)."
  - "Path A bodyTruncated left as empty string (extract is bypassed; the field is only consumed by extractCandidateEvent which is not called)."
metrics:
  test_cases: 22
  duration_minutes: ~15
  files_created: 2
  files_modified: 0
  completed: 2026-05-23
requirements: [REC-01, REC-02, REC-03, REC-05, REC-06, EVT-05, OPS-01]
---

# Phase 09 Plan 06: reconcileMessage Orchestrator Summary

D-12 sequence wired end-to-end: pre-filter → idempotency → stale recovery → extract → persist → match → outcome update → CREATED-only Google insert, with an outer try/catch that guarantees no exception escapes. 22 vitest cases pass across one source file + one test file.

## Function signature

```ts
export async function reconcileMessage({
  parsedMessage: ParsedMessage;
  emailAccount: EmailAccountWithAI;
  emailAccountId: string;
  logger: Logger;
}): Promise<void>;

export function matchesKeywordBackstop({
  subject: string;
  body: string;
}): boolean;
```

The single public entry point (`reconcileMessage`) returns `void` — all outcomes (skip, match, create, fail, idempotency no-op) are persisted to `ReconciliationRecord` or simply observed in logs; callers never branch on a return value. The keyword helper is exported only for direct unit-testing and reuse.

## D-12 sequence as implemented

```
0. compute messageId, threadId, senderEmail (headers.from), subject (headers.subject ?? subject)

try {
  1. extractFromIcs(parsedMessage) → CandidateEvent | null     [Path A]
     if null:
       isCalendar  = await isClassifiedAsCalendar({emailAccountId, messageId})  [D-09 ExecutedRule lookup]
       bodyTrunc   = truncateBody(parsedMessage)                                [D-05 slice 0,2000]
       pathB       = isCalendar || matchesKeywordBackstop(subject, body)        [D-02 keyword fallback]
       if !pathB → return                                                       [Path C skip]

  2. existing = await findExistingReconciliationRecord(...)                     [D-14 fast-path]
     if existing:
       stale = await findStalePendingRecord(...)                                [D-16 sweep]
       if !stale → info-log idempotency hit; return
       existingRowForReuse = { id: stale.id }                                   [update-in-place]

  3. if existingRowForReuse:
       rehydrate candidate from prisma.reconciliationRecord.findUnique          [T-09-04 cost-recovery]
       (no Haiku call; isAllDay from extractedIsAllDay column)
     else:
       candidate = pathA ? icsCandidate : await extractCandidateEvent(...)

  4. sig = eventSignature(candidate.title, candidate.startISO)

  5. if existingRowForReuse:
       recordId = existingRowForReuse.id                                        [skip create]
     else:
       created = await createReconciliationRecord({ input, logger })
       if !created.created → return                                             [P2002 no-op]
       recordId = created.record.id

  6. upcoming = await getUpcomingEvents(...).catch(() => [])                    [D-21 stale-fallback exhaust]
     { outcome, matchedEventId } = decideOutcome({ candidate, existingEvents })

  7. if outcome !== "CREATED":
       updateReconciliationRecord({ id: recordId, data: { outcome, googleEventId: matchedEventId } })
       return                                                                   [MATCHED + AMBIGUOUS path]

  8. inserted = await createCalendarEvent({ input, logger })
     if inserted.ok:
       update { outcome: "CREATED", googleEventId, googleEventHtmlLink }
     else:
       update { outcome: "FAILED", errorMessage: inserted.reason }              [OPS-01]
} catch (error) {
  logger.error(...);
  best-effort: findExisting → updateReconciliationRecord({ outcome: "FAILED", errorMessage: truncated })
  DO NOT rethrow.                                                               [EVT-05]
}
```

## Stale-PENDING recovery — decision recap

**Choice: update-in-place.** When `findExistingReconciliationRecord` returns a row and `findStalePendingRecord` returns the same row, we reuse its `id`, skip the `createReconciliationRecord` call entirely, and rehydrate the candidate fields from the row's persisted columns (`extractedTitle`, `extractedStart`, `extractedEnd`, `extractedLocation`, `extractedAttendees`, `candidateConfidence`, `extractedIsAllDay`). This is the simplest implementation of the plan's D-16 options:

| Option | Tradeoff | Picked |
|--------|----------|--------|
| Delete-and-retry | Extra DB roundtrip; Haiku re-charged. | No |
| Re-run + let P2002 catch absorb the second create | Noisy log line on every recovery. | No |
| Update-in-place + rehydrate from row | One DB read (`findUnique`) instead of an LLM call. | **Yes** |

The crucial gain: Test P confirms `extractCandidateEvent` is **never** called on stale-PENDING recovery — the worker-crash retry pays zero LLM tokens. Test P-AllDay confirms `extractedIsAllDay` is read directly from the column (no heuristic), so the all-day flag survives a crash unchanged.

## Tests — 22 cases, all green

| # | Suite | Name | Status |
|---|-------|------|--------|
| 1–5 | matchesKeywordBackstop | subject/body match, case-insensitive, all 12 D-02 keywords | ✅ |
| A | reconcileMessage | Path A bypass — .ics returns candidate; Haiku never called | ✅ |
| B | reconcileMessage | Path B via CALENDAR ExecutedRule match | ✅ |
| C | reconcileMessage | Path B via keyword backstop | ✅ |
| D | reconcileMessage | Path C skip — no .ics / ExecutedRule / keyword | ✅ |
| E | reconcileMessage | Idempotency fast-path — non-PENDING row → no-op | ✅ |
| F | reconcileMessage | Stale-PENDING recovery — update-in-place | ✅ |
| G | reconcileMessage | P2002 idempotency catch — created:false → no-op | ✅ |
| H | reconcileMessage | MATCHED outcome → googleEventId persisted, no Google call | ✅ |
| I | reconcileMessage | CREATED outcome → createCalendarEvent invoked, link persisted | ✅ |
| J | reconcileMessage | AMBIGUOUS (REC-06) → update + no create-event | ✅ |
| K | reconcileMessage | Google API failure → FAILED outcome, no rethrow (OPS-01) | ✅ |
| L | reconcileMessage | extractCandidateEvent throws → caught, FAILED update, no rethrow | ✅ |
| M | reconcileMessage | getUpcomingEvents empty → default CREATED path | ✅ |
| N | reconcileMessage | PII discipline — no extractedTitle/Location/Attendees/body in logs | ✅ |
| O | reconcileMessage | Body truncated to first 2000 chars (D-05) | ✅ |
| P | reconcileMessage | Stale-PENDING reuse skips Haiku (T-09-04) | ✅ |
| P-AllDay | reconcileMessage | Stale-PENDING reuse honours persisted extractedIsAllDay=true | ✅ |

```
Test Files  1 passed (1)
Tests       22 passed (22)
Duration    ~487ms
```

## Failure-isolation verification

| Gate | Result |
|------|--------|
| `grep -E 'throw error\|throw new Error' index.ts` | **0** lines (no rethrow) |
| `grep -c 'try {' index.ts` | 2 (outer body + best-effort FAILED update) |
| `grep -ci 'do not rethrow' index.ts` | 3 (header doc + outer catch + inner comment) |
| `grep -c 'matchesKeywordBackstop' index.ts` | 2 (definition + call) |
| `grep -c 'isClassifiedAsCalendar' index.ts` | 2 (definition + call) |
| `grep -c 'slice(0, 2000)' index.ts` | 1 (D-05 truncation) |

Tests K, L, M each invoke a failure path (`createCalendarEvent` returns `ok:false` / `extractCandidateEvent` throws / `getUpcomingEvents` empty) and assert `await expect(reconcileMessage(...)).resolves.toBeUndefined()` — i.e. no thrown exception escapes the orchestrator. The grep gate above closes the loop at the static-analysis layer.

## Logger discipline (T-09-05)

Test N captures every `logger.error` and `logger.warn` call across the failure-path scenarios and asserts the payload object NEVER contains `extractedTitle`, `extractedLocation`, `extractedAttendees`, `textPlain`, `textHtml`, or `subject`. The orchestrator's three log sites only emit `{ emailAccountId, messageId, outcome?, error? }`:

```ts
logger.info("Reconciliation already processed (idempotency hit)", {
  emailAccountId, messageId, outcome: existing.outcome,
});
logger.error("Reconciliation failed", { emailAccountId, messageId, error });
```

(`createCalendarEvent` and `createReconciliationRecord` each manage their own internal logging — both are already PII-safe per 09-04 / 09-05 SUMMARYs.)

## Deviations from PLAN / PATTERNS

### Auto-fixed Issues

**1. [Rule 1 — Adapter shape] `convertEmailHtmlToText` is called with `{ htmlText }`, not a positional string**

- **Found during:** Task 2 implementation.
- **Issue:** The plan's `<action>` sketch read `convertEmailHtmlToText(parsedMessage.textHtml ?? "")`. The actual function signature in `apps/web/utils/mail.ts:105` is `({ htmlText, includeLinks? }) => string` — an object-arg helper.
- **Fix:** `truncateBody` calls `convertEmailHtmlToText({ htmlText: parsedMessage.textHtml ?? "" })`. The test mock matches the same destructuring shape so the spy works.
- **Files modified:** `apps/web/utils/calendar/reconciliation/index.ts`, `apps/web/utils/calendar/reconciliation/index.test.ts` (mock shape).
- **Commit:** `b18156152`.

**2. [Rule 1 — Test fixture] `makeMessage` helper must mirror `subject` override into `headers.subject`**

- **Found during:** First GREEN run (Test C failed for the keyword path).
- **Issue:** The orchestrator reads `parsedMessage.headers?.subject ?? parsedMessage.subject ?? ""` (headers is the canonical Gmail-API home; the top-level `subject` is a convenience copy). The initial test helper only overrode the top-level `subject`, so `headers.subject` stayed `"Test subject"` and the D-02 keyword match never fired.
- **Fix:** Updated `makeMessage` to compute `subject` from the override (defaulting to `"Test subject"`) and assign it to BOTH `parsedMessage.subject` and `parsedMessage.headers.subject`. No production-code change needed.
- **Files modified:** `apps/web/utils/calendar/reconciliation/index.test.ts`.
- **Commit:** `b18156152`.

### Followed plan exactly

- Stale-PENDING recovery: update-in-place per plan's "PICK ONE — recommendation: `update-in-place` for simplicity."
- `isAllDay` sourced from `candidate.isAllDay` (not heuristic) per the plan's revision of D-08.
- Pre-filter order: extractFromIcs → ExecutedRule lookup → keyword backstop → return.
- Outer try/catch wraps the whole body; inner best-effort uses findExistingReconciliationRecord + updateReconciliationRecord; never rethrows.
- Body truncation `.slice(0, 2000)` happens BEFORE extractCandidateEvent (D-05 enforced).

No structural deviations from PATTERNS.md §index.ts (lines 281-313). The threat-model table in the plan's `<threat_model>` is fully covered — see "Threat coverage" below.

## Commits

| Step | Hash | Subject |
|------|------|---------|
| Task 1 | `014c27f77` | `feat(09-06): add matchesKeywordBackstop pre-filter helper (D-02)` |
| Task 2 RED | `a1e402184` | `test(09-06): add failing tests for reconcileMessage orchestrator (RED)` |
| Task 2 GREEN | `b18156152` | `feat(09-06): implement reconcileMessage orchestrator (GREEN)` |

## Auth gates encountered

None.

## Known Stubs

None. The orchestrator is fully wired and covers every D-12 branch with a passing test. Plan 09-07 mounts it inside the Gmail-webhook `after()` fan-out.

## Threat coverage (STRIDE)

| Threat ID | Status |
|-----------|--------|
| T-09-04 (DoS / cost runaway) | **Mitigated.** Idempotency fast-path returns before any LLM call when a non-stale row exists (Test E). Stale-PENDING recovery rehydrates candidate from persisted columns so Haiku is never re-charged (Tests P / P-AllDay). |
| T-09-05 (Information disclosure in logs) | **Mitigated.** Test N asserts no extractedTitle/Location/Attendees/textPlain/textHtml/subject in any logger.error or logger.warn payload. |
| T-09-07 (Tampering / duplication) | **Mitigated.** Persist layer's P2002 catch (from 09-04) propagates as `{created:false}` → orchestrator returns no-op (Test G); also the early findExistingReconciliationRecord short-circuit (Test E). |
| EVT-05 / OPS-01 (exception escape) | **Mitigated.** Outer try/catch + best-effort FAILED-update + DO-NOT-rethrow. Tests K, L, M assert `resolves.toBeUndefined()`. Grep gate: 0 `throw` statements. |

No new threat surface introduced.

## Threat Flags

None — all sub-module boundaries (ics-path, extract, match, persist, create-event, getUpcomingEvents) are pre-existing surfaces with their own mitigations; the orchestrator merely sequences them.

## Test execution note

Vitest invoked via the main-repo node_modules junctioned into the worktree (mklink /J), per the 09-02 / 09-04 pattern. CI's `pnpm test` is unaffected. Commits use `--no-verify` per `~/.claude/memory/feedback_lint_ci_only.md`.

## Self-Check

- [x] FOUND: apps/web/utils/calendar/reconciliation/index.ts
- [x] FOUND: apps/web/utils/calendar/reconciliation/index.test.ts
- [x] FOUND commit 014c27f77 (Task 1)
- [x] FOUND commit a1e402184 (Task 2 RED)
- [x] FOUND commit b18156152 (Task 2 GREEN)
- [x] Vitest: 22 / 22 passed
- [x] Grep gates: 0 throw statements; ≥2 try {; ≥1 slice(0,2000); ≥1 do not rethrow

## Self-Check: PASSED

## TDD Gate Compliance

| Task | RED commit | GREEN commit | REFACTOR | Status |
|------|------------|--------------|----------|--------|
| Task 1 (keyword backstop) | (combined with GREEN — single trivial helper + 5 tests) | `014c27f77` | (not needed) | ✅ compliant — single `feat(...)` ships the helper + green tests together; plan does not require split RED/GREEN for this pure helper |
| Task 2 (orchestrator) | `a1e402184` | `b18156152` | (not needed) | ✅ compliant — observed test(...) RED with 17 failing tests before feat(...) GREEN |

Task 1 was a single-commit feat because its `<action>` block does not mandate a split, the helper is a trivial pure function, and the 5 tests serve as the regression net once GREEN. Task 2 followed strict RED-then-GREEN with RED observed at 17 failures (5 Task-1 keyword tests already passing) → GREEN at 22/22.
