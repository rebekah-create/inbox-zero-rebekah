# Phase 10: Digest Agenda + Reconciliation Outcomes — Pattern Map

**Mapped:** 2026-05-23
**Files analyzed:** 14 (4 modified + 10 new)
**Analogs found:** 14 / 14 (every new file has a close existing analog inside the repo)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/resend/emails/digest-v2.tsx` (MODIFY in place) | React Email template + types | render | itself (existing `ActionItemCard` + `AutoFiledGroupCard` sub-components) | self-extend |
| `packages/resend/emails/digest-v2.tsx` — new `AgendaSection` sub-component (inline) | React Email sub-component | render | `AutoFiledGroupCard` (`digest-v2.tsx:116`) | exact role + flow |
| `packages/resend/emails/digest-v2.tsx` — new `CalendarActivitySection` sub-component (inline) | React Email sub-component | render | `AutoFiledGroupCard` (`digest-v2.tsx:116`) | exact role + flow |
| `apps/web/utils/digest/run-daily-digest.ts` (MODIFY) | orchestrator / props builder | request-response + I/O composition | itself (existing parallel-fetch + bucketing + props build) | self-extend |
| `apps/web/utils/digest/agenda/window.ts` (NEW) | pure helper | transform | `apps/web/utils/calendar/upcoming-events-helpers.ts` (Phase 8 pure helpers) | role-match |
| `apps/web/utils/digest/agenda/overlap.ts` (NEW) | pure helper (decision/comparison) | transform | `apps/web/utils/calendar/reconciliation/match.ts` (`decideOutcome`) | exact role + flow |
| `apps/web/utils/digest/agenda/format-time.ts` (NEW) | pure helper (string format) | transform | `apps/web/utils/digest/today-et.ts` (`Intl.DateTimeFormat` wrappers) | exact role + flow |
| `apps/web/utils/digest/agenda/build-agenda.ts` (NEW) | pure props builder | transform | `apps/web/utils/calendar/reconciliation/index.ts` `matchesKeywordBackstop` (pure composition style) + Phase 4 `buildActionItems` shape | role-match |
| `apps/web/utils/digest/calendar-activity/render-sentence.ts` (NEW) | pure helper (template) | transform | `apps/web/utils/calendar/reconciliation/dice.ts` (pure, no I/O, no imports) | role-match (pure shape) |
| `apps/web/utils/digest/calendar-activity/pick-link-target.ts` (NEW) | pure helper (selector) | transform | `apps/web/utils/calendar/reconciliation/match.ts` (`decideOutcome` enum-returning pure fn) | role-match |
| `apps/web/utils/digest/calendar-activity/build-activity.ts` (NEW) | pure props builder | transform | same as `build-agenda.ts` | role-match |
| Per-helper `*.test.ts` files (NEW, 7 of them) | unit tests (fixture-table) | test | `apps/web/utils/calendar/reconciliation/match.test.ts` | exact role + style |
| `apps/web/utils/ai/digest/digest-prompt.ts` (MODIFY) | prompt builder (pure string assembly) | transform | itself (`renderBucket` + `buildDigestPrompt`) | self-extend |
| `apps/web/utils/ai/digest/generate-digest-content.ts` (MODIFY signature only) | LLM fetcher | request-response | itself (one call site, pass-through prompt builder) | self-extend |

## Pattern Assignments

### `packages/resend/emails/digest-v2.tsx` — extend `DigestV2Props` + add two sub-components (MODIFY)

**Analog:** itself — `digest-v2.tsx:30-47` (current `DigestV2Props`) and `digest-v2.tsx:116-144` (`AutoFiledGroupCard`).

**Props extension pattern** (existing — `digest-v2.tsx:38-47`):
```tsx
export type DigestV2Props = {
  baseUrl?: string;
  date?: string;
  sentTime?: string;
  narrativeGreeting: string;
  narrativeBody: string;
  urgent: ActionItem[];
  uncertain: ActionItem[];
  autoFiled: AutoFiledGroup[];
};
```
Phase 10 adds two **optional** fields at the bottom (preserving Phase 4 backward-compat per D-03; renders empty if absent — see Assumption A5):
```tsx
agenda?: AgendaBlock | null;
calendarActivity?: CalendarActivityBlock | null;
```
New row types (modelled exactly on `ActionItem` / `AutoFiledRow`):
```tsx
export type AgendaItem = {
  time: string;          // "9:00a"
  endTime: string | null; // "10:00a" or null
  title: string;
  location: string | null;
  isAllDay: boolean;
  overlapWith: string[]; // ids of overlapping siblings; presence = render pill
};
export type AgendaBlock = {
  today: AgendaItem[];
  tomorrowMorning: AgendaItem[];
  todayFallback: string | null;          // D-05 copy when today empty
  tomorrowMorningFallback: string | null; // D-05 copy when tomorrow-morning empty
};
export type CalendarActivityRow = {
  sentence: string;     // pre-rendered per D-11 templates
  href: string;         // googleEventHtmlLink or Gmail thread fallback (D-13)
};
export type CalendarActivityBlock = {
  review: CalendarActivityRow[];    // AMBIGUOUS
  added: CalendarActivityRow[];     // CREATED
  confirmed: CalendarActivityRow[]; // MATCHED
};
```

**Sub-component pattern** (copy from `digest-v2.tsx:116-144` `AutoFiledGroupCard`):
```tsx
function AutoFiledGroupCard({ group }: { group: AutoFiledGroup }) {
  const colors = groupColor[group.category];
  return (
    <Section className={`border-l-[4px] ${colors.border} ${colors.bg} rounded-[3px] py-[14px] px-[16px] pb-[6px]`}>
      <Text className={`m-0 mb-[10px] text-[13px] font-bold tracking-[0.02em] ${colors.heading}`}>
        {group.title}
        <span className="font-medium text-gray-400 text-[12px] ml-[6px]">
          {group.emailCount} emails · {group.clusterCount} {group.clusterCount === 1 ? "cluster" : "clusters"}
        </span>
      </Text>
      {group.rows.map((row, i) => (
        <Text key={`${group.category}-${i}`}
          className={`text-[14px] text-gray-700 leading-[1.55] m-0 py-[6px] ${
            i > 0 ? "border-0 border-t border-solid border-black/5" : ""
          }`}>
          <span className="font-bold text-gray-900 mr-[6px]">{row.label}</span>
          {row.summary}
        </Text>
      ))}
    </Section>
  );
}
```

**Critical partial-border idiom** (`digest-v2.tsx:135`): every `border-t` / `border-l` MUST be paired with `border-0` companion class (memory `react_email_partial_borders`). Already present in template; Phase 10 must follow.

**Overlap pill pattern** (copy `digest-v2.tsx:126-129` colored-inline-span shape):
```tsx
<span className="font-medium text-gray-400 text-[12px] ml-[6px]">...</span>
```
Adapt to `bg-amber-100 text-amber-800 rounded px-[6px] py-[1px] text-[11px] font-semibold ml-[6px]` for the `[⚠ overlaps]` pill (D-09).

**Section insertion site** (current ordering — `digest-v2.tsx:178-241`):
- Narrative `Section` (line 179) → **INSERT AgendaSection here (D-01, between narrative and Urgent)** → Urgent (line 191) → Uncertain (line 211) → **INSERT CalendarActivitySection here (D-02, between Uncertain and auto-filed)** → autoFiled map (line 231).

Each new section follows the existing `<Section className="pt-[28px] px-[32px] pb-[4px]">` outer wrapper with a small-caps heading `<Text className="m-0 mb-[12px] text-[11px] font-bold tracking-[0.12em] uppercase text-gray-500">` (line 193, 213, 236).

**PreviewProps extension** — extend `digest-v2.tsx:282-395` to add sample `agenda` and `calendarActivity` so `render-digest-v2.ts` produces a Phase-10-shaped preview without code changes to the dev-loop script.

---

### `apps/web/utils/digest/agenda/overlap.ts` (NEW pure helper)

**Analog:** `apps/web/utils/calendar/reconciliation/match.ts` — `decideOutcome` (lines 1-82). Exact same shape: pure function taking domain objects + returning a structured verdict, no I/O, no Prisma, no Google client.

**Imports pattern** (copy `match.ts:1-2`):
```ts
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";
```
(or operate on `AgendaItem` once windowing has been applied — plan-phase decides; preferred is to detect overlaps on the windowed-and-converted list so all-day filtering D-08 is trivial.)

**Function signature pattern** (mirror `match.ts:27-33`):
```ts
export function detectOverlaps({
  items,
}: { items: AgendaItem[] }): Map<string, string[]>; // itemId -> overlapping sibling ids
```

**All-day branch pattern** (copy `match.ts:35-47` — branch on `isAllDay` first, then return early):
```ts
// D-08: all-day events never overlap. Skip them entirely.
const timed = items.filter((i) => !i.isAllDay);
```

**Decision-tree comment style** (copy `match.ts:4-19`):
```ts
/**
 * D-08 overlap rule: strict time-interval intersection.
 * Two timed events overlap iff [startA, endA) ∩ [startB, endB) ≠ ∅.
 * All-day events excluded. Back-to-back events (endA == startB) do NOT overlap.
 *
 * Pure helper — no Prisma, no Google client, no AI SDK.
 */
