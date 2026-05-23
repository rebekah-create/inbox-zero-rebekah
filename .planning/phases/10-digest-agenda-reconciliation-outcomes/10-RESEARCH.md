# Phase 10: Digest Agenda + Reconciliation Outcomes — Research

**Researched:** 2026-05-23
**Domain:** React Email rendering + Sonnet prompt extension + pure data transformation
**Confidence:** HIGH (every code path verified against live source)

## Summary

Phase 10 is a pure render-and-prompt-input extension on top of fully shipped Phase 4/8/9 infrastructure. The digest send pipeline, the visual template, the calendar read path, and the reconciliation persistence layer all exist and were located by direct file read. There is **no architectural unknown** — every "where does X live?" open question from CONTEXT.md is answered concretely below. The only real engineering work is (1) extending `DigestV2Props` + the React Email component in place, (2) two pure transformers (agenda windowing + per-day overlap detection, both fixture-table testable), (3) wiring a parallel `Promise.all` data fetch into `runDailyDigest`, and (4) appending two context blocks to the existing Sonnet prompt with a hard "do not invent" guardrail.

**Primary recommendation:** Treat this as a 5-wave plan: (Wave 0) tests scaffolded for the two pure helpers + props builder; (Wave 1) pure transformers (overlap detector + agenda windowing + sentence renderers); (Wave 2) props-builder that calls `getUpcomingEvents` + the reconciliation Prisma query in parallel with try/catch isolation; (Wave 3) extend `DigestV2Props` + add `AgendaSection.tsx` + `CalendarActivitySection.tsx`; (Wave 4) extend `digest-prompt.ts` with AGENDA + RECONCILIATIONS blocks + measure token delta against a real fixture via `render-digest-v2.ts`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (D-01..D-26)

**Layout & placement:**
- **D-01** Agenda renders between narrative and Urgent.
- **D-02** Calendar Activity renders as its own section between Uncertain and the auto-filed roll-ups, with a neutral/teal palette distinct from the four auto-filed colors.
- **D-03** `DigestV2Props` is extended (not forked). New fields: `agenda: AgendaBlock` and `calendarActivity: CalendarActivityBlock | null`. Backwards-compatible when both absent.

**Agenda block:**
- **D-04** Two sub-sections: Today (`digestSendTime` 9am ET → midnight ET; past-ending events excluded) + Tomorrow morning (6am ET → 12pm ET next calendar day).
- **D-05** Empty-day fallback copy (locked verbatim — see CONTEXT). Voice matches narrative tone. Never say "0 events" / "empty calendar".
- **D-06** Per-event row schema: `{ time, endTime, title, location, isAllDay, overlapWith }`. All-day events render at top of day with label `"All day"`. End times only when present and not equal to start.
- **D-07** Time format: 12-hour with single-letter am/pm (`9:00a`, `2:30p`). Crossing midnight: `"9:00p–12:30a"` + `"(tonight)"` suffix.

**Overlap semantics:**
- **D-08** Strict time-interval intersection (`[startA, endA) ∩ [startB, endB) ≠ ∅`). All-day events excluded. Back-to-back ≠ overlap.
- **D-09** Inline pill `[⚠ overlaps]` (email-safe span, amber bg) on each overlapping row.
- **D-10** Per-day only. No cross-day overlap detection.

**Calendar Activity (DIG-05):**
- **D-11** Single section grouped by outcome in fixed order: Review → Added → Confirmed. Sentence templates LOCKED verbatim (see CONTEXT D-11).
- **D-12** Hide empty sub-headings; hide whole section if all three empty. No "0 items" placeholder.
- **D-13** Source link target: `googleEventHtmlLink` for MATCHED/CREATED; Gmail thread URL (`https://mail.google.com/mail/u/0/#inbox/{threadId}`) for AMBIGUOUS. Fall back to Gmail thread URL when `googleEventHtmlLink` is null.
- **D-14** Ordering: chronological by `extractedStart` ascending within each sub-heading.
- **D-15** 24h window: `ReconciliationRecord.createdAt >= now() - 24h` (wall-clock, NOT since-last-send).
- **D-16** Exclude `FAILED` and `PENDING` outcomes from digest entirely.
- **D-17** Sender name: reuse the accessor that Phase 4's `ActionItemCard` uses for `senderName` (see Code Examples below — the from-header regex split).
- **D-18** Teal/slate palette. Sub-headings (Review/Added/Confirmed) inside a single bordered card, NOT three cards.

**Sonnet narrative integration:**
- **D-19** Narrative receives two new compact context blocks: AGENDA (`[time, title]` per event) + RECONCILIATIONS (`[outcome, title, sender]` per record). Sonnet "weaves naturally, never enumerates, never duplicates verbatim."
- **D-20** Token-delta budget: ≤+1000 tokens/digest, target +500 average. Plan-phase measures against a real digest.
- **D-21** Voice guardrails inherit Phase 4 (humor drop for grief/illness/legal/distress). Agenda + reconciliation content is scanned by the same rule.
- **D-22** Hard prompt rule: "Only reference events / reconciliations present in the AGENDA and RECONCILIATIONS blocks. Do not infer, summarize counts, or extrapolate." Prevents hallucinated agenda items.

**Data plumbing:**
- **D-23** Agenda + reconciliation fetches happen in the digest send pipeline (see "Where Phase 4 Landed" below — confirmed: `apps/web/utils/digest/run-daily-digest.ts`).
- **D-24** Reconciliation query: `prisma.reconciliationRecord.findMany({ where: { emailAccountId, createdAt: { gte: now - 24h }, outcome: { in: ['MATCHED', 'CREATED', 'AMBIGUOUS'] } }, orderBy: { extractedStart: 'asc' } })`. Uses the existing `(emailAccountId, createdAt DESC)` index.
- **D-25** Both fetches in parallel (`Promise.all`). Graceful degradation per branch.
- **D-26** Failure isolation — wrap each fetch in try/catch; digest still sends.

