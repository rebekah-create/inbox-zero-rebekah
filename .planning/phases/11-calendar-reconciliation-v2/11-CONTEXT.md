# Phase 11: Calendar Reconciliation v2 — Time-Overlap Arbitration — Context

**Gathered:** 2026-05-26
**Status:** Ready for planning
**Supersedes:** Phase 9 matching semantics (REC-04, REC-06 implementation).
**Depends on:** Phase 9 (orchestrator, persistence, extract.ts, .ics path are reused), Phase 8 (`getUpcomingEvents` cached read path).

<domain>
## Phase Boundary

Replace Phase 9's title-similarity (token-Dice) matching with **time-interval overlap detection on Haiku-extracted datetimes**, and use a second Haiku call to arbitrate semantic identity when an overlap exists. Eliminate the false-positive AMBIGUOUS class caused by shared generic tokens (`Class`, `Appointment`, `Reminder`, `Meeting`, `Dr.`, etc.), and introduce a `RESCHEDULE` outcome that **creates the new event and appends a non-destructive note to the old** — never modifies an existing event's time.

**In scope:**
- Replace `decideOutcome` (`match.ts`) for timed events with a pure interval-intersection function over Haiku-extracted candidate `[start, end]` vs each upcoming event's `[start, end]`.
- Delete `dice.ts`; reduce `match.ts` to all-day date-equality only (D-08 carries forward unchanged).
- Add a second Haiku call (extend `arbitrate.ts`) that runs **whenever an overlap exists**, not only on the current CREATED-overlap edge case. Output: `{ SAME | RESCHEDULE | SEPARATE | SKIP }` + optional `matchedEventId`.
- Add `RESCHEDULE` to `ReconciliationOutcome` enum and implement the "patch old event description" path via a new Google Calendar wrapper.
- Update `index.ts` orchestration to the new "extract → overlap query → arbitrate-if-overlap" sequence; remove the current 60-min title-overlap arbitration gate.
- New fixtures in the Phase 9 eval corpus (`09-08-PLAN.md` style) covering: music-class collision (Piano vs Math, both on same day), >14-day-out CREATE path, RESCHEDULE detection.

**Not in scope:**
- Reconciliation pre-filter (keyword backstop + Calendar classifier label) — unchanged.
- `.ics` fast path — explicitly retained as-is. iCalendar UIDs handle dedup; structured fields are authoritative. No Haiku involved.
- Reconciliation persistence schema beyond the enum addition.
- Digest rendering of the new `RESCHEDULE` outcome — Phase 10's concern (DIG-04 line variant). Phase 11 surfaces the outcome; Phase 10 phrases it.
- Removal of the old `AMBIGUOUS` enum value. Kept for back-compat with historical records (and the digest already renders it). New decisions will not emit AMBIGUOUS.
- Multi-calendar, Outlook, sender-aware matching — out of milestone scope.
</domain>

<carry_forward>
## Carry-Forward Facts (from Phase 9 + project)

- **Three-tier AI cost cap (≤$10/mo) is locked.** Both calls (extract + arbitrate) ride Haiku.
- **Personal-logistics use case.** 1–3 events/day. Senders are `noreply@orlandohealth.com`, REI, school portals — never human attendees. Sender-aware matching does not apply.
- **`getUpcomingEvents({ emailAccountId, now })`** is THE calendar read path (Phase 8). 7-day window. Declined/tentative excluded. Stale-fallback semantics intact. Phase 11 still consumes this — the new overlap query filters its result, doesn't replace it.
- **Anthropic prompt caching pattern.** Phase 8.5 + Phase 9 extract.ts use ephemeral cache_control on the static prefix. The new arbitration prompt MUST inherit the pattern.
- **`enqueueBackgroundJob` is dead in this fork** — reconciliation already runs inside Next.js `after(() => ...)`. Unchanged.
- **Reconciliation backstop is keyword-driven and classification-independent** (Memory: `project_reconciliation_backstop_semantics`). Phase 11 does not change this — the pre-filter stays.
- **2026-05-26 incident** (motivating bug):
  - Guitar Class email 7pm → MATCHED an existing 7pm event correctly (title sim ≥0.7).
  - Piano Class email 7:30pm → wrongly flagged AMBIGUOUS against a 4pm **Math** class. Token-Dice scored 0.5 on shared "Class" token, fell into Step 3 (same-day weak sim).
  - Under the new design: Piano 7:30pm time-overlaps the actual 7–8pm "Music lessons" block on the calendar; arbitration reads "Piano lesson" + "Music lessons" and returns SAME → MATCHED.