```

---

### `apps/web/utils/digest/agenda/window.ts` (NEW pure helper)

**Analog:** `apps/web/utils/calendar/upcoming-events-helpers.ts` (Phase 8 pure helpers — `isExcluded`, `normalize`, `pastPrune`).

**Critical date-string trap** (warning in `upcoming-events-types.ts:21-23`):
```ts
/**
 * RFC3339 timestamp for timed events; "YYYY-MM-DD" string when isAllDay is true.
 * Never wrap in `new Date()` without branching on isAllDay — see
 * 08-RESEARCH.md Pitfall 4 (UTC midnight shifts all-day dates by ~hours).
 */
```
The window filter MUST branch on `isAllDay` for date comparison. Match the pattern in `match.ts:34-47`.

**ET date pattern** (copy `today-et.ts:12-20`):
```ts
const ymd = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
return new Date(`${ymd}T00:00:00.000Z`);
```
Reuse `getTodayET()` directly for today's ET date anchor; derive tomorrow via `date-fns.addDays`.

---

### `apps/web/utils/digest/agenda/format-time.ts` (NEW pure helper)

**Analog:** `apps/web/utils/digest/today-et.ts` (lines 22-30 `formatTodayHumanET`) + `run-daily-digest.ts:308-313` (the existing ET time formatter).

**ET time format pattern** (copy `run-daily-digest.ts:308-313`):
```ts
new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
}).format(new Date())
```
This produces `"9:00 AM"`. Phase 10 post-processes to D-07 shape (`9:00a`) — strip space + collapse `AM`→`a` / `PM`→`p`. Single-letter marker is a string transform on top of the standard Intl output.

---

### `apps/web/utils/digest/calendar-activity/render-sentence.ts` (NEW pure helper)

**Analog:** `apps/web/utils/calendar/reconciliation/dice.ts` (pure, single-function, no imports outside the file).

**Pure-helper file shape** (copy `dice.ts:1-25`):
```ts
/**
 * D-11 sentence templates for Calendar Activity rows.
 *
 * - AMBIGUOUS → "{Sender}: looks like it's about {extractedTitle} — review →"
 * - CREATED   → "Added {extractedTitle} {day/time} to your calendar (from {sender}) →"
 * - MATCHED   → "{Sender} confirmed {extractedTitle} — already on your calendar"
 *
 * Pure — no I/O, no imports outside this file (allowed: type-only imports).
 */