### Claude's Discretion
- Exact `DigestV2Props` field names — `agenda` / `calendarActivity` is the working name.
- File layout: split into `AgendaSection.tsx` + `CalendarActivitySection.tsx` vs. keep inline.
- Exact Tailwind palette for Calendar Activity (teal/slate working direction).
- Exact wording of new AGENDA / RECONCILIATIONS prompt blocks + "do not invent" instruction.
- Fixture for visual review during plan-phase (extend `PreviewProps`).
- Test pattern for overlap detection — fixture-table style, same shape as Phase 9's `decideOutcome` tests.

### Deferred Ideas (OUT OF SCOPE)
- AMBIGUOUS-review UI inside `inbox.tdfurn.com`.
- Full 7-day agenda view.
- Same-day overlap push/SMS alert.
- Cross-day overlap detection.
- Surfacing FAILED/PENDING reconciliations.
- Per-event quick actions (snooze, link, note).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DIG-01 | 9am digest opens with "Today" section (9am ET → midnight ET) | `getUpcomingEvents` returns NormalizedCalendarEvent[]; filter by `start >= now ∧ start < endOfDayET`; render under new AgendaSection between narrative + Urgent (D-01) |
| DIG-02 | "Tomorrow" section showing 6am–noon next day | Same data source; filter by tomorrow-ET window |
| DIG-03 | Each agenda item shows start, end, title, location, conflict indicator on overlap | Per-event schema D-06; overlap detection D-08 pure function; inline `[⚠ overlaps]` pill D-09 |
| DIG-04 | Empty days render friendly fallback ("Nothing on the calendar today") | D-05 locked copy per branch; rendered inline in AgendaSection |
| DIG-05 | Per reconciliation in last 24h, one-line outcome with sentence shapes for MATCHED/CREATED/AMBIGUOUS + source-email link | Reconciliation Prisma query D-24; sentence renderers D-11; link target rules D-13 |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Calendar event fetch | API/Backend | Redis cache | Cached read path lives in `apps/web/utils/calendar/upcoming-events.ts`; runs server-side at digest send time |
| Reconciliation record fetch | API/Backend (Prisma) | — | Single Prisma query against `ReconciliationRecord` table |
| Agenda windowing transform | API/Backend (pure fn) | — | Pure function on `NormalizedCalendarEvent[]` → `AgendaItem[]` per day, no I/O |
| Overlap detection | API/Backend (pure fn) | — | Pure function on `AgendaItem[]` returning overlap edges; per-day scope (D-10) |
| Sentence rendering (Review/Added/Confirmed) | API/Backend (pure fn) | — | Pure transform of `ReconciliationRecord` → display row; sender-name accessor + link-target selector |
| Sonnet narrative generation | API/Backend (LLM call) | — | Existing `generateDigestContent` in `apps/web/utils/ai/digest/generate-digest-content.ts`; receives extended prompt input |
| Email render | Backend (React Email) | Resend SDK | `DigestV2Email` component rendered to HTML in `packages/resend/src/send.tsx#sendDigestV2Email`; Gmail receives static HTML |
| Visual fixture preview | Local dev script | — | `packages/resend/scripts/render-digest-v2.ts` renders PreviewProps to `.planning/phases/04-daily-digest/digest-v2-rendered.html` |

## Where Phase 4 Actually Landed (open-question #1 answered)

The Phase 4 CONTEXT noted "rewrite-in-place vs new route" was undecided. **Resolved by direct file read:**

| Concern | Live location |
|---------|---------------|
| Digest send orchestrator | `apps/web/utils/digest/run-daily-digest.ts` — `runDailyDigest(logger)` function |
| Cron entry point | `apps/web/app/api/cron/digest/route.ts` |
| Sonnet narrative builder | `apps/web/utils/ai/digest/generate-digest-content.ts` — `generateDigestContent({ emailAccount, todayDate, bucketed })` |
| Sonnet prompt | `apps/web/utils/ai/digest/digest-prompt.ts` — `DIGEST_SYSTEM_PROMPT` + `buildDigestPrompt({ todayDate, bucketed })` |
| Sonnet output schema | `apps/web/utils/ai/digest/digest-schema.ts` — `digestContentSchema` zod object |
| Visual template | `packages/resend/emails/digest-v2.tsx` — exports `DigestV2Email`, `DigestV2Props`, `ActionItem`, `AutoFiledGroup`, `AutoFiledRow` |
| Send wrapper | `packages/resend/src/send.tsx` — `sendDigestV2Email({ from, to, emailProps, subject })` |
| Render-to-static helper | `packages/resend/scripts/render-digest-v2.ts` — writes `digest-v2-rendered.html` from `PreviewProps` |
| One-shot Resend send helper | `packages/resend/scripts/send-digest-v2-test.ts` |
| Upstream legacy route (LEFT ALONE) | `apps/web/app/api/resend/digest/route.ts` — **do not modify**; it still uses upstream `sendDigestEmail` (digest.tsx, not digest-v2) |

**Key insight:** `runDailyDigest` is where new data fetches land — it already calls `generateDigestContent`, builds the `DigestV2Props`, and calls `sendDigestV2Email`. Phase 10 adds: (1) two parallel fetches before the `generateDigestContent` call (so the prompt can include them); (2) builds `agenda` and `calendarActivity` props alongside the existing builders; (3) passes both into `props`.

## Marketing/Calendar Double-Count (open-question #2 answered)

**Verdict: NO double-count risk.** Confirmed by reading `runDailyDigest.bucketForRule`:

```ts
const BUCKET_BY_SYSTEM_TYPE: Partial<Record<SystemType, BucketKey>> = {
  [SystemType.RECEIPT]: "receipts",
  [SystemType.NEWSLETTER]: "newsletters",
  [SystemType.MARKETING]: "marketing",
  [SystemType.NOTIFICATION]: "notifications",
};
```

`SystemType.CALENDAR` is **not** in the bucket map. Calendar-classified emails fall through the `if (!bucket) continue;` guard and never enter any of the six body buckets. Their *reconciliation* outcome surfaces in the new Calendar Activity section; the source email itself never appears as a DigestItem row. No deduplication code needed.

## saveAiUsage Token Capture (open-question #3 answered)

