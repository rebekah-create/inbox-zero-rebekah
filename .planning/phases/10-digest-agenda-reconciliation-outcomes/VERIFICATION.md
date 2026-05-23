---
phase: 10-digest-agenda-reconciliation-outcomes
verified: 2026-05-23T00:00:00Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Send a real digest end-to-end (post-deploy) and open in Gmail"
    expected: "Section ordering narrative → TODAY → TOMORROW MORNING → Urgent → Uncertain → Calendar Activity → Receipts/Newsletters/Marketing/Notifications. The overlap pill ([⚠ overlaps]) survives Gmail CSS stripping; no rogue 3px partial borders on new sections; teal-bordered Calendar Activity card renders as a single bordered block with three sub-headings."
    why_human: "Gmail's CSS stripping cannot be observed from grep/static HTML; only a live render against rebekah@trueocean.com's inbox will confirm Pattern S4 partial-border companion classes survive in production."
  - test: "Observe Sonnet narrative on first post-deploy 9am ET cron send and confirm it does not invent events"
    expected: "narrativeBody references at most events that appear in the AGENDA block; no fabricated counts or extrapolations; D-22 hard rule is honoured at runtime."
    why_human: "D-22 is a prompt-level guardrail — actual model behaviour can only be observed against a live Sonnet call with real-inbox data. Static prompt assertion is in place (test asserts the verbatim hard rule), but runtime adherence requires a human read of the first post-deploy digest."
  - test: "Capture promptTokens from Tinybird ai_usage pipe pre- vs post-deploy (3-digest mean)"
    expected: "delta = post_mean - pre_mean ≤ +1000 tokens/digest (D-20 budget). Static analysis projects ~243 tokens worst case (~24% of budget) so substantial headroom is expected."
    why_human: "Tinybird query requires a token + the dev server cannot be run locally per CLAUDE.md. The token-delta gate test (5 agenda + 5 reconciliation entries adds ≤ 4000 chars) passes statically; live measurement is the user's responsibility post-deploy."
---

# Phase 10: Digest Agenda + Reconciliation Outcomes Verification Report

**Phase Goal:** Lead the 9am ET digest with today + tomorrow's agenda so the user is oriented to the day, and render a one-line outcome for every reconciliation in the last 24h (`MATCHED` / `CREATED` / `AMBIGUOUS`).