export function renderSentence({
  outcome, sender, extractedTitle, extractedStart, isAllDay,
}: { ... }): string { ... }
```

**Day/time format for CREATED sentences** — open-question recommendation from RESEARCH.md (`Open Questions #3`): `"Mon at 9:00a"` (day-abbrev + agenda-style time). Reuse `format-time.ts` helper.

---

### `apps/web/utils/digest/calendar-activity/pick-link-target.ts` (NEW pure helper)

**Analog:** `apps/web/utils/calendar/reconciliation/match.ts` — same enum-returning, decision-tree shape.

**Function signature** (mirror `match.ts:27-33`):
```ts
export function pickLinkTarget({
  outcome,
  googleEventHtmlLink,
  threadId,
}: {
  outcome: "MATCHED" | "CREATED" | "AMBIGUOUS";
  googleEventHtmlLink: string | null;
  threadId: string;
}): string {
  // D-13: prefer googleEventHtmlLink for MATCHED+CREATED, fall back to Gmail thread URL.
  // AMBIGUOUS always goes to Gmail thread URL (no event was created).
  if (outcome !== "AMBIGUOUS" && googleEventHtmlLink) return googleEventHtmlLink;
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
}
```

---

### `apps/web/utils/digest/agenda/build-agenda.ts` + `calendar-activity/build-activity.ts` (NEW pure props builders)

