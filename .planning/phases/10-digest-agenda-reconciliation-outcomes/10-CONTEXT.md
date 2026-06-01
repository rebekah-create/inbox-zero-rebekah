# Phase 10: Digest Agenda + Reconciliation Outcomes — Context

**Gathered:** 2026-05-23
**Status:** Ready for planning
**Requirements:** DIG-01, DIG-02, DIG-03, DIG-04, DIG-05
**Depends on:** Phase 4 (digest-v2 template + send pipeline) ✅ shipped, Phase 8 (`getUpcomingEvents` cached read path) ✅ shipped, Phase 9 (`ReconciliationRecord` table + outcomes) ✅ shipped

<domain>
## Phase Boundary

Add two new render blocks to the existing 9am ET daily digest:

1. **Agenda** — Today (9am ET → midnight ET) + Tomorrow morning (6am–noon next day) sections rendered between Sonnet's narrative and the Urgent block.
2. **Calendar Activity** — one-line outcome per `ReconciliationRecord` from the last 24h, grouped by outcome (Review / Added / Confirmed), rendered as its own section in the digest body.

Sonnet's existing narrative is extended to be agenda-aware (it sees the agenda + reconciliations in its prompt) so the morning paragraph can name what's on deck.

**Not in scope for Phase 10:**
- A new UI route to review AMBIGUOUS reconciliations (deferred — Gmail link is the v1 review surface).
- Multi-day agenda (just Today + Tomorrow morning; full 7-day view deferred).
- Calendar action buttons in the digest (accept/dismiss AMBIGUOUS). The link IS the action — opens the email; user fixes in Gmail or Calendar.
- Push/SMS alerts for same-day overlaps — digest-only signal.
- Changing classification or reconciliation behavior — pure render layer on top of Phase 8/9 data.
- Sonnet narrative refactor — only the prompt input changes (agenda + reconciliations appended); voice/tone/section-ordering rules from Phase 4 D-01..D-04 still hold.
</domain>

<carry_forward>
## Carry-Forward Facts

- **Digest visual contract is `packages/resend/emails/digest-v2.tsx`.** Locked in Phase 4 D-09. Phase 10 extends `DigestV2Props` and adds new sub-components; does NOT fork the template. (Phase 4 CONTEXT D-09.)
- **Section ordering rule (Phase 4 D-08).** Warm-to-cool color hierarchy: Narrative → (NEW: Agenda) → Urgent (red) → Uncertain (amber) → (NEW: Calendar Activity) → Receipts (green) → Newsletters (blue) → Marketing (purple) → Notifications (pink). Agenda inserts between Narrative and Urgent; Calendar Activity inserts after Uncertain and before the auto-filed roll-ups. Discussed and locked in this CONTEXT.
- **`getUpcomingEvents({ emailAccountId, now })` is THE calendar read path.** Returns `NormalizedCalendarEvent[]` for next 7 days, declined/tentative already excluded, 15-min soft TTL + 24h hard TTL with stale fallback. Phase 10's agenda query filters this list down to Today (9am ET → midnight ET) + Tomorrow morning window. NEVER call Google directly. (Phase 8 D-01..D-12; Phase 9 carry-forward.)
- **`ReconciliationRecord` is THE source for Calendar Activity.** Fields used: `outcome` (enum), `extractedTitle`, `extractedStart`, `extractedLocation`, `threadId` (for Gmail fallback link), `googleEventHtmlLink` (for primary Calendar link), `createdAt` (for 24h window). Index `(emailAccountId, createdAt DESC)` already in place — Phase 9 D-15 anticipated this query. (Phase 9 D-13..D-15.)
- **Personal-logistics use case, ~1–3 events/day.** Designs that scale to 50-event power users (collapsible sections, per-event detail panels) are over-engineering. Sparse agenda is the common case. (PROJECT.md, REQUIREMENTS.md use-case framing.)
- **9am ET cron + since-last-send window.** Already shipped in Phase 4 D-12/D-13. Phase 10 changes render output, not the trigger.
- **Sonnet narrative voice locked.** Conversational, humor OK, hard guardrail to drop humor for grief/illness/financial distress/legal threats/family emergencies. (Phase 4 D-02..D-04; memory `digest_voice_preference`.) Agenda-aware narrative inherits these rules verbatim.
- **AI cost still at ceiling (~$10/mo).** Adding the agenda + reconciliation summaries to Sonnet's prompt adds ~500 input tokens/digest = ~$0.03/month. Tolerable. Plan-phase verifies actual token delta before merge.
- **Source-email link target preference.** User chose "Google Calendar event link if possible" — primary link target for MATCHED + CREATED rows is `googleEventHtmlLink`. AMBIGUOUS has no event created, so fall back to Gmail thread URL. (Locked in this CONTEXT.)
</carry_forward>