`apps/web/utils/usage.ts#saveAiUsage` already publishes to Tinybird with `promptTokens`, `completionTokens`, `cachedInputTokens` per call. The existing `generateDigestContent` → `createGenerateObject` call routes through this stream automatically. To measure Phase 10's delta:

1. **Before merge:** Render the current digest against a real-inbox fixture; capture `promptTokens` from the Tinybird stream (or log it locally for one run).
2. **After Phase 10 changes:** Same fixture, same emails, but with AGENDA + RECONCILIATIONS blocks injected. Capture again.
3. **Delta gate:** Reject if delta > 1000 input tokens (D-20 budget). At Sonnet pricing (~$3/M input tokens), 1000 tokens × 30 digests/month = ~$0.09/mo.

No new instrumentation needed — this is observation against an existing log stream.

## Email-Safe Pill Rendering (open-question #4 answered)

Phase 4's `digest-v2.tsx` already proves the pattern works. Three live examples in the live template:

1. **Inline span with colored bg + tracking** — see line 126-129 (the `{group.emailCount} emails · {group.clusterCount} clusters` counter):
   ```tsx
   <span className="font-medium text-gray-400 text-[12px] ml-[6px]">
     {group.emailCount} emails · {group.clusterCount} cluster
   </span>
   ```

2. **Bordered colored card with `border-l-[4px]`** — see line 84 (urgent card):
   ```tsx
   className="border-l-[4px] border-l-red-400 bg-red-50 rounded-[3px] py-[14px] px-[16px]"
   ```

3. **Inline color-tinted heading** — line 122 with explicit color class.

**For the `[⚠ overlaps]` pill:** Use the same idiom — small `<span>` with `bg-amber-100 text-amber-800` + `rounded` + small `px-[6px] py-[1px] text-[11px] font-semibold ml-[6px]`. Email-safe because:
- React Email Tailwind plugin compiles to inline styles (Gmail-safe).
- No `display: flex` / grid (Outlook would break).
- No CSS variables.
- Single-color background (no gradients).

**Critical reminder from memory note `react_email_partial_borders`:** Any partial-side border (`border-t`, `border-l`) MUST be paired with `border-0` companion class in `<Tailwind>`, or Gmail renders default ~3px borders on the other sides. Already seen in the live template at line 135 (`border-0 border-t border-solid border-black/5`) and line 203 (`border-0 border-t border-solid border-gray-100`).

## getUpcomingEvents Contract (open-question #5 answered)

Confirmed signature from `apps/web/utils/calendar/upcoming-events.ts`:

```ts
export async function getUpcomingEvents({
  emailAccountId: string,
  now: Date,
  logger: Logger,
}): Promise<NormalizedCalendarEvent[]>
```

**Return type** (`apps/web/utils/calendar/upcoming-events-types.ts`):

```ts
interface NormalizedCalendarEvent {
  id: string;
  title: string;        // defaults to "Untitled"
  start: string;        // RFC3339 timed event OR "YYYY-MM-DD" all-day
  end: string;          // RFC3339 timed event OR "YYYY-MM-DD" all-day
  isAllDay: boolean;
  location: string | null;
  description: string | null;
  attendees: string[];
  htmlLink: string;     // "" if missing
}
```