**Analog:** the Phase 4 `buildActionItems` closure inside `run-daily-digest.ts:273-290`:
```ts
const buildActionItems = (
  bucket: SourceItem[],
  sonnetItems: Array<{ messageId: string; summary: string }>,
) =>
  sonnetItems.map((s) => {
    const src = bucket.find((b) => b.messageId === s.messageId);
    if (!src) return null;
    const senderMatch = /^(.*?)(?:\s*<([^>]+)>)?$/.exec(src.from);
    return {
      subject: src.subject,
      senderName: senderMatch?.[1]?.trim() || src.from,
      senderEmail: senderMatch?.[2],
      summary: s.summary,
      reviewUrl: `${reviewBase}/${src.itemId}`,
    };
  })
  .filter((x): x is NonNullable<typeof x> => x !== null);
```

Phase 10's `buildAgenda(events, now)` and `buildCalendarActivity(records, senderMap)` follow the same map → null-filter shape. **Difference:** they live in their own files (not closures) because they have non-trivial helpers (windowing, overlap detection, sentence rendering) — extracting keeps `run-daily-digest.ts` readable.

**Sender-name extraction** — reuse the same inline regex from `run-daily-digest.ts:281` (RESEARCH.md verified — Phase 4 uses inline regex, not `extractNameFromEmail`).

---

### `apps/web/utils/digest/run-daily-digest.ts` (MODIFY — add parallel fetches + new props)

**Analog:** itself. Phase 10 inserts a parallel fetch block before the existing `generateDigestContent` call (`run-daily-digest.ts:254`).

**Parallel-fetch pattern with failure isolation** (D-25/D-26 — copy the Phase 9 single-fetch idiom `apps/web/utils/calendar/reconciliation/index.ts:246` and scale to `Promise.allSettled`):
```ts
// Phase 9 idiom (single fetch):
const upcoming = await getUpcomingEvents({ emailAccountId, now, logger }).catch(() => []);
```
Apply at scale for Phase 10:
```ts
const [eventsR, reconciliationsR] = await Promise.allSettled([
  getUpcomingEvents({ emailAccountId: account.id, now: new Date(), logger: scoped }),
  prisma.reconciliationRecord.findMany({
    where: {
      emailAccountId: account.id,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      outcome: { in: ["MATCHED", "CREATED", "AMBIGUOUS"] },
    },
    orderBy: { extractedStart: "asc" },
  }),
]);
const events = eventsR.status === "fulfilled" ? eventsR.value : [];
const reconciliations = reconciliationsR.status === "fulfilled" ? reconciliationsR.value : [];
if (eventsR.status === "rejected") scoped.warn("agenda.fetch.failed", { error: String(eventsR.reason) });
if (reconciliationsR.status === "rejected") scoped.warn("reconciliations.fetch.failed", { error: String(reconciliationsR.reason) });
```

**Sender lookup for reconciliations** — RESEARCH.md Option A (batch Gmail fetch). Reuse `emailProvider.getMessagesBatch` already built at `run-daily-digest.ts:212`. Single extra batch call for messageIds drawn from the reconciliation rows that aren't already in `messageMap`.

**Logging discipline** — match Phase 4 / Phase 9 structured-fields-only style (Phase 8 D-09, Phase 9 T-09-05): `emailAccountId`, `recordId`, `error.message`. Never `extractedTitle`, `extractedLocation`, event details.

**Props composition** (extend existing `run-daily-digest.ts:305-319`):
```ts
const props: DigestV2Props = {
  ...existingFields,
  agenda: buildAgenda(events, new Date()),
  calendarActivity: buildCalendarActivity(reconciliations, senderMap),
};
```

