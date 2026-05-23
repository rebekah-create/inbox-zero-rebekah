---
phase: 09-email-calendar-reconciliation
plan: 04
subsystem: persistence
tags: [prisma, persistence, idempotency, p2002, reconciliation]
requires:
  - ReconciliationRecord Prisma model (09-01)
  - ReconciliationOutcome enum (09-01)
  - @/utils/prisma-helpers isDuplicateError
provides:
  - createReconciliationRecord (P2002-idempotent insert)
  - findExistingReconciliationRecord ((emailAccountId, messageId) lookup)
  - updateReconciliationRecord (outcome / googleEventId / errorMessage patch)
  - findStalePendingRecord (5-minute PENDING sweep — D-16)
  - CreateReconciliationInput type (includes extractedIsAllDay revision column)
affects:
  - apps/web/utils/calendar/reconciliation/persist.ts (new)
  - apps/web/utils/calendar/reconciliation/persist.test.ts (new)
tech_stack_added: []
patterns:
  - p2002-idempotency-via-isDuplicateError (rule.ts:555-575 analog)
  - vi.mock @/utils/prisma at module boundary (upcoming-events.test.ts analog)
  - injected `now` for deterministic stale-sweep cutoff testing
key_files:
  created:
    - apps/web/utils/calendar/reconciliation/persist.ts
    - apps/web/utils/calendar/reconciliation/persist.test.ts
    - .planning/phases/09-email-calendar-reconciliation/09-04-SUMMARY.md
  modified: []
decisions:
  - Mock @/utils/prisma-helpers (not @/generated/prisma/client) so test never depends on a generated Prisma runtime — the worktree has no prisma client and the unit test boundary is "isDuplicateError returns true/false", not "the error class is Prisma's"
  - Type the P2002 log payload narrowly — only emailAccountId + messageId — and assert absence of PII fields via `expect(payload).not.toHaveProperty(...)` rather than a `not.objectContaining` pattern so each PII field gets its own readable failure line
  - Inject `now` into findStalePendingRecord as an optional parameter (default Date.now()) — cleaner than module-level vi.useFakeTimers and keeps the production call-site one-arg-shorter
metrics:
  duration_minutes: ~12
  tasks_completed: 1
  files_changed: 2
  tests_added: 7
  completed_at: 2026-05-23
---

# Phase 09 Plan 04: Prisma Persistence Layer Summary

Persistence helpers for `ReconciliationRecord`: idempotent create that catches D-14 unique-constraint hits via the repo's canonical `isDuplicateError` idiom, a lookup by `(emailAccountId, messageId)` for the orchestrator's pre-LLM fast-path, an update for the post-Google-call patch, and a stale-PENDING sweep that surfaces rows whose worker crashed mid-flight (D-16). One source file, one test file, seven passing tests.

## What Was Built

### `apps/web/utils/calendar/reconciliation/persist.ts`

Four exported async functions plus the `CreateReconciliationInput` type and a `ReconciliationOutcome` string literal union mirroring the schema enum:

- **`createReconciliationRecord({ input, logger })`** — writes a row with `outcome: "PENDING"` and the full D-13 field set including the 09-01 `extractedIsAllDay` revision column. Wraps `prisma.reconciliationRecord.create` in a try/catch; on error it goes through `isDuplicateError(error)` — on `true` returns `{ created: false, record: null }` with a PII-safe `logger.info` call; otherwise rethrows. Return type is the discriminated union `{ created: true; record } | { created: false; record: null }` so callers can branch off `created` without nullable juggling.
- **`findExistingReconciliationRecord({ emailAccountId, messageId })`** — single `findFirst` with the two-column where clause. Used by the orchestrator (09-06) as the pre-LLM idempotency fast-path before paying for extract.
- **`updateReconciliationRecord({ id, data })`** — typed-data update accepting any subset of `outcome` / `googleEventId` / `googleEventHtmlLink` / `errorMessage`. The orchestrator calls this twice: once on outcome decision, once on Google call completion.
- **`findStalePendingRecord({ emailAccountId, messageId, now? })`** — D-16 sweep. `now` is an optional injected parameter defaulting to `Date.now()`; the `updatedAt: { lt: <now - 5min> }` clause guarantees the orchestrator never deletes-and-retries a row that's still being processed by a peer worker.

`STALE_PENDING_MS = 5 * 60 * 1000` is a module-private constant — not exported. The orchestrator never recomputes the cutoff; it only consumes the result.

### `apps/web/utils/calendar/reconciliation/persist.test.ts`

Seven tests, no DB, no Prisma runtime:

| # | Function | Asserts |
|---|----------|---------|
| 1 | createReconciliationRecord | outcome=PENDING + extractedIsAllDay persisted + full D-13 payload + `{created:true,record}` shape |
| 2 | createReconciliationRecord | P2002 catch → `{created:false,record:null}` + logger.info called once with `{emailAccountId, messageId}` only; explicit `not.toHaveProperty` for `extractedTitle`, `extractedLocation`, `extractedAttendees`, `eventSignature` (T-09-05) |
| 3 | createReconciliationRecord | non-P2002 error rethrows |
| 4 | findExistingReconciliationRecord | calls `findFirst` with `{ where: { emailAccountId, messageId } }` |
| 5 | updateReconciliationRecord | calls `update` with `{ where: { id }, data: {...} }` round-trip |
| 6 | findStalePendingRecord | injected `now` produces `updatedAt: { lt: new Date(now - 5*60*1000) }` cutoff; outcome filter is `"PENDING"` |
| 7 | findStalePendingRecord | returns null when Prisma returns null |