<decisions>
## Implementation Decisions

### Layout & placement

- **D-01 — Agenda renders between narrative and Urgent.** Sonnet's existing narrative paragraph greets you, then Today / Tomorrow morning agenda blocks render before the first Urgent card. Matches the "calm-morning-read" framing of Phase 4 D-01 — narrative orients, agenda anchors the day, then action items.
- **D-02 — Calendar Activity renders as its own section between Uncertain and the auto-filed roll-ups.** It is not an auto-filed group (different data source, different shape); it sits as a peer section. Follows the warm-to-cool color rule of Phase 4 D-08 — Calendar Activity uses a neutral/teal palette distinct from the four auto-filed colors.
- **D-03 — `DigestV2Props` is extended (not forked).** New fields on the existing props type: `agenda: AgendaBlock` and `calendarActivity: CalendarActivityBlock | null`. When both are absent the digest renders the Phase 4 layout unchanged — backwards-compatible for any unit test that still passes the old props shape.

### Agenda block

- **D-04 — Two sub-sections: Today + Tomorrow morning.**
  - **Today window:** `digestSendTime` (9am ET) → end-of-day ET (midnight ET) for the digest's send date. Events ending before `digestSendTime` are excluded (already past when the user reads).
  - **Tomorrow morning window:** 6am ET → 12pm ET (noon) the next calendar day.
- **D-05 — Empty-day fallback (DIG-04):**
  - **Today empty:** render `"Nothing else on the calendar today."` as a single italic line inside the Today section.
  - **Tomorrow morning empty + later events exist tomorrow:** render `"Nothing before noon; first thing is {time} {title}."` (extender beyond the literal spec — chosen for personal-logistics utility).
  - **Tomorrow morning empty + no events all day tomorrow:** render `"Nothing on the calendar tomorrow."`
  - Voice is conversational, matches narrative tone (Phase 4 D-02). Do not say "0 events" or "empty calendar".
- **D-06 — Per-event row schema.** `{ time: "9:00a", endTime: "10:00a" | null, title: string, location: string | null, isAllDay: bool, overlapWith: string[] }`. All-day events render at the top of the day with label `"All day"` instead of a time. End times shown only when present and not equal to start.
- **D-07 — Time format.** 12-hour with single-letter am/pm marker (`9:00a`, `2:30p`) — matches conversational voice. ET implicit (user is single-tenant in `America/New_York`). For events crossing midnight, render `"9:00p–12:30a"` with a tiny `"(tonight)"` suffix.

### Overlap / conflict semantics (DIG-03)

- **D-08 — Overlap rule: strict time-interval intersection, all-day events excluded.** Two timed events overlap iff `[startA, endA) ∩ [startB, endB) ≠ ∅`. All-day events are background context only — they do NOT trigger an overlap indicator against timed events (avoids "birthday all-day overlaps with everything" noise). Back-to-back events (zero gap) do NOT count as overlap.
- **D-09 — Overlap indicator: inline pill on each overlapping row.** Render `"[⚠ overlaps]"` (or its email-safe HTML equivalent — a small inline span with amber background) at the end of the row. Both rows in an overlapping pair carry the pill. Three-way overlaps each carry the same pill.
- **D-10 — Overlap is computed per-day.** No cross-day overlap detection (Today's 11:55pm event does not flag against Tomorrow's 12:05am event). Keeps logic local to each rendered sub-section.

### Calendar Activity (DIG-05)