---

### `apps/web/utils/ai/digest/digest-prompt.ts` (MODIFY — append AGENDA + RECONCILIATIONS blocks)

**Analog:** itself — `renderBucket` (lines 55-62) + `buildDigestPrompt` (lines 64-83).

**Prompt-extension pattern** (copy `renderBucket` shape):
```ts
function renderAgenda(agenda: AgendaCompact[]): string {
  if (!agenda.length) return "### AGENDA\n(nothing on the calendar)\n";
  return `### AGENDA\n${agenda.map(a => `- ${a.time} ${a.title}`).join("\n")}\n`;
}
function renderReconciliations(records: ReconciliationCompact[]): string {
  if (!records.length) return "### RECONCILIATIONS\n(none in the last 24h)\n";
  return `### RECONCILIATIONS\n${records.map(r => `- [${r.outcome}] ${r.title} — ${r.sender}`).join("\n")}\n`;
}
```

**System-prompt extension** (append to `DIGEST_SYSTEM_PROMPT`, line 1-37, before final `Output JSON...` line):
```
AGENDA + RECONCILIATIONS HANDLING (D-22 hard rule)
- Only reference events / reconciliations present in the AGENDA and RECONCILIATIONS blocks.
- Do not infer, summarize counts you can't see, or extrapolate.
- Weave 1-2 references in naturally if they fit the morning's narrative; never enumerate them.
- Voice guardrails (the death/distress/legal/medical list above) apply to AGENDA and RECONCILIATIONS content too.
```

**Builder extension** (extend `buildDigestPrompt:71-82` array):
```ts
return [
  `Today's date: ${todayDate}.`,
  "",
  renderAgenda(agenda),
  renderReconciliations(reconciliations),
  "",
  "Below are the emails to summarize...",
  ...existingBuckets,
].join("\n");
```

---

### Test files (7 NEW) — `*.test.ts` fixture-table pattern

**Analog:** `apps/web/utils/calendar/reconciliation/match.test.ts` (lines 1-82+).

**Test file boilerplate** (copy `match.test.ts:1-43`):
```ts
import { describe, it, expect } from "vitest";
import { decideOutcome } from "./match";
import type { NormalizedCalendarEvent } from "@/utils/calendar/upcoming-events-types";

const timed = (id, title, startISO, endISO): NormalizedCalendarEvent => ({
  id, title, description: null, location: null,
  start: startISO, end: endISO, isAllDay: false, attendees: [], htmlLink: "",
});
const allDay = (id, title, date): NormalizedCalendarEvent => ({
  id, title, description: null, location: null,
  start: date, end: date, isAllDay: true, attendees: [], htmlLink: "",
});