**Verified:** 2026-05-23
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Success Criteria from ROADMAP.md)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Digest opens with TODAY (9am ET → midnight ET) + TOMORROW MORNING (6am–noon next day) section | VERIFIED | `digest-v2.tsx:261-276` `AgendaSection` renders TODAY + TOMORROW MORNING blocks. `agenda/window.ts:windowToday` filters timed events `[now, midnight-ET-today)` with all-day-on-today; `windowTomorrowMorning` filters `[6am ET tomorrow, noon ET tomorrow)`. `digest-v2.tsx:381` wires `<AgendaSection>` between narrative (line 368) and Urgent (line 384) — D-01 position. |
| 2 | Each agenda item renders time / title / location / overlap indicator | VERIFIED | `AgendaItem` type includes `time`, `title`, `location`, `overlapWith[]` (`digest-v2.tsx:65`). `format-time.ts:formatAgendaTime` produces D-07 "9:00a" / "All day". `overlap.ts:detectOverlaps` returns `Map<id,string[]>` via half-open intersection. `build-agenda.ts:127-128` runs `detectOverlaps` per-day (D-10) and populates `overlapWith`. Render-side overlap pill present in `digest-v2.tsx` (PreviewProps demo + AgendaItemRow). |
| 3 | Empty days render a friendly fallback rather than a blank section | VERIFIED | `build-agenda.ts:152-172` emits D-05 fallback strings: `"Nothing else on the calendar today."`, `"Nothing on the calendar tomorrow."`, and the extender `"Nothing before noon; first thing is {time} {title}."`. `AgendaDayBlock` (`digest-v2.tsx:240-258`) renders fallback as italic Text when `items.length===0 && fallback` is non-null. |
| 4 | Each reconciliation in the last 24h renders one of three D-11 sentence shapes | VERIFIED | `render-sentence.ts:47-58` exhaustive switch produces D-11 verbatim: MATCHED → `"{sender} confirmed {title} — already on your calendar"`, CREATED → `"Added {title} {day at time} to your calendar (from {sender}) →"`, AMBIGUOUS → `"{sender}: looks like it's about {title} — review →"`. `build-activity.ts:65-83` groups + sorts by extractedStart asc (D-14), filters D-16 outcomes (only MATCHED/CREATED/AMBIGUOUS surface). |
| 5 | CREATED and AMBIGUOUS lines link to source email | VERIFIED | `pick-link-target.ts:21-34`: MATCHED/CREATED with `googleEventHtmlLink` → use Calendar link; CREATED/MATCHED null fallback → Gmail thread URL; AMBIGUOUS → always Gmail thread URL via `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}` (T-10-03 mitigated). `digest-v2.tsx:298-300` renders rows as `<Link href={row.href}>{row.sentence}</Link>`. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/utils/digest/agenda/types.ts` | AgendaItem + AgendaBlock contracts | VERIFIED | Re-exported via digest-v2.tsx inline (rationale: cross-package import). Used by build-agenda.ts. |
| `apps/web/utils/digest/agenda/window.ts` | windowToday + windowTomorrowMorning | VERIFIED | DST-correct via Intl ET probe at noon; Pattern S5 isAllDay branching. |
| `apps/web/utils/digest/agenda/overlap.ts` | detectOverlaps half-open intersection | VERIFIED | All-day events excluded (D-08); back-to-back excluded. |
| `apps/web/utils/digest/agenda/format-time.ts` | D-07 "9:00a" + cross-midnight "(tonight)" | VERIFIED | Pattern S5 isAllDay branching before new Date(). |
| `apps/web/utils/digest/agenda/build-agenda.ts` | Composed AgendaBlock builder | VERIFIED | Per-day overlap detection (D-10); D-05 fallback strings verbatim; all-day-first sort. |
| `apps/web/utils/digest/calendar-activity/types.ts` | Row/Block/Outcome types | VERIFIED | CalendarActivityOutcome excludes FAILED/PENDING at type level (D-16). |
| `apps/web/utils/digest/calendar-activity/render-sentence.ts` | D-11 sentence templates | VERIFIED | Verbatim shapes; plain-text passthrough (T-10-02 mitigated). |
| `apps/web/utils/digest/calendar-activity/pick-link-target.ts` | D-13 link selector | VERIFIED | encodeURIComponent on threadId; AMBIGUOUS always Gmail. |
| `apps/web/utils/digest/calendar-activity/build-activity.ts` | Composed CalendarActivityBlock builder | VERIFIED | D-16 filter (`SURFACE_OUTCOMES = {MATCHED,CREATED,AMBIGUOUS}` line 56); D-12 returns null when all empty; D-14 sort. |
| `packages/resend/emails/digest-v2.tsx` AgendaSection + CalendarActivitySection | New sub-components at D-01 / D-02 insertion points | VERIFIED | Lines 261-324; conditional rendering at lines 381 + 424-426; `showCalendarActivity` gate at 340-344 hides whole section when all three groups empty (D-12). PreviewProps fixture present at 480, 487, 531. |
| `apps/web/utils/ai/digest/digest-prompt.ts` AGENDA + RECONCILIATIONS + D-22 | Sonnet prompt extension | VERIFIED | D-22 hard rule verbatim at line 38; `renderAgenda` line 81-85; `renderReconciliations` line 87-93; new types AgendaCompactItem + ReconciliationCompactItem exported; buildDigestPrompt extended with optional params (backward-compat default `[]`). |
| `apps/web/utils/ai/digest/generate-digest-content.ts` | Pass-through wiring | VERIFIED | Accepts and forwards agendaCompact + reconciliationsCompact to buildDigestPrompt (lines 21-22, 47-56). |
| `apps/web/utils/digest/run-daily-digest.ts` | Parallel fetch + composition | VERIFIED | Promise.allSettled at lines 263-277; per-branch warn with structured fields only at 281-293; senderMap build at 297-334; buildAgenda + buildCalendarActivity invocation at 336-349; agendaCompact + reconciliationsCompact threaded into generateDigestContent at 351-385; DigestV2Props extended with agenda + calendarActivity at 436-437. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `run-daily-digest.ts` | `getUpcomingEvents` (Phase 8) | direct call, Promise.allSettled branch 0 | WIRED | Line 264-268 calls with `{emailAccountId, now, logger: scoped}` — matches getUpcomingEvents signature (`upcoming-events.ts:42-47`). |
| `run-daily-digest.ts` | `prisma.reconciliationRecord` (Phase 9 schema) | findMany with D-16 outcome filter | WIRED | Line 269-276; filters `outcome IN [MATCHED, CREATED, AMBIGUOUS]`, last 24h via `createdAt >= since24h`, sorted by extractedStart asc. Schema fields used (`extractedTitle`, `extractedStart`, `extractedIsAllDay`, `threadId`, `messageId`, `googleEventHtmlLink`) all exist in `schema.prisma:898-927`. |
| `run-daily-digest.ts` | `buildAgenda` + `buildCalendarActivity` | imports at lines 20-21 | WIRED | Both composers invoked at lines 336-349 with mapped inputs; `extractedIsAllDay ?? false → isAllDay` mapping correct (matches build-activity.ts ReconciliationInput interface). |
| `run-daily-digest.ts` | `generateDigestContent` (Sonnet path) | passes agendaCompact + reconciliationsCompact | WIRED | Lines 351-385; day-tagged compact items so Sonnet can attribute today vs tomorrow without inference. |
| `generateDigestContent` | `buildDigestPrompt` | passes through compact arrays | WIRED | Lines 47-56 in generate-digest-content.ts. |
| `buildDigestPrompt` | renderAgenda + renderReconciliations | composed BEFORE bucket renders | WIRED | Lines 106-119 in digest-prompt.ts — AGENDA + RECONCILIATIONS appear early in prompt. |
| `DigestV2Props` | template render | `agenda` + `calendarActivity` optional props | WIRED | Lines 422-437 in run-daily-digest.ts populate both fields; lines 87-99 in digest-v2.tsx declare the props; lines 337-338 destructure; lines 381 + 424-426 conditionally render the two new sections. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `AgendaSection` (digest-v2.tsx) | `agenda` prop | `buildAgenda({events, now})` ← `getUpcomingEvents` (Phase 8 cached read path) | Yes — Phase 8 returns NormalizedCalendarEvent[] from Google Calendar API cache | FLOWING |
| `CalendarActivitySection` (digest-v2.tsx) | `calendarActivity` prop | `buildCalendarActivity({records, senderMap})` ← `prisma.reconciliationRecord.findMany` + batched Gmail header fetch | Yes — real DB query + real Gmail batch fetch for sender names | FLOWING |
| Sonnet prompt AGENDA block | `agendaCompact` | mapped from `agenda.today` + `agenda.tomorrowMorning` with day tag | Yes — day-tagged for disambiguation | FLOWING |
| Sonnet prompt RECONCILIATIONS block | `reconciliationsCompact` | mapped from reconciliations array with sender resolution | Yes — sender map lookup + messageId fallback | FLOWING |

### Behavioral Spot-Checks

Skipped per phase constraints — CLAUDE.md forbids running `pnpm test`, `pnpm build`, `pnpm exec tsc`, or `pnpm dev` on this Windows host (locks up the system). Per-plan SUMMARYs report:
- Plan 10-01: 26 fixture-table assertions across format-time / window / overlap (not run locally; CI executes).
- Plan 10-02: 11 assertions across render-sentence + pick-link-target — Plan 10-02 SUMMARY records all 11/11 passed via vitest in a sibling worktree.
- Plan 10-03: 16 assertions across build-agenda + build-activity — SUMMARY records 7/7 + 9/9 passed.
- Plan 10-04: Phase 10 test cases added to `packages/resend/__tests__/digest-v2.test.tsx` (not run locally — no node_modules in this worktree; CI executes).
- Plan 10-05: digest-prompt.test.ts (6 assertions including D-22 verbatim assertion) + run-daily-digest.test.ts (5 cases including PII redaction + degradation) — not run locally; CI executes.

CI will run the full suite on push.

### Probe Execution

Not applicable — Phase 10 has no `scripts/*/tests/probe-*.sh` style probes. Verification is via vitest unit tests (CI-executed) plus the static HTML render at `.planning/phases/10-digest-agenda-reconciliation-outcomes/digest-v2-phase10-rendered.html`.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DIG-01 | 10-01, 10-03, 10-04, 10-05 | Today section showing 9am ET → midnight ET | SATISFIED | `windowToday` filters timed events `end > now && start < midnight-ET-today` + today's all-day events. `AgendaSection` TODAY block at digest-v2.tsx:264-268. |
| DIG-02 | 10-01, 10-03, 10-04, 10-05 | Tomorrow section showing 6am–noon next day | SATISFIED | `windowTomorrowMorning` filters `[6am ET tomorrow, noon ET tomorrow)`. TOMORROW MORNING block at digest-v2.tsx:269-273. |
| DIG-03 | 10-01, 10-03, 10-04 | Each item: time, title, location, overlap indicator | SATISFIED | AgendaItem type carries all four fields; detectOverlaps populates overlapWith per-day; render-side overlap pill present (visible in `digest-v2-phase10-rendered.html` per Plan 10-04 grep verification). |
| DIG-04 | 10-01, 10-03, 10-04 | Empty days render a friendly fallback | SATISFIED | D-05 fallback strings verbatim in build-agenda.ts:153-171; AgendaDayBlock renders italic fallback text when items=[] (digest-v2.tsx:252-256). |
| DIG-05 | 10-02, 10-03, 10-04 | Reconciliation one-line outcomes with link (MATCHED / CREATED / AMBIGUOUS) | SATISFIED | renderSentence produces the 3 D-11 shapes (matching DIG-05's specified prose verbatim); pickLinkTarget gives event link or Gmail thread URL; CalendarActivitySection renders rows as `<Link href={href}>{sentence}</Link>`. |

No orphaned requirements: ROADMAP Phase 10 lists DIG-01..05; all five appear in PLAN frontmatter coverage.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/web/utils/digest/run-daily-digest.ts` | 134, 145, 183, 236, 240 | `scoped.info/warn` calls (logger) | None — informational logging, structured payloads | OK |
| (any file) | — | `TBD` / `FIXME` / `XXX` debt markers | None | Grep across phase 10 modified files returned no debt markers requiring follow-up issues. |
| `packages/resend/emails/digest-v2.tsx` | — | `dangerouslySetInnerHTML` (T-10-02 hard gate) | None | grep -c = 0 ✓ |
| `apps/web/utils/digest/calendar-activity/render-sentence.ts` | — | `dangerouslySetInnerHTML` (T-10-02) | None | grep -c = 0 ✓ |
| `apps/web/utils/digest/run-daily-digest.ts` | 282, 290, 329 | warn payload PII (Pattern S3 / T-10-PII) | None | grep for `extractedTitle\|extractedLocation` inside warn args = 0 matches ✓ |

### Human Verification Required

See `human_verification` frontmatter block above. Three items require live-system verification:

1. **End-to-end Gmail render (T-10-pill / partial-border safety)** — Must open a real digest in Gmail post-deploy to confirm overlap pill survives CSS stripping and no rogue 3px borders appear on the new sections. Static HTML preview at `.planning/phases/10-digest-agenda-reconciliation-outcomes/digest-v2-phase10-rendered.html` covers shape but not Gmail's stripping behaviour.
2. **Sonnet narrative agenda-awareness (D-22 runtime)** — D-22 hard rule is asserted verbatim in the system prompt + a unit test. Whether Sonnet actually obeys at runtime requires reading the first post-deploy 9am ET digest narrative against the AGENDA block contents.
3. **Token-delta measurement (D-20)** — Static analysis projects ~243 tokens worst-case (~24% of D-20 1000-token budget). Live Tinybird `promptTokens` capture (pre-deploy 3-digest mean vs post-deploy 3-digest mean) is the user's responsibility.

### Gaps Summary

No gaps blocking goal achievement. All five Success Criteria from ROADMAP Phase 10 are wired in source and trace cleanly from the data-fetch layer (`getUpcomingEvents` + `prisma.reconciliationRecord.findMany`) through the pure composers (`buildAgenda`, `buildCalendarActivity`) into both the React Email template (`AgendaSection` + `CalendarActivitySection`) and the Sonnet prompt (`renderAgenda` + `renderReconciliations` + D-22). Failure-isolation is in place via `Promise.allSettled` per branch + per-branch warn logging with structured fields only (Pattern S3 / T-10-PII verified). The D-22 hard rule appears verbatim in `DIGEST_SYSTEM_PROMPT` with a unit-test assertion. Per-day overlap detection (D-10) and D-16 outcome filtering (FAILED/PENDING excluded) are both enforced in code and asserted by tests.

The three deferred verification items (live Gmail render, live Sonnet runtime, live Tinybird token measurement) are inherently human-only — they require a real post-deploy 9am ET digest send. Static evidence is strong; runtime confirmation is awaiting the next production cron cycle.

---

_Verified: 2026-05-23_
_Verifier: Claude (gsd-verifier)_
