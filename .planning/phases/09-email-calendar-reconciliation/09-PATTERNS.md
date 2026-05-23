# Phase 9: Email ↔ Calendar Reconciliation — Pattern Map

**Mapped:** 2026-05-22
**Files analyzed:** 9 new + 2 modified = 11
**Analogs found:** 11 / 11 (all have a direct in-repo analog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/web/utils/calendar/reconciliation/extract.ts` | service (LLM call) | request-response | `apps/web/utils/ai/choose-rule/ai-choose-rule.ts` (`getAiResponseSingleRule` + `buildClassifierSystem`) | exact (Phase 8.5 cut-point) |
| `apps/web/utils/calendar/reconciliation/extract-prompt.ts` | config (prompt constant + helper) | none (pure) | `apps/web/utils/ai/choose-rule/ai-choose-rule.ts` lines 448-466 (`buildClassifierSystem`) | exact |
| `apps/web/utils/calendar/reconciliation/match.ts` | utility (pure decision tree) | transform | `apps/web/utils/calendar/upcoming-events-helpers.ts` (`isExcluded`/`normalize`/`pastPrune` — pure functions over `NormalizedCalendarEvent[]`) | role-match |
| `apps/web/utils/calendar/reconciliation/dice.ts` | utility (pure scalar fn) | transform | `apps/web/utils/similarity-score.ts` (single-purpose similarity helper) | role-match |
| `apps/web/utils/calendar/reconciliation/signature.ts` | utility (pure scalar fn + sha256) | transform | `apps/web/utils/similarity-score.ts` (pure helper shape) + `node:crypto` direct use | role-match |
| `apps/web/utils/calendar/reconciliation/persist.ts` | persistence (Prisma writes) | CRUD | `apps/web/utils/rule/rule.ts` lines 555-575 (create + P2002 catch via `isDuplicateError`) | exact |
| `apps/web/utils/calendar/reconciliation/create-event.ts` | IO (Google Calendar API) | request-response | `apps/web/utils/calendar/upcoming-events.ts` lines 1-90 (uses `getCalendarClientWithRefresh` + reads `CalendarConnection`) | role-match (read→write swap) |
| `apps/web/utils/calendar/reconciliation/ics-path.ts` | adapter (thin reuse) | transform | `apps/web/utils/parse/calender-event.ts` `analyzeCalendarEvent` + `hasIcsAttachment` (lines 241-249) | exact (direct delegate) |
| `apps/web/utils/calendar/reconciliation/index.ts` | entry point (orchestrator inside `after()`) | event-driven | `apps/web/utils/webhook/process-history-item.ts` lines 215-253 (`processAttachment` `after()` block) | exact |
| `apps/web/utils/calendar/reconciliation/__tests__/*.test.ts` | tests (vitest, mocked Prisma + AI boundary) | n/a | `apps/web/utils/calendar/upcoming-events.test.ts` (mocks `@/utils/redis`, `@/utils/prisma`, `@/utils/calendar/client`) | exact |
| `apps/web/prisma/schema.prisma` (ADD `ReconciliationRecord`) | model + relation + `@@unique` + `@@index` | n/a | `model ThreadTracker` (schema.prisma:874-895) — same shape: cuid id, EmailAccount relation, multi-col `@@unique`, multiple `@@index` lines | exact |
| `apps/web/utils/webhook/process-history-item.ts` (MODIFY: add reconciliation `after()`) | integration site | event-driven | Same file, lines 215-253 (`processAttachment` block — copy alongside) | exact (in-file) |

## Pattern Assignments

### `apps/web/utils/calendar/reconciliation/extract.ts` (service, request-response)

**Analog:** `apps/web/utils/ai/choose-rule/ai-choose-rule.ts` lines 1-13, 109-148, 207-230, 448-466 (Phase 8.5 cut-point — locked).

**Imports pattern** (mirror `ai-choose-rule.ts:1-12`):
```ts
import type { SystemModelMessage } from "ai";
import { z } from "zod";
import { getModel } from "@/utils/llms/model";
import { createGenerateObject } from "@/utils/llms";
import { Provider } from "@/utils/llms/config";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
```
- `SystemModelMessage` from `"ai"` (NOT `CoreSystemMessage` — renamed pre-v6).
- Always go through `getModel(emailAccount.user, "economy")`, never import `@ai-sdk/anthropic` directly in feature code.

**Cached-system-message pattern** (mirror `ai-choose-rule.ts:452-466` verbatim):
```ts
function buildExtractionSystem(
  systemText: string,
  provider: string,
): string | SystemModelMessage[] {
  if (provider !== Provider.ANTHROPIC) return systemText;
  return [
    {
      role: "system",
      content: systemText,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
  ];
}
```
- `providerOptions` is a sibling of `content`, NOT nested in a content-part array. This is the Phase 8.5 bug fixed in commits 4ebbc278e + f4251fb73 — DO NOT regress.

**`createGenerateObject` call pattern** (mirror `ai-choose-rule.ts:109-115` + `225-230`):
```ts
const modelOptions = getModel(emailAccount.user, "economy");
const generateObject = createGenerateObject({
  emailAccount,
  label: "Reconciliation extract",          // ← unique label flows into saveAiUsage / Tinybird
  modelOptions,
  promptHardening: { trust: "untrusted", level: "full" }, // D-04 pairing
});

const result = await generateObject({
  ...modelOptions,
  system: buildExtractionSystem(systemText, modelOptions.provider),
  prompt,
  schema: candidateEventSchema,
  temperature: 0,                           // extraction must be deterministic
  maxOutputTokens: 400,
});
```
- Never call AI-SDK `generateObject` directly — bypasses `saveAiUsage` (OPS-02) and prompt hardening.
- Never re-call `saveAiUsage` from feature code; `createGenerateObject` does it internally.
- `label` MUST be unique per call site so the Tinybird stream is filterable.

**Zod schema pattern** (mirror `ai-choose-rule.ts:207-223` — flat object, `.describe()` on every field, scalar nullables, no unions, no discriminated unions):
```ts
const singleRuleSchema = z.object({
  reasoning: z.string().describe("..."),
  ruleName: z.string().nullable().describe("..."),
  noMatchFound: z.boolean().describe("..."),
  confidenceScore: z.number().describe("..."),
});
```
- Use `.nullable()` not `z.union([z.string(), z.null()])` (Zod 4 + Anthropic structured outputs).

---

### `apps/web/utils/calendar/reconciliation/extract-prompt.ts` (config)

**Analog:** `ai-choose-rule.ts:165-199` (the `system` string literal — system text is the only thing that goes in a module-level constant; per-call substitution happens via `.replace("{{TZ}}", tz)`).

**Pattern:** Module-level `export const SYSTEM_PROMPT_TEMPLATE = \`...{{TZ}}...\`;` plus the `buildExtractionSystem` helper (above). Keep it stable across deploys — any change invalidates the Anthropic ephemeral cache (one cache-miss window per change). Treat changes like migrations.

Per AI-SPEC §3 pitfall #2: the cached prefix MUST exceed 1024 tokens or Anthropic silently drops the breakpoint. Pad with worked examples (RESEARCH §8a draft is ~1500 tokens — sufficient).

---

### `apps/web/utils/calendar/reconciliation/match.ts` (utility, transform — PURE)

**Analog:** `apps/web/utils/calendar/upcoming-events-helpers.ts` — pure-function module operating on `NormalizedCalendarEvent[]`. Same shape: input is `NormalizedCalendarEvent[]` from `getUpcomingEvents`, output is an outcome bucket.

**Pattern:** Zero deps on Prisma, Google, or AI SDK. Imports only types (`NormalizedCalendarEvent` from `@/utils/calendar/upcoming-events-types`) and the `dice.ts` helper. Exports a single pure function:

```ts
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
import { titleSimilarity } from "./dice";

export type ReconcileOutcome = "MATCHED" | "CREATED" | "AMBIGUOUS";

export function decideOutcome({
  candidate,
  existingEvents,
}: {
  candidate: { title: string; startISO: string; isAllDay: boolean };
  existingEvents: NormalizedCalendarEvent[];
}): { outcome: ReconcileOutcome; matchedEventId: string | null } {
  // D-06 four-step decision tree
}
```
- All branches deterministic. Unit-test each branch + boundary cases without mocking anything (RESEARCH §D).

---

### `apps/web/utils/calendar/reconciliation/dice.ts` (utility, transform — PURE)

**Analog:** `apps/web/utils/similarity-score.ts` (existing pure-helper file shape).

**Pattern:** RESEARCH §6 Option B (recommended over the existing `string-similarity@4.0.4` dep, which uses character bigrams, not whitespace-token bigrams that D-07 specifies):

```ts
export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    s.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection++;
  return (2 * intersection) / (A.size + B.size);
}
```
- No dep on `string-similarity` package. The dep stays installed for `similarity-score.ts` (drafts), but reconciliation uses its own helper to match D-07's locked decision.

---

### `apps/web/utils/calendar/reconciliation/signature.ts` (utility, transform — PURE)

**Analog:** Pure-helper shape from `apps/web/utils/similarity-score.ts`; `node:crypto` direct import (Node built-in, no new dep).

**Pattern** (from RESEARCH §E):
```ts
import { createHash } from "node:crypto";

export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

export function eventSignature(title: string, startISO: string): string {
  return createHash("sha256")
    .update(`${normalizeTitle(title)}|${startISO}`)
    .digest("hex");
}
```
- **Immutable contract post-merge.** Bumping it would invalidate D-14's unique constraint on existing rows.

---

### `apps/web/utils/calendar/reconciliation/persist.ts` (persistence, CRUD)

**Analog:** `apps/web/utils/rule/rule.ts` lines 19, 555-575 (create + `isDuplicateError` catch — exact P2002 idempotency idiom in this repo).

**P2002 idempotency pattern** (mirror `rule.ts:555-575`):
```ts
import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";

try {
  const record = await prisma.reconciliationRecord.create({
    data: { /* ... */ },
  });
  return { created: true, record };
} catch (error) {
  if (!isDuplicateError(error)) throw error;
  // D-14: idempotency hit — webhook replay landed on existing row
  logger.info("Reconciliation record already exists (idempotency hit)", {
    emailAccountId,
    messageId,
  });
  return { created: false, record: null };
}
```
- Use `isDuplicateError` from `@/utils/prisma-helpers` (defined `apps/web/utils/prisma-helpers.ts:3-12`). Do NOT re-implement the `Prisma.PrismaClientKnownRequestError && code === "P2002"` check inline.
- `isDuplicateError(error, key)` second arg can narrow to a specific unique-key target if needed.

**Update-after-create pattern** (for the `googleEventId` / `outcome` flip after Google call): plain `prisma.reconciliationRecord.update({ where: { id }, data: { ... } })` — no special pattern.

---

### `apps/web/utils/calendar/reconciliation/create-event.ts` (IO, request-response)

**Analog:** `apps/web/utils/calendar/upcoming-events.ts` lines 1-90 — uses `getCalendarClientWithRefresh`, reads `CalendarConnection` via `prisma.calendarConnection.findFirst`. Phase 9 does the same auth dance, then calls `.events.insert` instead of `.events.list`.

**Auth + client construction pattern** (mirror `upcoming-events.ts:64-78`):
```ts
const connection = await prisma.calendarConnection.findFirst({
  where: { emailAccountId, provider: "google", isConnected: true },
  select: { id: true, accessToken: true, refreshToken: true, expiresAt: true },
});
if (!connection) {
  logger.warn("No Google calendar connection found", { emailAccountId });
  return { ok: false as const, reason: "no-connection" };
}