describe("decideOutcome — D-06 four-step decision tree", () => {
  it("step 1: returns MATCHED when ...", () => { ... });
  it("step 2: returns AMBIGUOUS (reschedule, REC-06) when ...", () => { ... });
  // ...
});
```

**Test-name convention:** `"<step/branch>: <expected outcome> when <condition>"`. Each decision-tree branch gets its own `it()`. Phase 10 tests mirror this — one `it()` per agenda fallback branch (D-05), one per overlap rule (D-08 strict intersection, all-day excluded, back-to-back not overlap), one per sentence template (D-11), one per link-target branch (D-13).

---

## Shared Patterns

### Pattern S1 — Pure-Function + Props-Builder + Dumb-Component Split

**Source:** Phase 4 (`run-daily-digest.ts` orchestrator + `digest-v2.tsx` dumb component) + Phase 9 (`match.ts` / `dice.ts` pure helpers + `index.ts` orchestrator).

**Apply to:** every Phase 10 sub-feature. Pure helpers do the computation, the props builder in `run-daily-digest.ts` orchestrates I/O + composes typed props, the React Email component is dumb.

### Pattern S2 — Failure-Isolation via try/catch + Degrade-Gracefully

**Source:** `apps/web/utils/calendar/reconciliation/index.ts:246` (`getUpcomingEvents(...).catch(() => [])`) + `run-daily-digest.ts:367-381` (outer try/catch on the whole account loop).

**Apply to:** Phase 10's two new fetches inside `run-daily-digest.ts`. Per-fetch wrapping via `Promise.allSettled` so a single failed branch only nulls out its own block.

### Pattern S3 — Structured-Fields-Only Logging on Error Paths

**Source:** Phase 8 D-09 + Phase 9 T-09-05 (`persist.ts:38-41` doc comment).

**Apply to:** every `logger.warn` / `logger.error` introduced in Phase 10. Allowed keys: `emailAccountId`, `recordId`, `messageId`, `error.message`. Forbidden: `extractedTitle`, `extractedLocation`, `extractedAttendees`, raw body, event description, subject.

### Pattern S4 — Tailwind Partial-Border Companion-Class Discipline

**Source:** memory `react_email_partial_borders` + `digest-v2.tsx:135` (`border-0 border-t border-solid border-black/5`) + `digest-v2.tsx:203` (`border-0 border-t border-solid border-gray-100`).

**Apply to:** every new sub-component using `border-t`, `border-l-*`, etc. Pair with `border-0` companion class or Gmail renders default ~3px borders on the other three sides.

### Pattern S5 — All-Day Date-String Branch Discipline

**Source:** `upcoming-events-types.ts:21-23` docstring + `match.ts:34-47`.

**Apply to:** `window.ts`, `overlap.ts`, `format-time.ts`, `render-sentence.ts`. Never `new Date(event.start)` without `if (event.isAllDay)` branch — UTC midnight shifts the date in ET.

### Pattern S6 — ET Date / Time via `Intl.DateTimeFormat`

**Source:** `apps/web/utils/digest/today-et.ts` (`getTodayET`, `formatTodayHumanET`) + `run-daily-digest.ts:308-313`.

**Apply to:** `window.ts` (reuse `getTodayET()`), `format-time.ts` (reuse `Intl.DateTimeFormat` pattern). DST handled by `Intl` — do not hand-roll DST math.

### Pattern S7 — Section Insertion in `digest-v2.tsx`

**Source:** `digest-v2.tsx:191-241` (existing Urgent / Uncertain / autoFiled sections).

**Apply to:** AgendaSection + CalendarActivitySection. Outer wrapper `<Section className="pt-[28px] px-[32px] pb-[4px]">` + small-caps heading `<Text className="m-0 mb-[12px] text-[11px] font-bold tracking-[0.12em] uppercase text-gray-500">` matches Phase 4 visual contract.

## No Analog Found

None. Every new file has a strong analog inside the repo (Phase 4 for orchestration + props-build + render, Phase 8 for date-string discipline, Phase 9 for pure-helper file shape + decision-tree + parallel-fetch + Prisma idempotency).

## Metadata

**Analog search scope:**
- `apps/web/utils/digest/**` (Phase 4)
- `apps/web/utils/calendar/**` (Phase 8 + 9)
- `apps/web/utils/ai/digest/**` (Phase 4 Sonnet path)
- `packages/resend/emails/**` (Phase 4 template)
- `packages/resend/__tests__/**` (Phase 4 snapshot test)

**Files read in full or in targeted ranges:**
- `packages/resend/emails/digest-v2.tsx` (full, 396 lines)
- `apps/web/utils/digest/run-daily-digest.ts` (full, 386 lines)
- `apps/web/utils/ai/digest/digest-prompt.ts` (full, 84 lines)
- `apps/web/utils/ai/digest/generate-digest-content.ts` (full, 57 lines)
- `apps/web/utils/digest/today-et.ts` (full, 30 lines)
- `apps/web/utils/calendar/reconciliation/match.ts` (full, 82 lines)
- `apps/web/utils/calendar/reconciliation/match.test.ts` (lines 1-80)
- `apps/web/utils/calendar/reconciliation/dice.ts` (full, 25 lines)
- `apps/web/utils/calendar/reconciliation/persist.ts` (lines 1-50)
- `apps/web/utils/calendar/reconciliation/index.ts` (lines 1-80)
- `apps/web/utils/calendar/upcoming-events-types.ts` (full, 56 lines)
- `apps/web/prisma/schema.prisma` (ReconciliationRecord model, lines 898-935)
- `packages/resend/__tests__/digest-v2.test.tsx` (lines 1-40)

**Pattern extraction date:** 2026-05-23