- **D-11 — Single "Calendar Activity" section, grouped by outcome in fixed order: Review → Added → Confirmed.**
  - `AMBIGUOUS` rows render under sub-heading **"Review"** with sentence shape: `"{Sender}: looks like it's about {extractedTitle} — review →"`.
  - `CREATED` rows render under sub-heading **"Added"** with sentence shape: `"Added {extractedTitle} {day/time} to your calendar (from {sender}) →"`.
  - `MATCHED` rows render under sub-heading **"Confirmed"** with sentence shape: `"{Sender} confirmed {extractedTitle} — already on your calendar"`.
- **D-12 — Hide empty sub-headings; hide the whole section if all three sub-headings are empty.** No "0 items today" placeholder — calendar activity is a presence indicator, not a counter. (Distinct from DIG-04 agenda fallback, which IS user-facing because an empty day is itself meaningful information.)
- **D-13 — Source-email link target.** Primary link target is `googleEventHtmlLink` from the `ReconciliationRecord` whenever populated (`MATCHED` + `CREATED` paths). For `AMBIGUOUS` rows (`googleEventHtmlLink` is null by design — no event was created), the link falls back to the Gmail thread URL `https://mail.google.com/mail/u/0/#inbox/{threadId}`. **Failure isolation:** if a `MATCHED`/`CREATED` record has a null `googleEventHtmlLink` (legacy or upstream Google API hiccup), fall back to the Gmail thread URL.
- **D-14 — Ordering within each sub-heading.** Chronological by `extractedStart` ascending (the event's scheduled time, not when the email arrived). Surfaces nearest-in-time items at the top of each group.
- **D-15 — 24h window definition.** `ReconciliationRecord.createdAt >= now() - 24h` — wall-clock 24h, not "since last digest send" (a missed digest still surfaces yesterday's items via the older record's `createdAt` falling outside the 24h window — accept this tradeoff; missed digest is the failure mode, not the design point).
- **D-16 — Outcomes with `outcome = FAILED` or `outcome = PENDING` are EXCLUDED from the digest entirely.** Those are internal/operational states (see Phase 9 D-21..D-23) — surfacing "we tried and broke" in the digest body is noise. Plan-phase: silent log only, no digest row.
- **D-17 — Sender name extraction.** `{Sender}` in the sentence templates comes from the email's `from` header parsed display name (or email-local-part fallback). Plan-phase resolves the cleanest accessor — likely the same one Phase 4's `ActionItemCard` uses for `senderName`.
- **D-18 — Sub-heading visual treatment.** Section uses a teal/slate palette (neither warm-action nor cool-auto-filed). Sub-headings (`Review`, `Added`, `Confirmed`) are small caps / bold inside a single bordered section card — NOT three separate cards. One block, three sub-sections.

### Sonnet narrative integration

- **D-19 — Narrative becomes agenda-aware.** The Sonnet narrative prompt receives two new context blocks: (a) Today's agenda (compact: `[time, title]` per event); (b) last-24h reconciliation outcomes (compact: `[outcome, title, sender]` per record). System prompt instructs Sonnet to weave in 1–2 agenda/reconciliation references when natural — never enumerate, never duplicate the agenda block verbatim.
- **D-20 — Token budget delta.** Estimated +500 input tokens per digest on average (3 events × ~30 tokens + 3 reconciliations × ~40 tokens + prompt scaffolding). At Sonnet pricing this is +$0.0015/digest = ~$0.05/month. Plan-phase measures actual delta against a real digest and confirms ≤$0.50/month delta before merge (well within OPS-02 ceiling).
- **D-21 — Voice guardrails inherit Phase 4.** Drop humor entirely if any inbox item OR any reconciliation OR any agenda event touches grief/serious illness/financial distress/legal threats/family emergencies. Agenda + reconciliations are subject to the same scan — `[AI] Dr. visit` reconciliation triggers the same somber-voice mode that "we regret to inform you" inbox content does.
- **D-22 — Narrative MUST NOT invent agenda items or reconciliation outcomes.** Hard rule in the system prompt: "Only reference events / reconciliations present in the AGENDA and RECONCILIATIONS blocks. Do not infer, summarize counts you can't see, or extrapolate." Prevents hallucination of nonexistent items.

### Data plumbing

- **D-23 — Agenda data fetched in the digest send pipeline, not the cron route.** Same place Phase 4 fetches DigestItems and renders Sonnet narrative — `apps/web/app/api/resend/digest/route.ts` (or wherever Phase 4 landed it; researcher confirms). Reuses `getUpcomingEvents` directly (cached, no extra Calendar API quota cost).
- **D-24 — Reconciliation data fetched via single Prisma query:** `prisma.reconciliationRecord.findMany({ where: { emailAccountId, createdAt: { gte: now - 24h }, outcome: { in: ['MATCHED', 'CREATED', 'AMBIGUOUS'] } }, orderBy: { extractedStart: 'asc' } })`. Uses the existing `(emailAccountId, createdAt DESC)` index — query plan verified in plan-phase.
- **D-25 — Both data fetches happen in parallel** (`Promise.all`) and feed into the props builder. Either failure degrades gracefully: missing agenda → render empty-day fallback for both days; missing reconciliations → omit Calendar Activity section. Digest still sends.
- **D-26 — Failure isolation.** Agenda + reconciliation failures MUST NOT block digest send. Wrap each fetch in try/catch, log + degrade. The digest is more valuable broken than missing.

### Claude's Discretion (open for plan-phase)

- Exact `DigestV2Props` field names — `agenda` / `calendarActivity` is the working name. Plan-phase finalizes.
- File layout for new sub-components — likely `packages/resend/emails/digest-v2/AgendaSection.tsx` and `CalendarActivitySection.tsx` extracted from the main file. Plan-phase decides whether to split or keep inline.
- The exact Tailwind palette for the Calendar Activity section. Teal / slate is the working direction; designer-feel call lands in implementation.
- Sonnet prompt edits: exact wording of the new AGENDA / RECONCILIATIONS blocks and the "weave naturally, do not enumerate, do not invent" instructions. Plan-phase iterates on a real fixture.
- Fixture for visual review during plan-phase — extend the existing `PreviewProps` in `digest-v2.tsx` to include sample agenda + reconciliation data so `render-digest-v2.ts` (Phase 4 helper) produces a Phase-10-shaped preview.
- Test pattern for the per-day overlap detection helper — pure function, fixture-table style unit tests (same shape as Phase 9's `decideOutcome` tests).

</decisions>

<canonical_refs>
## Canonical References (MANDATORY reading for downstream agents)

- `.planning/REQUIREMENTS.md` — DIG-01..DIG-05 acceptance criteria (lines containing each ID).
- `.planning/ROADMAP.md` — Phase 10 entry (line range starts at `### Phase 10:`).
- `.planning/PROJECT.md` — Use-case framing, cost ceiling, voice preferences.
- `.planning/phases/04-daily-digest/04-CONTEXT.md` — Digest visual contract, section ordering, narrative voice, idempotency policy. **All Phase 4 decisions remain in force.**
- `.planning/phases/04-daily-digest/digest-v2-rendered.html` — Last rendered Phase 4 digest for visual baseline.
- `.planning/phases/04-daily-digest/design-reference/digest-mockup.html` — Phase 4 design canonical visual spec.
- `.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md` — `getUpcomingEvents` contract, cache behavior, stale-fallback rules.
- `.planning/phases/09-email-calendar-reconciliation/09-CONTEXT.md` — `ReconciliationRecord` schema, outcome enum, sentence templates referenced in DIG-05.
- `packages/resend/emails/digest-v2.tsx` — Live template; Phase 10 extends in-place.
- `packages/resend/scripts/render-digest-v2.ts` — Render-to-static-HTML helper for visual diff during plan-phase.
- `apps/web/prisma/schema.prisma` — `ReconciliationRecord` model + indexes (live source of truth).

</canonical_refs>

<code_context>
## Code Context (scout findings)

### Reusable assets
- `getUpcomingEvents({ emailAccountId, now })` — Phase 8 cached read path; THE source for agenda data. No additional Google Calendar API cost.
- `ReconciliationRecord` Prisma model with `(emailAccountId, createdAt DESC)` index — query-ready for the 24h window.
- `digest-v2.tsx` props pattern (`ActionItem`, `AutoFiledRow`, `AutoFiledGroup`) — model for new `AgendaItem` / `CalendarActivityRow` types.
- Phase 4 Sonnet narrative builder (location to be confirmed by researcher in `apps/web/utils/ai/` per Phase 4 CONTEXT files_of_interest) — extend its prompt input, do not replace.
- `packages/resend/scripts/render-digest-v2.ts` + `send-digest-v2-test.ts` — Phase 4 dev helpers usable for Phase 10 visual review.

### Touch points
- `packages/resend/emails/digest-v2.tsx` — extend `DigestV2Props` and main render tree; add new sub-components (likely co-located or split out).
- `apps/web/app/api/resend/digest/route.ts` (or wherever Phase 4 ended up) — add agenda + reconciliation fetches; pass into props builder.
- Sonnet narrative prompt — append AGENDA + RECONCILIATIONS context blocks, add "do not invent" / "weave naturally" instructions.
- React Email + Tailwind — per memory `react_email_partial_borders`, pair partial-side borders (`border-t`, `border-l-*`) with `border-0` to avoid 3px default rendering.

### Patterns
- Pure helper + props-builder + render-component split (Phase 4 + Phase 9 idiom): overlap detection is a pure function on `NormalizedCalendarEvent[]`; agenda + activity props are built by a pure transformer; the React component is dumb.
- Failure isolation via try/catch + degrade-gracefully (Phase 8 + Phase 9 idiom): each new data fetch is wrapped; digest still sends if agenda or reconciliation fetch throws.

</code_context>

<deferred_ideas>
## Noted for Later (not Phase 10)

- AMBIGUOUS-review UI inside `inbox.tdfurn.com` (approve/reject from web, not via Gmail).
- Full 7-day agenda view (calendar widget rendering, not just Today+Tomorrow morning).
- Same-day overlap push/SMS alert (digest-only signal in v1).
- Cross-day overlap detection (intentionally excluded by D-10).
- Surfacing `FAILED`/`PENDING` reconciliations to the user (currently log-only per D-16; could become an "issues" subsection later if rate is non-trivial).
- Per-event quick actions in the agenda (snooze, link to Calendar event, add note) — Phase 10 is read-only render.

</deferred_ideas>

<open_questions_for_planner>
## Planner Questions — RESOLVED during plan-phase + execution

**Resolved 2026-06-01 (Phase 10 shipped + verified; cleared at v1.1 milestone close).** These were planner-input questions, all answered when Phase 10 was planned and executed. The Sonnet token-delta (Q3) and Gmail pill rendering (Q6) human-verification items were satisfied by the user's calendar-integration testing. Retained below as historical record.

1. **Where exactly did Phase 4 land the digest send pipeline + Sonnet narrative builder?** Phase 4 CONTEXT noted "rewrite-in-place vs new route" was a plan-phase decision. Confirm the current file layout before deciding where to wire the new data fetches.
2. **Marketing/Calendar rule interaction.** Phase 9 D-09 added a `Calendar` classifier rule. Does its DIGEST action (if any) produce DigestItem rows that would double-count in the digest (once as a DigestItem under Notifications/Marketing, once as a Calendar Activity row)? Likely no — Calendar-labeled emails skip the DIGEST action by design — but verify.
3. **Sonnet token-delta measurement.** Capture before/after `input_tokens` in `saveAiUsage` for the first 3 digest sends post-deploy. Confirm ≤+1000 tokens/digest delta. Roll back narrative integration if delta exceeds budget.
4. **All-day event collation.** When multiple all-day events exist (e.g., a birthday + a school holiday), render order? Probably alphabetical or as-fetched; minor.
5. **Day-name format in CREATED sentences.** "Added Dentist Mon 9am" vs "Added Dentist Monday at 9:00 AM" vs relative "Added Dentist tomorrow at 9". Pick one; consistency matters more than which.
6. **Email-safe pill rendering.** The `[⚠ overlaps]` inline pill needs to survive Gmail's CSS stripping (Phase 4 had similar issues). Plan-phase verifies in real Gmail rendering before merge.

</open_questions_for_planner>