Mocks: `@/utils/prisma` (module-level `default` export with `reconciliationRecord.{findFirst,create,update}`) and `@/utils/prisma-helpers` (`isDuplicateError` as a `vi.fn()`).

## Function Signatures (Finalized)

```ts
export type ReconciliationOutcome =
  | "MATCHED" | "CREATED" | "AMBIGUOUS" | "PENDING" | "FAILED";

export type CreateReconciliationInput = {
  emailAccountId: string;
  messageId: string;
  threadId: string;
  eventSignature: string;
  extractedTitle: string;
  extractedStart: Date;
  extractedEnd: Date | null;
  extractedLocation: string | null;
  extractedAttendees: string[];
  candidateConfidence: number;
  extractedIsAllDay: boolean;
};

export async function createReconciliationRecord(args: {
  input: CreateReconciliationInput;
  logger: Logger;
}): Promise<
  | { created: true; record: <prisma create return> }
  | { created: false; record: null }
>;

export async function findExistingReconciliationRecord(args: {
  emailAccountId: string;
  messageId: string;
}): Promise<<prisma findFirst return>>;

export async function updateReconciliationRecord(args: {
  id: string;
  data: {
    outcome?: ReconciliationOutcome;
    googleEventId?: string | null;
    googleEventHtmlLink?: string | null;
    errorMessage?: string | null;
  };
}): Promise<<prisma update return>>;

export async function findStalePendingRecord(args: {
  emailAccountId: string;
  messageId: string;
  now?: number;
}): Promise<<prisma findFirst return>>;
```

## P2002 Catch Verification

Both grep gates from the plan pass:

```
grep -c "isDuplicateError" persist.ts         → 3   (≥ 2 required: 1 import + 2 call sites — actually 1 import + 1 call site = 2, but grep counts the export type comment too — verified manually as: import line + try/catch call site)
grep -E 'code === "P2002"|PrismaClientKnownRequestError' persist.ts | wc -l   → 0   (no inline P2002 check)
```

The catch block follows the `apps/web/utils/rule/rule.ts:555-575` idiom verbatim: `try { create } catch (error) { if (!isDuplicateError(error)) throw error; <handle no-op> }`.

## PII-Safe Logger Assertion Approach

Test 2 destructures `vi.mocked(logger.info).mock.calls[0]` into `[message, payload]` and asserts:

1. `payload` **strict-equals** `{ emailAccountId, messageId }` — guarantees no extra fields slip in.
2. Defensive `expect(payload).not.toHaveProperty(field)` for `extractedTitle`, `extractedLocation`, `extractedAttendees`, `eventSignature`. The `toEqual` already implies absence, but the explicit assertions produce a per-field failure message when a future refactor accidentally widens the payload — which makes T-09-05 regressions surface with a clear remediation pointer.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Worktree has no `node_modules` / no Prisma client**

- **Found during:** vitest invocation in worktree
- **Issue:** `pnpm test` from inside the worktree fails — there is no `node_modules` here (no `pnpm install` was run for this worktree); the same condition was already documented in 09-01-SUMMARY.md.
- **Fix:** Ran the test suite from the **main checkout's** `apps/web/node_modules/vitest/vitest.mjs` after copying the two new files into the main checkout's working tree. After the run finished green, the copies were removed from the main checkout (the staged-but-untouched `M .planning/ROADMAP.md` and `M .planning/STATE.md` entries there are pre-existing and untouched). The worktree's commit is the canonical source.
- **Files modified:** none beyond the planned `persist.ts` + `persist.test.ts`
- **Commit:** captured in this SUMMARY (no code commit needed for the deviation itself)

**2. [Rule 3 — Blocking] Husky pre-commit fails in worktree**

- **Found during:** Task 1 commit
- **Issue:** Same Windows `Exec format error` on `.husky/pre-commit` documented in 09-01-SUMMARY.md.
- **Fix:** Used `git commit --no-verify` per `feedback_lint_ci_only.md` memory and the parallel-execution prompt note. CI will run lint + typecheck on push.
- **Commit:** `840328200`

No other deviations. PATTERNS.md §persist.ts was followed verbatim; signatures match the plan's `<action>` block.

## Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | feat(09-04): persist ReconciliationRecord with P2002 idempotency + stale sweep | `840328200` |

## Verification Status

- `vitest run utils/calendar/reconciliation/persist` → **7 / 7 passed**, 1.72s, no warnings beyond the standard tsconfig-paths sibling-worktree noise
- `grep -c "isDuplicateError" persist.ts` → 3 (≥ 2)
- `grep -E 'code === "P2002"|PrismaClientKnownRequestError' persist.ts | wc -l` → 0
- Manual review: `extractedTitle`, `extractedLocation`, `extractedAttendees` appear only in the `prisma.reconciliationRecord.create` `data` payload, never in any `logger.*` call

## Known Stubs

None. The four exports are fully wired to Prisma; the orchestrator (09-06) imports them as-is.

## Threat Flags

None. The persistence boundary additions are covered by the plan's `<threat_model>`:

- **T-09-05** (information disclosure on log) → mitigated by the restricted log payload + Test 2 assertion
- **T-09-07** (duplication race on concurrent webhook delivery) → mitigated by DB-level D-14 unique constraint + P2002 catch via `isDuplicateError`

No new surface introduced.

## Self-Check: PASSED

- File `apps/web/utils/calendar/reconciliation/persist.ts` exists: FOUND
- File `apps/web/utils/calendar/reconciliation/persist.test.ts` exists: FOUND
- Commit `840328200` exists: FOUND
- All 7 tests pass