**Critical trap (called out in the type's own docstring):** `start`/`end` for all-day events are date-only strings — **never `new Date(start)` without branching on `isAllDay`**, or UTC midnight will shift the date by ~hours in ET. This affects the agenda windowing transformer.

**Error shape:** Never throws — `try/catch` inside the function returns `[]` on cold-cache + API failure, or stale envelope data on warm-cache + API failure (logs `warn` with structured fields). Phase 10 can call it without try/catch (per Phase 9's `reconcileMessage` pattern at line 246: `.catch(() => [])`) — but D-26 still requires the outer try/catch so an unexpected throw doesn't kill the digest.

## Sender-Name Extraction (open-question #6 answered)

Phase 4 uses **inline regex split**, not a helper, in `runDailyDigest.buildActionItems` (line 281):

```ts
const senderMatch = /^(.*?)(?:\s*<([^>]+)>)?$/.exec(src.from);
return {
  subject: src.subject,
  senderName: senderMatch?.[1]?.trim() || src.from,
  senderEmail: senderMatch?.[2],
  // ...
};
```

There is **also** an existing helper at `apps/web/utils/email.ts`:

```ts
export function extractNameFromEmail(email: string) {
  if (!email) return "";
  const firstPart = email.split("<")[0]?.trim();
  if (firstPart) return firstPart;
  const secondPart = email.split("<")?.[1]?.trim();
  if (secondPart) return secondPart.split(">")[0];
  return email;
}
```

The legacy `apps/web/app/api/resend/digest/route.ts` uses `extractNameFromEmail`; the live `runDailyDigest` does not. For Phase 10 consistency, **reuse the regex inline in `runDailyDigest` for Calendar Activity rows** (matches existing style in same file). Sender name comes from a separate fetch — see "Reconciliation → Sender Name Lookup" below.

### Reconciliation → Sender Name Lookup

`ReconciliationRecord` does **NOT** persist sender name or sender email — it only has `messageId` + `threadId`. To render `{Sender}` in D-11 sentence templates, the props builder must fetch the source message's `from` header. Options:

| Option | Approach | Cost |
|--------|----------|------|
| **A — Batch Gmail fetch** | After Prisma query, batch-fetch messages by ID using the same `emailProvider.getMessagesBatch` as `runDailyDigest` already uses (line 212), then split `from` header | One extra Gmail batch call per digest. At 1–3 reconciliations/day, trivial. |
| **B — Add senderEmail/senderName to ReconciliationRecord** | Schema change, backfill | Migration cost, more invasive. Not justified for v1.1. |
| **C — Reuse messageMap already built** | Inbox emails being digested already have their `from` headers in `messageMap` (line 216). Reconciliation messages may or may not overlap with digested messages. | Free for the overlap case; option A for the non-overlap case. |

**Recommendation: Option A.** Single batch fetch, parse `from` with the same regex. Plan-phase confirms — Option C is an optimization, not a primitive. Keep the simple path.

## Render/Preview Dev Loop (open-question #7 answered)

Confirmed: `packages/resend/scripts/render-digest-v2.ts` reads `DigestV2Email.PreviewProps` and writes static HTML to `.planning/phases/04-daily-digest/digest-v2-rendered.html`. **Still the dev loop.** Phase 10 extends `PreviewProps` with sample `agenda` + `calendarActivity` fixture data so a single run of:

```bash
pnpm --filter @inboxzero/resend tsx scripts/render-digest-v2.ts
```

produces a Phase-10-shaped preview ready for visual review. Open the output HTML in a browser to validate the visual contract.

`send-digest-v2-test.ts` remains the end-to-end Gmail-rendering check (sends the PreviewProps to `TEST_TO` via real Resend). **Use this before merge** to verify the `[⚠ overlaps]` pill survives Gmail CSS stripping (CONTEXT open question #6).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@react-email/components` | already in use | Email-safe component primitives (`Section`, `Text`, `Link`, `Tailwind`) | Already the Phase 4 template's entire layer; no new dep |
| `react` | already in use | Component model | Already in repo |
| `@inboxzero/resend` (internal package) | local | Exports `sendDigestV2Email` + `DigestV2Email` | Existing wrapper; extend in place |
| Anthropic SDK via `ai` package (`createGenerateObject`) | already in use | Sonnet call for narrative | Already the Phase 4 path; Phase 10 only extends prompt text |
| Prisma | already in use | `reconciliationRecord.findMany` | Existing client; no schema change |
| `date-fns` | already in use (Phase 8 `getUpcomingEvents` imports `addDays`) | Date arithmetic for window boundaries | Already a dep |
| `Intl.DateTimeFormat` | Node built-in | ET timezone handling | Already used in `runDailyDigest` line 308 for `sentTime`; pattern locked |

### No new dependencies required
This phase introduces zero new packages. All work is pure TypeScript + existing libraries.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline regex for from-header parsing | `extractNameFromEmail` helper | Helper is more readable but `runDailyDigest` already uses regex inline; consistency wins |
| Pure function for overlap | Interval tree | O(n²) trivially handles 1–3 events/day; tree is over-engineering |
| Computing tomorrow date with `date-fns.addDays` | Manual `Date` arithmetic | `date-fns` already imported in `upcoming-events.ts`; reuse |

**No installation step required — Package Legitimacy Audit not applicable.**

## Architecture Patterns

### System Architecture Diagram

```
Cron (9am ET)
  │
  ▼
/api/cron/digest  ─►  runDailyDigest(logger)
                          │
                          ├─► [Phase 4 existing] DigestItem query + Gmail batch + bucketing
                          │
                          ├─► [NEW Phase 10] Promise.all([
                          │       getUpcomingEvents({ emailAccountId, now, logger })  ──► Redis cache → Google Calendar
                          │       prisma.reconciliationRecord.findMany({ last 24h, MATCHED|CREATED|AMBIGUOUS })
                          │     ])
                          │     │
                          │     ├─► [NEW pure fn] buildAgenda(events, now)
                          │     │       │
                          │     │       ├─► windowToday(events, sendTimeET, endOfDayET)
                          │     │       ├─► windowTomorrowMorning(events, 6am-noon next day ET)
                          │     │       ├─► detectOverlaps(items)  ── per-day, timed-only
                          │     │       └─► applyEmptyFallback(items, branch)
                          │     │
                          │     └─► [NEW pure fn] buildCalendarActivity(records, messageMap)
                          │             │
                          │             ├─► groupByOutcome → Review/Added/Confirmed
                          │             ├─► sortByExtractedStart asc
                          │             ├─► renderSentence(record, sender) per row
                          │             └─► pickLinkTarget(record) → googleEventHtmlLink || gmailThreadUrl
                          │
                          ├─► generateDigestContent({ ..., agendaSummary, reconciliationsSummary })
                          │     └─► Sonnet call with EXTENDED prompt (AGENDA + RECONCILIATIONS context blocks)
                          │
                          ├─► Build DigestV2Props { ...existing, agenda, calendarActivity }
                          │
                          └─► sendDigestV2Email({ emailProps })
                                └─► React Email render → Resend SDK → Gmail
```

### Recommended Project Structure
```
apps/web/utils/digest/
├── run-daily-digest.ts           # MODIFIED: add parallel fetches + new props
├── agenda/                       # NEW
│   ├── build-agenda.ts           # pure: events → AgendaBlock
│   ├── window.ts                 # pure: today/tomorrow ET filters
│   ├── overlap.ts                # pure: per-day overlap detection
│   ├── format-time.ts            # pure: ISO → "9:00a"
│   └── *.test.ts                 # fixture-table tests
└── calendar-activity/            # NEW
    ├── build-activity.ts         # pure: records + sender map → CalendarActivityBlock
    ├── render-sentence.ts        # pure: D-11 sentence templates
    ├── pick-link-target.ts       # pure: D-13 link selection
    └── *.test.ts

apps/web/utils/ai/digest/
└── digest-prompt.ts              # MODIFIED: append AGENDA + RECONCILIATIONS blocks

packages/resend/emails/
└── digest-v2.tsx                 # MODIFIED in place: extend DigestV2Props, add 2 sub-components

packages/resend/scripts/
└── render-digest-v2.ts           # NO CHANGE; consumes extended PreviewProps automatically
```

### Pattern 1: Pure-Function + Props-Builder + Dumb-Component Split
**What:** Match the Phase 4 / Phase 9 idiom — pure helpers compute everything, the props builder orchestrates I/O + composes the data into typed props, and the React Email component is a dumb renderer.

**When to use:** Every Phase 10 sub-feature.

**Example (from Phase 9 `decideOutcome`):**
```ts
// Pure: deterministic, fixture-table testable
export function decideOutcome({ candidate, existingEvents }: { ... }): { outcome, matchedEventId } { ... }
```

Apply identically: `detectOverlaps(items)`, `renderSentence(record, sender)`, `pickLinkTarget(record)`.

### Pattern 2: Failure-Isolation via try/catch + Degrade-Gracefully
**What:** Each new data fetch is independently wrapped; either failure renders an empty-block fallback. Digest still sends.

**When to use:** Both new fetches in `runDailyDigest`.

**Example (Phase 9 line 246 — `getUpcomingEvents` inside `reconcileMessage`):**
```ts
const upcoming = await getUpcomingEvents({ emailAccountId, now, logger }).catch(() => []);
```

Apply same shape to Phase 10:
```ts
const [eventsResult, reconciliationsResult] = await Promise.allSettled([
  getUpcomingEvents({ emailAccountId, now, logger }),
  prisma.reconciliationRecord.findMany({ /* D-24 query */ }),
]);
const events = eventsResult.status === "fulfilled" ? eventsResult.value : [];
const reconciliations = reconciliationsResult.status === "fulfilled" ? reconciliationsResult.value : [];
```

### Pattern 3: Re-entrant Sonnet Prompt Extension
**What:** `DIGEST_SYSTEM_PROMPT` and `buildDigestPrompt` are pure strings + a string-builder. Phase 10 appends new sections to both without restructuring.

**When to use:** Sonnet prompt edits (D-19, D-22).

**Example (current `buildDigestPrompt`):**
```ts
return [
  `Today's date: ${todayDate}.`,
  "",
  "Below are the emails to summarize, grouped by their classification bucket. ...",
  "",
  renderBucket("URGENT", bucketed.urgent),
  // ... etc
].join("\n");
```

Phase 10 adds two more `renderBucket`-shaped helpers — `renderAgenda(agenda)` and `renderReconciliations(records)` — and a `DO NOT INVENT` instruction at the end of `DIGEST_SYSTEM_PROMPT`.

### Anti-Patterns to Avoid
- **Building cross-day overlap logic** — D-10 locks per-day only. Don't be clever.
- **Forking `digest-v2.tsx`** — D-03 mandates in-place extension. The legacy `digest.tsx` is upstream code; don't touch it.
- **Calling Google Calendar directly** — Always `getUpcomingEvents`. Cache is non-negotiable (CAL-03).
- **Treating `start`/`end` strings as ISO unconditionally** — All-day events return date-only strings. Always branch on `isAllDay` before `new Date()`.
- **Wrapping the whole `runDailyDigest` in one try/catch** — Per-fetch isolation (D-26). One failed fetch degrades that block only.
- **Adding senderEmail/senderName columns to ReconciliationRecord** — Avoid schema churn for v1.1; batch Gmail fetch is fine for personal volume.
- **Building an interval tree for overlap detection** — n=1–3 events/day, O(n²) is fine; tests stay readable.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Date arithmetic for window boundaries | Custom `Date` math | `date-fns.addDays` + `Intl.DateTimeFormat` (already in `today-et.ts`) | TZ handling around DST is treacherous; existing helpers are battle-tested |
| Email-safe HTML primitives | Raw `<table>` / inline styles | `@react-email/components` | Already the template's entire layer; Gmail/Outlook compatibility solved |
| Tailwind → inline-style compilation | Hand-converted CSS | `<Tailwind>` from React Email | The whole `digest-v2.tsx` already uses it |
| From-header parsing | New regex | The existing line-281 regex in `runDailyDigest` (or `extractNameFromEmail` helper) | Both work; pick one |
| Sonnet structured output | Hand-written JSON parsing | `createGenerateObject` + Zod schema (already used by `generateDigestContent`) | Pattern locked since Phase 4 |
| Token usage logging | Custom logger | Existing `saveAiUsage` via `createGenerateObject` | Automatic; nothing to do |

**Key insight:** Every primitive Phase 10 needs already exists in the repo. The work is composition + new render branches, not new infrastructure.

## Runtime State Inventory

Phase 10 is a **pure render-layer extension** — no renames, no migrations, no data backfill, no service config changes.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no schema changes, no new tables, no data migration | None |
| Live service config | None — no SSM Parameter Store keys added, no cron schedule changes (9am ET cron already fires), no Resend dashboard changes | None |
| OS-registered state | None — no systemd unit additions, no new cron entries (`deploy/inbox-zero-digest.timer` already fires `runDailyDigest`) | None |
| Secrets/env vars | None — `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `DATABASE_URL` all in place | None |
| Build artifacts | None — extending `DigestV2Props` is a typed-export change, but `digest-v2.tsx` is bundled fresh per deploy | None |

**Verified by:** Reading `apps/web/utils/digest/run-daily-digest.ts`, `apps/web/app/api/cron/digest/route.ts`, `deploy/docker-compose.yml` references in CLAUDE.md, and `packages/resend/emails/digest-v2.tsx`.

## Common Pitfalls

### Pitfall 1: All-Day Event Date-String Trap
**What goes wrong:** `new Date("2026-05-23")` produces UTC midnight, which in ET is the previous day (8pm prior).
**Why it happens:** Google returns `date` (not `dateTime`) for all-day events; the NormalizedCalendarEvent type stores them as date-only strings.
**How to avoid:** Always branch on `isAllDay` before `new Date()`. The type's own docstring warns about this (Pitfall 4 in 08-RESEARCH.md). Use date-string comparison for all-day filtering; use `Date` arithmetic only for timed events.
**Warning signs:** Today's all-day birthday rendering as "yesterday".

### Pitfall 2: Sonnet Inventing Agenda Items
**What goes wrong:** Sonnet has training-data knowledge of "common Monday meetings" or "weekly standups" and may extrapolate.
**Why it happens:** LLMs pattern-complete; without an explicit guardrail they fill in plausible-sounding content.
**How to avoid:** D-22's hard prompt rule: "Only reference events / reconciliations present in the AGENDA and RECONCILIATIONS blocks. Do not infer, summarize counts you can't see, or extrapolate." Encode verbatim in `DIGEST_SYSTEM_PROMPT`.
**Warning signs:** Fixture tests where the narrative references an event not in the input.

### Pitfall 3: React Email Partial Borders Render as 3px on Other Sides
**What goes wrong:** `border-t` alone renders a thick border on all four sides in Gmail.
**Why it happens:** Default `border-style: solid; border-width: 1px` applies before the partial-side modifier; React Email's Tailwind compile inlines the wrong cascade.
**How to avoid:** Always pair partial-side borders with `border-0` companion class. **Already done in live template** lines 135 and 203. Phase 10 sub-components must follow.
**Warning signs:** Visual diff shows unexpected thick borders around new sections.

### Pitfall 4: Gmail Stripping the Overlap Pill
**What goes wrong:** Custom inline `<span>` styles get stripped by Gmail's CSS filter.
**Why it happens:** Gmail allows a curated subset of CSS; complex selectors and pseudo-elements are dropped.
**How to avoid:** Stick to the Phase 4 pattern (single-color bg + tracking + padding + font-weight). No gradients, no shadows, no positioning. Verify with `send-digest-v2-test.ts` end-to-end Gmail render before merge (open-question #6 in CONTEXT).
**Warning signs:** Pill renders correctly in `render-digest-v2.ts` static HTML but disappears in Gmail.

### Pitfall 5: Reconciliation Sender Mismatch
**What goes wrong:** Calendar Activity row says `"REI: Added Camping Trip..."` but the message was actually from `noreply@rei.com`.
**Why it happens:** Sender name extraction returns the local-part fallback when the from header has no display name.
**How to avoid:** Match Phase 4 fallback chain — display name (regex group 1) → entire from string (`src.from`). Accept that `noreply@orlandohealth.com` will display as `"noreply@orlandohealth.com"` rather than "Orlando Health". This is OK for personal logistics where the sender is metadata, not the social context.
**Warning signs:** Fixture rows with `noreply@` senders rendering ugly. Document as expected, not a bug.

### Pitfall 6: 24h Window Drifts Across DST
**What goes wrong:** `now - 24h` is wall-clock 24h, but DST transitions shift the boundary by an hour.
**Why it happens:** D-15 explicitly chose wall-clock 24h, not "since last digest send". On DST spring-forward, the window covers 25h-of-the-clock; on fall-back, 23h.
**How to avoid:** Accept the tradeoff (it's a single edge case, twice a year). Document inline. Use `Date.now() - 24*60*60*1000` directly.
**Warning signs:** None — this is intentional design.

## Code Examples

### Existing Pattern: Sender Name Regex Split (from `runDailyDigest` line 281)
```ts
const senderMatch = /^(.*?)(?:\s*<([^>]+)>)?$/.exec(src.from);
const senderName = senderMatch?.[1]?.trim() || src.from;
const senderEmail = senderMatch?.[2];
```
Source: `apps/web/utils/digest/run-daily-digest.ts:281`

### Existing Pattern: Tailwind Partial Border (from `digest-v2.tsx` line 135)
```tsx
className={`text-[14px] text-gray-700 leading-[1.55] m-0 py-[6px] ${
  i > 0 ? "border-0 border-t border-solid border-black/5" : ""
}`}
```
Source: `packages/resend/emails/digest-v2.tsx:135`

### Existing Pattern: ET Time Formatting (from `runDailyDigest` line 308)
```ts
sentTime: new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
}).format(new Date())
```
Source: `apps/web/utils/digest/run-daily-digest.ts:308`. Reuse for agenda time formatting (`9:00a` shape requires post-processing of `Intl` output or a small helper).

### Existing Pattern: Parallel Fetch with Failure Isolation (Phase 9 idiom)
```ts
// From apps/web/utils/calendar/reconciliation/index.ts:246
const upcoming = await getUpcomingEvents({ emailAccountId, now, logger }).catch(() => []);
```
For Phase 10, scale up with `Promise.allSettled`:
```ts
const [eventsR, reconciliationsR] = await Promise.allSettled([
  getUpcomingEvents({ emailAccountId, now, logger }),
  prisma.reconciliationRecord.findMany({
    where: {
      emailAccountId,
      createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      outcome: { in: ["MATCHED", "CREATED", "AMBIGUOUS"] },
    },
    orderBy: { extractedStart: "asc" },
  }),
]);
const events = eventsR.status === "fulfilled" ? eventsR.value : [];
const reconciliations = reconciliationsR.status === "fulfilled" ? reconciliationsR.value : [];
if (eventsR.status === "rejected") logger.warn("agenda.fetch.failed", { error: eventsR.reason });
if (reconciliationsR.status === "rejected") logger.warn("reconciliations.fetch.failed", { error: reconciliationsR.reason });
```

### Existing Pattern: Sonnet Call (from `generate-digest-content.ts`)
```ts
const aiResponse = await generateObject({
  ...modelOptions,
  system: DIGEST_SYSTEM_PROMPT,
  prompt: buildDigestPrompt({ todayDate, bucketed }),
  schema: digestContentSchema,
});
```
Phase 10 changes only `buildDigestPrompt`'s signature to accept the two extra context blocks. The Sonnet output schema does NOT change — narrative is still text; Phase 10's agenda + activity are rendered separately by React Email, not by Sonnet.

### Existing PreviewProps Pattern (for fixture extension)
See `packages/resend/emails/digest-v2.tsx:282-395` — `DigestV2Email.PreviewProps satisfies DigestV2Props`. Phase 10 extends this object with sample `agenda` and `calendarActivity` for the dev-loop render.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Upstream legacy `digest.tsx` | `digest-v2.tsx` with typed props + Sonnet narrative | Phase 4 (2026-05) | Legacy left in place; new digest sender uses v2 exclusively |
| Upstream `/api/resend/digest/route.ts` | New `runDailyDigest` orchestrator + `/api/cron/digest` route | Phase 4 | Legacy route still exists and would still work for manual triggers, but cron uses the new path |
| Per-email summarize at classification time | Batched summarize at digest send time | Phase 3 → Phase 4 | All Sonnet calls now happen once per digest, not per email |
| Direct Google Calendar calls | `getUpcomingEvents` cached read path | Phase 8 | Calendar API quota usage bounded by 15-min TTL |
| No reconciliation persistence | `ReconciliationRecord` table | Phase 9 | Phase 10's Calendar Activity is a pure read from this table |

**Deprecated/outdated:**
- `apps/web/app/api/resend/digest/route.ts` — Still functional but uses legacy template; do NOT modify in Phase 10. The cron path goes through `runDailyDigest`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (already configured in `apps/web/vitest.config.ts`) |
| Config file | `apps/web/vitest.config.ts` (existing) |
| Quick run command | `pnpm test -- <path/to/test>` (from `apps/web`) |
| Full suite command | `pnpm test` (from repo root) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DIG-01 | Today window (9am ET → midnight ET) filters events correctly | unit (pure fn) | `pnpm test -- apps/web/utils/digest/agenda/window.test.ts` | ❌ Wave 0 |
| DIG-02 | Tomorrow morning window (6am–noon next day ET) filters events correctly | unit (pure fn) | `pnpm test -- apps/web/utils/digest/agenda/window.test.ts` | ❌ Wave 0 |
| DIG-03 | Per-event row schema includes time/end/title/location/overlap pill | unit (pure fn) + snapshot | `pnpm test -- apps/web/utils/digest/agenda/build-agenda.test.ts` + `packages/resend/__tests__/digest-v2.test.tsx` | partial (digest-v2 test file exists from Phase 4) |
| DIG-03 | Overlap detection: strict interval intersection, all-day excluded, back-to-back ≠ overlap, per-day only | unit (pure fn, fixture-table) | `pnpm test -- apps/web/utils/digest/agenda/overlap.test.ts` | ❌ Wave 0 |
| DIG-04 | Empty-day fallback copy renders per branch (Today empty, Tomorrow morning empty + later, Tomorrow no events at all) | unit (pure fn) | `pnpm test -- apps/web/utils/digest/agenda/build-agenda.test.ts` | ❌ Wave 0 |
| DIG-05 | Sentence templates render correctly for MATCHED/CREATED/AMBIGUOUS with sender + link | unit (pure fn) | `pnpm test -- apps/web/utils/digest/calendar-activity/render-sentence.test.ts` | ❌ Wave 0 |
| DIG-05 | Link target picks googleEventHtmlLink, falls back to Gmail thread URL when null | unit (pure fn) | `pnpm test -- apps/web/utils/digest/calendar-activity/pick-link-target.test.ts` | ❌ Wave 0 |
| Integration | `runDailyDigest` with mocked Prisma + mocked `getUpcomingEvents` produces a valid `DigestV2Props` including new fields | integration (vitest) | `pnpm test -- apps/web/utils/digest/run-daily-digest.test.ts` | partial (file exists from Phase 4; extend) |
| Gmail render | `render-digest-v2.ts` with extended PreviewProps produces a non-empty HTML file showing agenda + activity | manual + snapshot | `pnpm --filter @inboxzero/resend tsx scripts/render-digest-v2.ts` + visual diff | n/a — script exists |
| Real Gmail | `send-digest-v2-test.ts` with extended PreviewProps delivers to Gmail; overlap pill visible | manual | `RESEND_API_KEY=… TEST_TO=rebekah@trueocean.com pnpm --filter @inboxzero/resend tsx scripts/send-digest-v2-test.ts` | n/a — script exists |
| Token-delta | Sonnet input_tokens delta ≤+1000 vs pre-Phase-10 baseline | one-shot measurement | Capture `promptTokens` from Tinybird (or log locally) for 3 consecutive digests pre/post merge | n/a — observation, not test |

### Sampling Rate
- **Per task commit:** `pnpm test -- <closest test file>` (~5s)
- **Per wave merge:** `pnpm test` excluding AI-tagged (~30s)
- **Phase gate:** Full suite green + render-digest-v2 visual review + send-digest-v2-test Gmail check + token-delta measurement on fixture

### Wave 0 Gaps
- [ ] `apps/web/utils/digest/agenda/window.test.ts` — DIG-01, DIG-02 windowing
- [ ] `apps/web/utils/digest/agenda/overlap.test.ts` — DIG-03 overlap detection (fixture-table)
- [ ] `apps/web/utils/digest/agenda/build-agenda.test.ts` — DIG-03, DIG-04 props builder + fallback copy
- [ ] `apps/web/utils/digest/agenda/format-time.test.ts` — `9:00a` / `12:30a` / crossing-midnight format
- [ ] `apps/web/utils/digest/calendar-activity/render-sentence.test.ts` — DIG-05 D-11 sentence templates
- [ ] `apps/web/utils/digest/calendar-activity/pick-link-target.test.ts` — D-13 link selection
- [ ] `apps/web/utils/digest/calendar-activity/build-activity.test.ts` — grouping + ordering
- [ ] Extension of `apps/web/utils/digest/run-daily-digest.test.ts` — integration with mocked fetches
- [ ] Extension of `packages/resend/__tests__/digest-v2.test.tsx` — snapshot includes agenda + activity blocks

No new framework install needed; vitest is already in place from Phase 4.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No new auth surfaces — uses existing cron Bearer secret |
| V3 Session Management | no | No sessions touched |
| V4 Access Control | yes (single-tenant) | Single user; `emailAccountId` scoped on every query |
| V5 Input Validation | yes | All user-facing data is from internal DB / Google Calendar API (already-trusted); no new untrusted input surfaces |
| V6 Cryptography | no | No new crypto |

### Known Threat Patterns for digest + calendar

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Calendar event title XSS via React Email render | Tampering | React Email auto-escapes child text; no `dangerouslySetInnerHTML` anywhere; verified in current `digest-v2.tsx` |
| Reconciliation record content leaking to Sonnet (prompt-injection re-escape) | Information Disclosure | Phase 9 already wraps untrusted body in `<email_body_untrusted>` tags. Phase 10 reads ONLY the extracted structured fields (title, start, sender display name), not raw body — no new injection surface. |
| PII in `logger.warn` on degraded paths | Information Disclosure | Phase 8 D-09 structured-fields-only discipline. Log `emailAccountId`, `recordId`, `error.message`, never `extractedTitle`/`extractedLocation`/event details |
| Cross-account data bleed | Spoofing | Every Prisma query scoped by `emailAccountId` (existing pattern); Phase 10 inherits |
| Sender-name forgery in Calendar Activity row | Spoofing | Display name comes from email `from` header which is already user-trusted (their own Gmail inbox); single-tenant; not a meaningful threat |
| Open redirect via `googleEventHtmlLink` | Tampering | Link target comes from Google's own response stored in our DB; Google controls the domain. No user-supplied URLs. |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Batch Gmail fetch for reconciliation sender names is acceptable cost at 1–3 reconciliations/day | "Reconciliation → Sender Name Lookup" | Adds one Gmail API call per digest; bounded; trivial |
| A2 | `Intl.DateTimeFormat` with `timeZone: "America/New_York"` reliably handles DST window boundaries | Pitfall 6 / Code Examples | Could shift agenda boundary by 1h during DST week; documented tradeoff |
| A3 | The overlap pill `<span>` survives Gmail CSS stripping when styled with single-color bg + padding + font-weight | Pitfall 4 / Email-Safe Pill Rendering | Real-Gmail check via `send-digest-v2-test.ts` before merge confirms this — verifiable, not assumed at merge time |
| A4 | Sonnet input tokens for AGENDA + RECONCILIATIONS blocks total ≤500 average / ≤1000 worst-case | D-20 / Token Capture | Measured against real fixture pre-merge; gate is the measurement, not the estimate |
| A5 | `digest-v2.tsx` extending `DigestV2Props` doesn't break the Phase 4 snapshot tests when new fields are absent | "Backwards-compatible" claim in D-03 | Phase 4 snapshot likely fails if it compares full prop shape; trivially fixed by adding `agenda` / `calendarActivity` defaults to existing test fixtures |
| A6 | Tinybird captures `promptTokens` per `saveAiUsage` call in a way queryable for delta measurement | Token-Delta section | If query path is broken, fall back to local logger output for 3 manual digest runs |

## Open Questions

These remain for the plan-phase to resolve based on implementation iteration:

1. **Exact teal/slate palette** — D-18 working direction is teal/slate. Plan-phase picks specific Tailwind classes (e.g., `bg-teal-50`, `border-l-teal-400`, `text-slate-700`) during the first visual render pass.
2. **All-day event ordering when multiple exist** — CONTEXT open #4. Alphabetical-by-title is simplest and most stable; recommend that.
3. **Day-name format in CREATED sentences** — CONTEXT open #5. Recommend "Added Dentist Mon at 9:00a" — short like the agenda time format, day-abbrev + time matches the conversational voice.
4. **Whether to split `digest-v2.tsx` into multiple files now** — Marked Claude's discretion. Recommendation: keep inline for Phase 10 (still <600 lines after extension), split if/when a 7-day agenda view lands later.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Anthropic API (`ANTHROPIC_API_KEY`) | Sonnet narrative call | ✓ | n/a | Existing prepaid credit balance — no Phase 10 change |
| Resend API (`RESEND_API_KEY`) | Email delivery | ✓ | n/a | Already configured |
| Google Calendar OAuth | `getUpcomingEvents` | ✓ | scopes verified Phase 8.5 | Empty-list fallback already in `getUpcomingEvents` on failure |
| Postgres (Prisma) | `reconciliationRecord` query | ✓ | running in prod | None — read fails → Calendar Activity section omitted (D-26) |
| Redis (Upstash) | Calendar event cache | ✓ | running in prod | `getUpcomingEvents` handles Redis failure internally |
| Node `Intl.DateTimeFormat` with `America/New_York` | ET timezone formatting | ✓ | Node built-in, ICU data bundled | None needed |
| pnpm | Local dev | ✓ | repo-pinned | — |
| vitest | Test runner | ✓ | configured | — |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None — every dependency is in place and verified.

## Sources

### Primary (HIGH confidence)
- `packages/resend/emails/digest-v2.tsx` — live visual template, full read
- `apps/web/utils/digest/run-daily-digest.ts` — live orchestrator, full read
- `apps/web/utils/ai/digest/generate-digest-content.ts` — live Sonnet call, full read
- `apps/web/utils/ai/digest/digest-prompt.ts` — live system prompt + builder, full read
- `apps/web/utils/ai/digest/digest-schema.ts` — Sonnet output zod schema, full read
- `apps/web/utils/calendar/upcoming-events.ts` — Phase 8 read path, full read
- `apps/web/utils/calendar/upcoming-events-types.ts` — NormalizedCalendarEvent contract, full read
- `apps/web/utils/calendar/reconciliation/index.ts` — Phase 9 orchestrator (reference for failure-isolation pattern), full read
- `apps/web/prisma/schema.prisma` lines 898–935 — ReconciliationRecord model + enum, verified by grep
- `apps/web/utils/usage.ts` lines 1–80 — saveAiUsage signature, verified
- `apps/web/utils/email.ts` — extractNameFromEmail helper, verified
- `apps/web/utils/rule/consts.ts` line 81 — SystemType.CALENDAR rule definition, verified
- `packages/resend/scripts/render-digest-v2.ts` — dev-loop render script, full read
- `packages/resend/src/send.tsx` — sendDigestV2Email wrapper, full read
- `.planning/phases/04-daily-digest/04-CONTEXT.md` — Phase 4 carry-forward facts
- `.planning/phases/04-daily-digest/04-PATTERNS.md` — Phase 4 file-pattern map
- `.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md` — Phase 8 contract
- `.planning/phases/09-email-calendar-reconciliation/09-CONTEXT.md` — Phase 9 contract
- CLAUDE.md — project constraints (do not run tsc/build locally)
- MEMORY.md notes — `project_queue_backend`, `feedback_lint_ci_only`, `feedback_biome_check_before_push`, `react_email_partial_borders`, `digest_voice_preference`, `prefer_organic_uat`

### Secondary (MEDIUM confidence)
- None — Phase 10 needed zero external documentation lookup; the entire scope is contained within the repo's existing patterns.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every library confirmed present in existing code
- Architecture: HIGH — every file location and function signature verified by direct read
- Pitfalls: HIGH — Pitfalls 1–4 are documented in existing code/memory; 5–6 are intentional tradeoffs
- Sonnet integration: HIGH — `generate-digest-content.ts` and `digest-prompt.ts` are simple text-building functions that extend trivially

**Research date:** 2026-05-23
**Valid until:** ~2026-06-23 (30 days; Phase 4/8/9 are stable shipped code, low churn expected)