</carry_forward>

<decisions>
## Implementation Decisions

### Overlap detection (replaces D-06 / D-07)

- **D-01 — Pure interval intersection, no buffer.** Two events overlap iff `candidate.start < existing.end AND candidate.end > existing.start`. No ±60min buffer, no tunable knob. Tested as a pure function with no Prisma / no Google.
- **D-02 — Default end = start + 60min when missing, used everywhere.** When the Haiku extractor returns a `start` but no `end`, treat the candidate as a 60-min interval — for the overlap check **and** for the persisted Google Calendar event. Google requires an end time; most reminder emails for doctor appointments, music lessons, etc. give a start time only, so a sensible duration default is part of the user-visible contract, not internal. This aligns with the existing default at `apps/web/utils/calendar/reconciliation/create-event.ts:120-123` (which already writes `start + 60min` when `endISO` is null) — Phase 11 makes that the single source of truth and keeps the overlap check consistent with it. If a downstream "smarter default by event type" is wanted (e.g. 30-min for "lesson", 60-min for "appointment"), that's deferred (see deferred list).
- **D-03 — All-day path unchanged.** Phase 9's D-08 logic moves into `match.ts` and stays the sole responsibility of that file: date-string equality (`YYYY-MM-DD`) + (now) deferred to arbitration for title judgment rather than token-Dice. If candidate is all-day AND any existing event shares the date → arbitrate; otherwise CREATE.
- **D-04 — Token-Dice eliminated for timed events.** `dice.ts` is deleted. `match.ts` retains only the all-day date-equality branch. All title-based judgment moves to Haiku.

### Arbitration call (extends `arbitrate.ts`)