const client = await getCalendarClientWithRefresh({
  accessToken: connection.accessToken,
  refreshToken: connection.refreshToken,
  expiresAt: connection.expiresAt ? Number(connection.expiresAt) : null,
  emailAccountId,
  connectionId: connection.id,
  logger,
});
```
- Always pass `emailAccountId` explicitly to `getCalendarClientWithRefresh` (T-09-06: no cross-account client reuse).
- Convert `connection.expiresAt` (Prisma `BigInt`) to `Number` per WR-03 — see `upcoming-events.ts` "Narrow explicitly" comment at line 80.

**Event insert pattern** (the new bit, no in-repo prior — but the `client.events.list` shape at `upcoming-events.ts` is the structural sibling). Use direct `@googleapis/calendar` types:
```ts
const inserted = await client.events.insert({
  calendarId: "primary",
  requestBody: {
    summary: `[AI] ${candidate.title}`,                  // D-17 prefix
    description: buildBackRefDescription({                // D-18 Gmail deep link + Message-ID
      threadId,
      senderEmail,
      messageId,
    }),
    start: candidate.isAllDay
      ? { date: candidate.startISO.slice(0, 10) }       // D-08 all-day shape
      : { dateTime: candidate.startISO, timeZone: tz },
    end: /* mirror start shape */,
  },
});
```
- DO NOT route through `GoogleCalendarEventProvider` (see CONTEXT.md `<canonical_refs>` "Reference only" warning + RESEARCH "Phase 9 calls `client.events.insert` directly").
- DO NOT include attendees in `requestBody` for v1.1 (CONTEXT.md scope: "Sending invites on behalf of the user — read + create only" is explicitly out).

---

### `apps/web/utils/calendar/reconciliation/ics-path.ts` (adapter)

**Analog:** `apps/web/utils/parse/calender-event.ts` `analyzeCalendarEvent` + `hasIcsAttachment` (lines 24-249) — use AS-IS.

**Pattern:** Thin adapter that calls `analyzeCalendarEvent(parsedMessage)` and reshapes the result into the same `{ title, startISO, endISO, location, attendees, confidence, isAllDay }` shape `extract.ts` produces. No LLM call. No new logic.

```ts
import { analyzeCalendarEvent, hasIcsAttachment } from "@/utils/parse/calender-event";