- **D-05 — Arbitration runs on ANY overlap.** Remove the current `outcome === "CREATED"` gate at `index.ts:266`. New gate: `overlaps.length > 0`. If no overlap, skip the call entirely and CREATE deterministically.
- **D-06 — Arbitration output schema:** Zod schema returns one of `{ verdict: "SAME" | "RESCHEDULE" | "SEPARATE" | "SKIP", matchedEventId?: string }`.
  - `SAME` → MATCHED (no Google call, no event creation).
  - `SEPARATE` → CREATED (insert new event).
  - `RESCHEDULE` → CREATED + PATCH old event's description (see D-09).
  - `SKIP` → safety valve for keyword false positives (e.g. "appointment book" in a marketing email that wasn't actually about an appointment). Record outcome as `FAILED` with `errorMessage="arbiter_skip"`; no event created.
- **D-07 — Arbitration context window.** Send Haiku the full schedule of the overlap day(s) — i.e. all events that share a calendar date with the candidate's `[start, end]` interval. Typically 1 day, but a candidate spanning midnight may cross to 2. Cheap in tokens; no need for wider context since the time-overlap query already pinpointed the day.
- **D-08 — Arbitration failure → CREATE fallback.** If the Haiku call throws, the schema parse fails, or Zod validation rejects, the orchestrator falls through to CREATED — under-creation is worse than over-creation. The failure is logged with structured fields per Phase 9 T-09-05 logging discipline. Never block the orchestrator.

### RESCHEDULE outcome (new)

- **D-09 — Non-destructive RESCHEDULE.** When arbiter returns `RESCHEDULE`:
  1. Insert the new event normally (with `[AI]` prefix + source-email back-ref, matching Phase 9 D-13 conventions).
  2. PATCH the old event: append `\n\n[Possibly rescheduled? See <new event html link>]` to its existing description. Never modify the old event's `start` / `end` / `summary` / `location`. Never call `events.delete`.
  3. Persist the reconciliation record with `outcome=CREATED`, `googleEventId=<new event id>`, and a new column or `errorMessage` field carrying `<reschedule_of:old_event_id>` so the digest can flag the linkage.
- **D-10 — Schema change.** Add `RESCHEDULE` to the `ReconciliationOutcome` enum. Decision on persistence: store `RESCHEDULE` distinctly (not folded into CREATED) so the digest can render the "looks like a reschedule of X" line cleanly. Migration is a simple enum addition — no data backfill since no existing records use the value.

### What gets deleted vs kept

- **D-11 — Files removed:** `apps/web/utils/calendar/reconciliation/dice.ts` (+ its tests).
- **D-12 — Files simplified:** `match.ts` loses the timed-event branches (Steps 1–3) and keeps only the D-08 all-day branch. Its test file shrinks accordingly.
- **D-13 — `index.ts` orchestration rewrite.** The post-D-06 region (`decideOutcome` call through the arbitration block at lines ~242–305) is replaced with: pure interval-overlap query → arbitrate-if-overlap → act on verdict. The pre-filter, idempotency, persistence, and failure-isolation regions are unchanged.
- **D-14 — `.ics` Path A unchanged.** Path A continues to bypass Haiku entirely. ICS gives clean structured fields and the iCalendar UID handles dedup. Phase 11 does not touch Path A.

### Eval / fixtures

- **D-15 — Eval corpus extension.** New fixtures added to the `09-08-PLAN.md`-style corpus:
  - Music-class collision (Piano "Piano Class" 7:30pm vs existing "Music lessons" 7-8pm block) → expect MATCHED via arbitration.
  - Math-vs-Piano disambiguation (Piano "Piano Class" 7:30pm vs existing "Math Class" 4pm same day) → no overlap → expect CREATED with NO arbitration call.
  - >14-day-out CREATE (camping reservation in August) → no overlap → CREATED deterministically.
  - True RESCHEDULE ("Your appointment has been moved to..." email when an existing same-title event sits at the old time) → expect RESCHEDULE.
  - Keyword false positive ("appointment book" in marketing email) → arbiter returns SKIP.
- **D-16 — RUN_AI_TESTS gating preserved.** The new evals piggyback on the existing `RUN_AI_TESTS=true` gate and the cost-projection harness from `09-09-PLAN.md`.

### Claude's Discretion

- Precise wording of the new arbitration prompt (delimiter tags follow Phase 9 D-04 `<email_body_untrusted>` convention; the calendar context block gets its own delimiter, e.g. `<calendar_context>`).
- Whether the RESCHEDULE linkage is persisted as a new nullable column `rescheduleOfEventId` or shoehorned into `errorMessage`. Planner picks based on cleanliness vs migration friction.
- Whether `match.ts` is deleted entirely (with the all-day branch folded into `index.ts`) or retained as a thin module. Planner decides based on test ergonomics.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 9 carry-overs (matching architecture being replaced)
- `.planning/phases/09-email-calendar-reconciliation/09-CONTEXT.md` — full Phase 9 design context. D-06/D-07 are the decisions being superseded.
- `.planning/phases/09-email-calendar-reconciliation/09-02-PLAN.md` — original `dice` + `decideOutcome` plan. The work being undone.
- `.planning/phases/09-email-calendar-reconciliation/09-06-PLAN.md` — orchestrator plan. The shape Phase 11 mutates.
- `.planning/phases/09-email-calendar-reconciliation/09-08-PLAN.md` — fixture corpus structure to extend.
- `.planning/phases/09-email-calendar-reconciliation/09-09-PLAN.md` — eval harness + cost-projection pattern to reuse.

### Phase 8 dependencies (unchanged)
- `.planning/phases/08-calendar-sync-foundation/08-CONTEXT.md` — `getUpcomingEvents` contract.

### Source files being touched
- `apps/web/utils/calendar/reconciliation/index.ts` — orchestrator (heavy rewrite of lines ~242–305).
- `apps/web/utils/calendar/reconciliation/match.ts` — simplified to all-day branch.
- `apps/web/utils/calendar/reconciliation/dice.ts` — **delete**.
- `apps/web/utils/calendar/reconciliation/arbitrate.ts` — extended with new schema + RESCHEDULE branch.
- `apps/web/utils/calendar/reconciliation/extract.ts` — unchanged (the extraction prompt already returns `{title, start, end, location, isAllDay}`).
- `apps/web/utils/calendar/reconciliation/persist.ts` — minor (new column or errorMessage convention for RESCHEDULE linkage).
- `apps/web/utils/calendar/reconciliation/create-event.ts` — add a `patchEventDescription` helper for the RESCHEDULE-old-event annotation.
- `apps/web/prisma/schema.prisma` — `ReconciliationOutcome` enum gains `RESCHEDULE`.

### Project-level
- `.planning/PROJECT.md` — three-tier AI cost cap.
- `CLAUDE.md` — repo conventions (Biome, no local typecheck, Windows shell rules).
- Memory: `project_reconciliation_backstop_semantics`, `project_v1_1_calendar_use_case`.

### Anthropic prompt caching pattern (Haiku call cost optimization)
- Phase 8.5 SUMMARY + Phase 9 `extract.ts` for the `cache_control: { type: 'ephemeral' }` pattern on the static system-prompt prefix.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`extract.ts`** — Haiku extraction Zod-schema'd output `{ title, start, end, location, isAllDay, confidence, attendees }`. Already cached prompt prefix. Phase 11 reuses unchanged.
- **`arbitrate.ts`** — Already exists for the "is this a duplicate?" tie-breaker in the narrow CREATED+overlap case. Phase 11 extends rather than rewrites: broaden output schema, broaden trigger gate.
- **`createCalendarEvent`** (`create-event.ts`) — Phase 11 adds a sibling `patchEventDescription` (Google `events.patch` with description-only delta).
- **`getUpcomingEvents`** — Phase 8 cached read path. Already returns timed AND all-day events normalized. Filtering down to "events that overlap [start, end]" is a pure JS operation on its result.

### Established Patterns
- **Failure isolation** (`index.ts` outer try/catch, EVT-05/OPS-01): every new error path must respect "log + best-effort flip to FAILED + return without rethrowing". Arbitration failure fallback (D-08) follows this.
- **Structured logging discipline** (T-09-05): warn/error fields are `emailAccountId, messageId, threadId, outcome, errorCode, error` only. Never log extracted title/location/body. New arbitration paths inherit.
- **Prompt-injection defense** (D-04, D-05 in Phase 9): body wrapped in `<email_body_untrusted>` tags, 2000-char cap. New arbitration prompt adopts the same shape for the email body it sees, plus a separate `<calendar_context>` delimiter for the day's schedule.

### Integration Points
- **Orchestrator**: `apps/web/utils/calendar/reconciliation/index.ts` is the single touchpoint that calls into the new flow. `process-history-item.ts` doesn't change.
- **Schema migration**: One new enum value (`RESCHEDULE`). Optionally one new nullable column (`rescheduleOfEventId`). Both are safe additive migrations.
- **Digest (Phase 10 dependency)**: Phase 10's reconciliation-outcome renderer will need a new sentence shape for `RESCHEDULE` ("looks like a reschedule of X — see updated event"). Phase 11 ships the data; Phase 10 phrases it. Phase 10 is currently still pending plans — coordination is trivial.

</code_context>

<specifics>
## Specific Ideas

- **Motivating example (Piano vs Music block).** Real-world reality: two back-to-back 30-min lessons (Guitar then Piano) collapsed onto the calendar as a single 7–8pm "Music lessons" block. Both reminder emails should resolve to that single block via arbitration semantic equivalence — neither should ever be flagged AMBIGUOUS against unrelated same-day events.
- **Camping reservation pattern.** Confirmation emails can arrive 1–6 months ahead of the event. The new design dodges the "wide context window" tradeoff because the candidate's date pinpoints the lookup; no overlap on Aug 14 → deterministic CREATE.
- **RESCHEDULE non-destructive design.** User explicit: "Avoids deleting which has real world consequences if it got it wrong." Bias is toward additive annotation, reversible by hand if mis-fired.

</specifics>

<deferred>
## Deferred Ideas

- **AMBIGUOUS enum cleanup.** Removing `AMBIGUOUS` from the enum entirely (vs. keeping it for back-compat) is a future cleanup once historical records have aged out of digest visibility. Not blocking.
- **Stopword filter as defense-in-depth.** Earlier in discussion considered tagging "Class"/"Appointment"/"Reminder" as low-identity tokens. Made redundant by the time-overlap design — arbitration handles semantic identity directly. Revisit only if Haiku calls become a measured cost concern.
- **AMBIGUOUS-to-digest review UI.** Once Phase 10 ships, surfaces around reconciliation outcomes (a dedicated review page for FAILED/SKIP records) are a candidate for a later milestone.
- **Multi-day overlap edge case.** A candidate event spanning midnight (e.g. red-eye flight) crosses 2 calendar dates. D-07's "full schedule of overlap day(s)" handles this, but the prompt should be tested against a fixture. Plan-phase concern, not a blocker.
- **Smarter duration defaults by event type.** D-02 uses a flat 60-min default when extract returns no end time. A future refinement could have the Haiku extractor return a `defaultDurationMinutes` field informed by the email content (30-min for "lesson"/"checkup", 60-min for "appointment", 90-min for "evaluation", etc.), or post-process the extracted title. Out of scope for v2 — flat 60-min is a good baseline and matches existing behavior. Revisit if users report consistently-wrong end times.

</deferred>

---

*Phase: 11-calendar-reconciliation-v2*
*Context gathered: 2026-05-26*