export function extractFromIcs(parsedMessage: ParsedMessage): CandidateEvent | null {
  if (!hasIcsAttachment(parsedMessage)) return null;
  const ics = analyzeCalendarEvent(parsedMessage);
  if (!ics.isCalendarEvent || !ics.eventDate) return null;
  return { /* map to CandidateEvent shape */ };
}
```
- Per CONTEXT.md D-01 + T-09-02: `.ics` field content NEVER reaches the LLM. This adapter is the boundary.

---

### `apps/web/utils/calendar/reconciliation/index.ts` (entry point, event-driven orchestrator)

**Analog:** `apps/web/utils/webhook/process-history-item.ts` lines 215-253 (`processAttachment` `after()` block). Phase 9's orchestrator is invoked FROM that file's pattern; the orchestrator itself owns the D-12 sequence.

**Exported signature** (per CONTEXT.md `<code_context>` Integration Points):
```ts
export async function reconcileMessage({
  parsedMessage,
  emailAccount,
  emailAccountId,
  logger,
}: {
  parsedMessage: ParsedMessage;
  emailAccount: EmailAccountWithAI;
  emailAccountId: string;
  logger: Logger;
}): Promise<void>;
```

**D-12 sequence inside the function body:**
1. Pre-filter (D-01): `hasIcsAttachment` → Path A; else check `Calendar` rule match OR D-02 keyword backstop → Path B; else return.
2. Look up existing `ReconciliationRecord` for `(emailAccountId, messageId)` — if any row exists, return no-op (idempotency fast-path before LLM call).
3. Extract via Path A or Path B → `CandidateEvent`.
4. Compute `eventSignature(title, startISO)`.
5. `persist.create` with the unique-constraint triple — catch P2002 → no-op (D-14 belt-and-braces).
6. If newly created: call `getUpcomingEvents({ emailAccountId, now, logger })`, run `match.decideOutcome`, update record with outcome.
7. If outcome === `CREATED`: call `createCalendarEvent`, update record with `googleEventId` + `googleEventHtmlLink`.
8. Wrap whole body in `try / catch` — on any error: update record to `outcome = FAILED` with structured-fields-only `errorMessage`. DO NOT rethrow (failure isolation, OPS-01).

**Logging discipline** (Phase 8 D-09 carry-forward, also verified in `upcoming-events.ts:130-135`):
- Acceptable identifiers: `emailAccountId`, `messageId`, `threadId`, `outcome`, `errorCode`, `confidence`, `eventSignature`.
- NEVER log: `extractedTitle`, `extractedLocation`, `extractedAttendees`, raw `textPlain` / `textHtml`, full subject line in `warn`/`error` payloads.

---

### `apps/web/utils/calendar/reconciliation/__tests__/*.test.ts` (tests)

**Analog:** `apps/web/utils/calendar/upcoming-events.test.ts` lines 1-50 (mocks `@/utils/redis`, `@/utils/prisma`, `@/utils/calendar/client`; fixed `NOW` constant; `makeMockLogger()` helper). Also `apps/web/utils/webhook/process-history-item.test.ts` for the `after()` synchronous-mock pattern.

**Mock pattern at top of every test file** (mirror `upcoming-events.test.ts:5-22`):
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma", () => ({
  default: {
    reconciliationRecord: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    calendarConnection: { findFirst: vi.fn() },
  },
}));
vi.mock("@/utils/calendar/client", () => ({
  getCalendarClientWithRefresh: vi.fn(),
}));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: vi.fn(),
}));
```

**Logger helper** (copy verbatim from `upcoming-events.test.ts:39-47`):
```ts
function makeMockLogger(): Logger {
  return {
    warn: vi.fn(), error: vi.fn(), info: vi.fn(),
    trace: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;
}
```

**P2002 idempotency test pattern** (mirror `apps/web/app/api/follow-up-reminders/process.test.ts:821-829`):
```ts
const { Prisma } = await import("@/generated/prisma/client");
const duplicateError = new Prisma.PrismaClientKnownRequestError(
  "Unique constraint failed",
  { code: "P2002", clientVersion: "5.0.0" },
);
vi.mocked(prisma.reconciliationRecord.create).mockRejectedValueOnce(duplicateError);
// assert orchestrator returns no-op without rethrow
```

**`after()` sync execution** is already mocked globally in `apps/web/__tests__/setup.ts:5-17` — no per-test setup needed for the orchestrator integration test.

Tests live in `apps/web/utils/calendar/reconciliation/__tests__/` per AI-SPEC §3 recommended layout.

---

### `apps/web/prisma/schema.prisma` (ADD `ReconciliationRecord`)

**Analog:** `model ThreadTracker` at `schema.prisma:874-895` — same shape (cuid `id`, `createdAt`/`updatedAt`, `messageId` + `threadId` strings, `emailAccountId` FK with `onDelete: Cascade`, multi-column `@@unique`, multiple `@@index`). Also `model ExecutedRule` at `:593-622` for the multi-index pattern.

**Model template** (combine ThreadTracker shape + D-13 fields + D-14 unique + D-15 index):
```prisma
model ReconciliationRecord {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  emailAccountId String
  emailAccount   EmailAccount @relation(fields: [emailAccountId], references: [id], onDelete: Cascade)

  messageId String
  threadId  String

  outcome              ReconciliationOutcome  // enum: MATCHED | CREATED | AMBIGUOUS | PENDING | FAILED
  googleEventId        String?
  googleEventHtmlLink  String?

  extractedTitle       String
  extractedStart       DateTime
  extractedEnd         DateTime?
  extractedLocation    String?
  extractedAttendees   String[]
  candidateConfidence  Float
  eventSignature       String

  errorMessage         String?

  @@unique([emailAccountId, messageId, eventSignature])   // D-14
  @@index([emailAccountId, createdAt(sort: Desc)])        // D-15 (Phase 10 digest query)
  @@index([emailAccountId, outcome])                       // PENDING sweep (D-16)
}

enum ReconciliationOutcome {
  MATCHED
  CREATED
  AMBIGUOUS
  PENDING
  FAILED
}
```

Also need to add the reverse relation field on `EmailAccount`:
```prisma
// inside model EmailAccount {}
reconciliationRecords ReconciliationRecord[]
```

**Migration creation:** Per RESEARCH §7, `pnpm prisma migrate dev --create-only --name add_reconciliation_record` MUST run on a non-Windows host (CLAUDE.md forbids local `tsc`/build on user's box). Commit the migration SQL; CI applies on deploy.

---

### `apps/web/utils/webhook/process-history-item.ts` (MODIFY: add reconciliation `after()`)

**Analog:** Same file, lines 215-253 — `processAttachment` `after()` block. Phase 9 adds a sibling `after(...)` invocation immediately after it (or before; ordering doesn't matter — Next.js `after` callbacks run independently).

**Exact pattern to copy + adapt** (from `process-history-item.ts:215-252`):
```ts
after(() =>
  runWithBackgroundLoggerFlush({
    logger,
    task: async () => {
      await reconcileMessage({
        parsedMessage,
        emailAccount,
        emailAccountId,
        logger,
      }).catch((error) => {
        logger.error("Failed to reconcile message", {
          messageId: parsedMessage.id,
          error,
        });
      });
    },
    extra: { operation: "reconcile-message" },
  }),
);
```

**Three load-bearing patterns (RESEARCH §B):**
1. **`runWithBackgroundLoggerFlush`** (from `@/utils/logger-flush`) — without this, logs fired AFTER the HTTP response will not flush to Axiom.
2. **`.catch(...)` on the inner async** — converts a reconciliation throw into a logged error rather than an unhandled rejection in `after()`.
3. **`extra: { operation: "reconcile-message" }`** — correlation tag for log searches.

Place this `after()` block under the same `hasAiAccess` / feature-flag gate the planner picks (CONTEXT.md leaves this open — likely an `emailAccount.reconciliationEnabled` flag, or just `hasAiAccess` mirroring `processAttachment`).

---

## Shared Patterns

### Logger discipline (Phase 8 D-09 carry-forward, T-09-05)

**Source:** Phase 8 `apps/web/utils/calendar/upcoming-events.ts:130-135` (structured fields only on warn/error paths).
**Apply to:** every file in `apps/web/utils/calendar/reconciliation/`.

- `logger.info` may include `messageId`, `threadId`, `outcome`, `eventSignature`, `confidence`, `emailAccountId`, count fields.
- `logger.warn` / `logger.error` MUST NOT include `extractedTitle`, `extractedLocation`, `extractedAttendees`, raw `textPlain`/`textHtml`, full subject lines.
- Pass `error` objects whole to `logger.error("...", { error })`; the logger serializes them.

### `after()` non-blocking hook (OPS-01, EVT-05)

**Source:** `apps/web/utils/webhook/process-history-item.ts:215-253`.
**Apply to:** every entry point that performs LLM/IO work whose failure must not block classification, archiving, digest enqueue, or the Pub/Sub HTTP response.

Wrap body in `runWithBackgroundLoggerFlush` + `.catch` on every internal async + `extra: { operation: <slug> }`.

### `createGenerateObject` wrapping (OPS-02 cost tracking)

**Source:** `apps/web/utils/ai/choose-rule/ai-choose-rule.ts:109-115`.
**Apply to:** the single LLM call in `extract.ts`.

Never call `generateObject` from `ai` directly. Always thread through `createGenerateObject({ emailAccount, label, modelOptions, promptHardening })` so `saveAiUsage` fires automatically. Use a unique `label` per call site (here: `"Reconciliation extract"`).

### Anthropic cache-control on system block (D-19, OPS-03 inheritance)

**Source:** `apps/web/utils/ai/choose-rule/ai-choose-rule.ts:452-466`.
**Apply to:** any new LLM call site whose system prefix is stable across calls — Phase 9's `extract.ts` is the only one.

Branch on `provider === Provider.ANTHROPIC`; return `SystemModelMessage[]` with `providerOptions.anthropic.cacheControl.type = "ephemeral"`. `providerOptions` is a sibling of `content`, NOT nested inside content parts. System prefix MUST exceed 1024 tokens to engage the cache.

### Prisma P2002 idempotency catch

**Source:** `apps/web/utils/prisma-helpers.ts:3-12` (`isDuplicateError`) + `apps/web/utils/rule/rule.ts:555-575` (call-site pattern).
**Apply to:** `persist.ts` create call.

Use `isDuplicateError(error)` — do NOT re-implement the Prisma error-shape check inline. Optional second arg narrows by unique-key target name if needed.

### Test mocks at module boundary

**Source:** `apps/web/utils/calendar/upcoming-events.test.ts:1-50` + `apps/web/__tests__/setup.ts:5-17` (global `after()` sync mock).
**Apply to:** every test file in `apps/web/utils/calendar/reconciliation/__tests__/`.

Mock `@/utils/prisma`, `@/utils/calendar/client`, `@/utils/llms` (for `createGenerateObject`) at module level via `vi.mock`. No real DB. Use `makeMockLogger()` helper. Fixed `NOW` constant for time-sensitive tests.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| — | — | — | Every Phase 9 file has at least a role-match analog in the existing codebase. The most novel call (`client.events.insert`) has the structural sibling `client.events.list` in `upcoming-events.ts` and uses the same auth setup. |

## Metadata

**Analog search scope:**
- `apps/web/utils/ai/choose-rule/` (Phase 8.5 cached-classifier reference — exact cut-point for `extract.ts`)
- `apps/web/utils/calendar/` (Phase 8 read-path + auth client — exact for `create-event.ts`, `match.ts`, tests)
- `apps/web/utils/webhook/` (after() integration site)
- `apps/web/utils/parse/` (.ics deterministic parser)
- `apps/web/utils/rule/` (P2002 catch idiom)
- `apps/web/utils/` (`prisma-helpers.ts`, `similarity-score.ts`)
- `apps/web/prisma/schema.prisma` (model shape analogs)
- `apps/web/__tests__/` (test setup conventions)

**Files scanned:** ~12 (file:line citations recorded inline).
**Pattern extraction date:** 2026-05-22
