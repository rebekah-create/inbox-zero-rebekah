# Phase 8: Calendar Context for Classification — Context

**Gathered:** 2026-05-22
**Status:** Ready for planning
**Requirements:** CTX-01, CTX-02, CTX-03, CTX-04, OPS-02

<domain>
## Phase Boundary

Pipe upcoming Google Calendar events (next 7 days, primary calendar) into the Haiku classification prompt on every classification call, with a Redis-cached per-account event list and precomputed sender/subject/proximity match signals so urgency bias (24h → Urgent, 1–7d → Uncertain) is both LLM-guided and traceable in `ExecutedRule.reason`. Token cost of the new context is instrumented per call and rolled up nightly so Phase 8 cannot close until OPS-02 (total AI spend ≤ $10/mo) is empirically confirmed over a 7-day trial.

**Not in scope for Phase 8:**
- Auto-creating calendar events from emails (Phase 9 / 10).
- Digest calendar agenda section (Phase 11).
- Sonnet narrative / digest changes — Phase 8 only touches the Haiku classification path.
- Multi-calendar, non-primary calendar, or Microsoft/Outlook (deferred per REQUIREMENTS).
- Calendar OAuth flow — already connected for `rebekah@trueocean.com`.
- Reply-time availability hints in drafts (out of v1.1 scope; existing `utils/ai/calendar/availability.ts` is a separate code path).
</domain>

<carry_forward>
## Carry-Forward Facts (from v1.0 + scouted code)

- **Three-tier AI is locked:** rules (free) → Haiku → Sonnet. Phase 8 only touches the Haiku tier. Sonnet digest narrative is unchanged.
- **Cost is at ceiling (~$10/mo at 85 emails/day, Haiku-only).** Calendar context must measurably stay within budget or be trimmed before this phase closes (OPS-02 is a hard gate, not a stretch goal).
- **Anthropic credits are prepaid** — runaway token use is visible only at console.anthropic.com. Per-call token logging is needed to catch overruns early.
- **Substantial calendar infrastructure already exists in the fork:**
  - `apps/web/utils/calendar/client.ts` — `getCalendarClientWithRefresh()` handles OAuth + token refresh.
  - `apps/web/utils/calendar/providers/google-events.ts` — `GoogleCalendarEventProvider` already wraps `calendar.events.list`.
  - `apps/web/utils/ai/calendar/availability.ts` — `aiGetCalendarAvailability()` is a reference pattern for "LLM + calendar in same call" used by reply drafting.
  - `apps/web/utils/ai/assistant/chat-calendar-tools.ts` — chat tools that read calendar state.
- **Classification prompt build site** is `apps/web/utils/ai/choose-rule/ai-choose-rule.ts` (line ~188 and ~296 — two prompt blocks call `getUserInfoPrompt`). New calendar block plugs in next to those calls.
- **Redis is already a hard dependency** (BullMQ via Upstash on Redis URL). Use the existing client; no new infra.
- **`ExecutedRule.reason` is the auditing surface.** Whatever calendar signal influences a classification must show up there so Rebekah can read "Urgent — sender matches attendee of event 'Q2 review' starting in 18h" without opening logs.
</carry_forward>

<decisions>
## Implementation Decisions

### Prompt Integration

- **D-01: New helper `getCalendarContextPrompt({ emailAccount, now })`** returns the calendar block as a string. Called next to `getUserInfoPrompt` in `ai-choose-rule.ts`. Easiest to feature-flag or disable if OPS-02 measurement shows we've blown the budget. Does NOT modify `getUserInfoPrompt` (keeps the diff to that well-trodden helper minimal).
- **D-02: Always-on injection (no gating).** Every Haiku classification call receives the full event block. Deterministic, easy to measure, and at 85 emails/day with ~5 events/week the token cost is bounded by event count × per-event size — both controlled below. No two-pass or heuristic pre-filter (the complexity isn't justified at this volume).

### Event Fetching & Cache

- **D-03: Redis cache, key `calendar:events:{emailAccountId}`.** Reuse the existing Upstash Redis client. Cache value is a JSON-encoded list of normalized events. Survives app restarts and is shared across web + worker processes (single source of truth across all classification call sites).
- **D-04: TTL = 15 minutes.** At ~3.5 emails/hour peak that bounds Calendar API calls to ≤4/hr per account, well inside Google free quota. 15-min freshness window is acceptable for a personal email assistant (a meeting added now influences urgency within 15 min).
- **D-05: Window = next 7 days from "now" at fetch time.** Cache key does NOT vary by time of day — when consumed, the renderer prunes any event whose end-time has already passed. Past-events shed without a Calendar API round-trip.
- **D-06: Exclude declined and tentative events** at fetch time (CTX-03). Filter on Google's `responseStatus` for the calendar owner: keep `accepted` and `needsAction`, drop `declined` and `tentative`. Excluded events never enter the cache, so they never enter the prompt.
- **D-07: Stale-cache fallback on Calendar API failure.** If the live fetch fails (auth, network, quota) and a stale cached blob exists, use the stale data with a logged warning rather than dropping context entirely. If no cache exists at all, classification proceeds with no calendar block (OPS-01 spirit applied here even though OPS-01 formally lands in Phase 9).

### Event Payload Shape

- **D-08: Per-event fields in the prompt:** `title`, `start` (ET local), `end` (ET local), `attendees` (email addresses only), `location` (if present), `description` (truncated). All-day events render with a `(all-day)` marker instead of times. Organizer omitted (redundant with attendees + sender match).
- **D-09: Description truncation = plan-phase decides empirically.** Start at 200 chars; if OPS-02 measurement is over budget, the trim order is: description → location → attendees → (last resort) drop event-end. Title and start time are non-negotiable.
- **D-10: Time format = `Tue 2026-05-26 14:00 ET`.** Weekday + local-ET datetime in a format both Haiku and a human can read fluently. Also pass `now: <same format>` in the same block so the LLM can compute "today / tomorrow / this week" without TZ math.
- **D-11: Event ordering = chronological ascending** (soonest first). Cap at 20 events in the prompt — beyond that the next-7d window has either degenerated (recurring spam) or is genuinely overloaded, and Haiku gets diminishing returns from later entries.

### Urgency-Bias Mechanism

- **D-12: Precompute structured match signals server-side, pass alongside the event list.** Before the LLM call, for each event compute:
  - `matches_sender` — boolean; true if the email sender's address (case-insensitive) is in the event's attendee list.
  - `matches_subject` — boolean; true if any normalized token of the email subject overlaps with normalized tokens of the event title (drop stopwords, lowercase, length ≥ 4).
  - `starts_in_24h` — boolean.
  - `starts_in_7d` — boolean.
  Render these inline next to each event so Haiku sees both the raw event and the precomputed hints.
- **D-13: LLM remains the classifier, signals are hints, not overrides.** Haiku is still free to classify against the user's rules. The signals tilt toward Urgent (24h match) and Uncertain (7d match) but the LLM can override on context (e.g., recurring standup the user routinely skips). No hard rule short-circuiting the LLM.
- **D-14: `ExecutedRule.reason` must surface the matched event when a signal fired AND the classification ended Urgent/Uncertain.** Plan-phase decides the exact mechanism (post-hoc rendering from the structured signal block, or asking Haiku to cite the event in its reason). The user-visible result is unambiguous: "Urgent — matches event 'Q2 review' starting in 18h, sender is attendee."

### Token-Cost Instrumentation (OPS-02)

- **D-15: Log `promptTokens` + `completionTokens` per classification call**, persisted on the `ExecutedRule` row (add columns or, if Prisma migration cost is too high, attach a sibling table — plan-phase decides). Capture the model id too so future model swaps are auditable.
- **D-16: Nightly rollup query** (cron + small script, or a saved SQL view) computes daily token totals → estimated $ via per-model pricing → 7-day and 30-day extrapolations. Output emitted to logs daily; a manual command is also available to dump the latest numbers ad hoc.
- **D-17: Phase 8 cannot close until 7-day trial confirms total v1.1 AI spend projects ≤ $10/mo.** If over, trim payload per D-09 order, redeploy, and re-trial. This is a phase-close gate, not a stretch goal.
</decisions>

<deferred>
## Deferred Ideas / Out-of-Scope Captures

- **Multi-calendar / secondary calendar support** — primary only for v1.1 (per REQUIREMENTS).
- **Reply-time availability hints** — `utils/ai/calendar/availability.ts` already exists for the reply path; extending it into Phase 8's classification path is out of scope and would double the LLM surface.
- **Outlook / Microsoft calendar** — Google only (per REQUIREMENTS).
- **Calendar event editing/cancellation from email** — read + create only (Phase 9 sets the create path; modification is out of v1.1 scope).
- **Dynamic TTL based on user activity** — 15-min static for now; revisit only if cache hit rate analysis shows it matters.
- **Per-call feature flag to disable calendar context** — D-01's helper-based structure makes this trivial to add later if OPS-02 forces an emergency disable; not building the flag now.
</deferred>

<folded_todos>
## Folded Todos (none)

No pending todos matched Phase 8 scope. The `/etc/cron.d/inbox-zero` endpoint audit todo is operational and stays separate.
</folded_todos>

<canonical_refs>
## Canonical References (MUST read before planning)

**Project / milestone artifacts:**
- `.planning/ROADMAP.md` — Phase 8 section ("Calendar Context for Classification"), success criteria.
- `.planning/REQUIREMENTS.md` — CTX-01 through CTX-04, OPS-02 (binding token-budget gate).
- `.planning/PROJECT.md` — three-tier AI cost ceiling, single-tenant constraints.

**Codebase entry points:**
- `apps/web/utils/ai/choose-rule/ai-choose-rule.ts` — classification prompt build site (lines ~188 and ~296 are where `getUserInfoPrompt` is called; new calendar helper plugs in alongside).
- `apps/web/utils/ai/helpers.ts` — `getUserInfoPrompt`, `getTodayForLLM`. New `getCalendarContextPrompt` is the sibling helper.
- `apps/web/utils/calendar/client.ts` — `getCalendarClientWithRefresh` (OAuth + token refresh; reuse, do not reimplement).
- `apps/web/utils/calendar/providers/google-events.ts` — `GoogleCalendarEventProvider` (already wraps `calendar.events.list`).

**Reference patterns (similar problems already solved):**
- `apps/web/utils/ai/calendar/availability.ts` — `aiGetCalendarAvailability` is the closest existing "LLM + calendar in same call" pattern; mirror the OAuth + error-handling shape but produce context for the prompt rather than tool output.
- `apps/web/utils/ai/assistant/chat-calendar-tools.ts` — chat tool reading calendar state; useful for token-cost expectations and event-shape conventions.
- `apps/web/utils/redis/` — existing Redis utility patterns (e.g. `research-cache.ts` for read-through cache shape).

**Schema / migration touchpoint:**
- `apps/web/prisma/schema.prisma` — `ExecutedRule` model (new token-cost columns or sibling table per D-15).
</canonical_refs>

<code_context>
## Reusable Assets and Patterns

- **Google Calendar client + refresh** — `getCalendarClientWithRefresh` in `utils/calendar/client.ts` handles token refresh and SafeError surfaces. Reuse directly.
- **Event fetcher** — `GoogleCalendarEventProvider.fetchEvents*` methods in `utils/calendar/providers/google-events.ts` already speak `calendar_v3.Calendar`. The phase needs a thin "next 7 days, primary calendar, exclude declined/tentative" wrapper, not a new provider.
- **Prompt helper composition** — `getUserInfoPrompt` and `getTodayForLLM` in `utils/ai/helpers.ts` show the in-place helper pattern this phase mirrors.
- **Redis cache shape** — `utils/redis/research-cache.ts` (and friends) show the project's existing read-through cache pattern; copy its TTL + JSON-blob shape.
- **`ExecutedRule.reason` audit trail** — already user-visible per v1.0; calendar-aware reasons must land in this column to be discoverable without log diving.
</code_context>

<open_questions_for_research>
## For gsd-phase-researcher

1. **Exact Calendar API quota** under the existing OAuth scope — confirm 15-min TTL × 1 account stays well below quota even on a heavy day.
2. **Token-counting source** — confirm whether the Anthropic SDK currently used in `utils/llms/` returns `usage.input_tokens` / `usage.output_tokens` in every classification call path, or whether we need a separate `countTokens` pass before send.
3. **Prisma migration cost** for adding `promptTokens`/`completionTokens` columns to `ExecutedRule` (table size in prod?) vs. a sibling `ExecutedRuleTokens` table — pick the cheaper migration.
4. **Existing `utils/ai/calendar/availability.ts`** — does its error handling cover token-expired, network-timeout, and quota-exceeded cases cleanly enough to copy? Or does it short-circuit on errors in ways that wouldn't suit a classification hot path?
5. **Sample token-cost math** — given D-08 payload shape and ~5 events in a typical week, what's the estimated additional tokens/call (Haiku input)? Researcher should produce a rough number so plan-phase can sanity-check before we deploy.
</open_questions_for_research>

<verification_hooks>
## Things plan-phase / verify-work should check

- [ ] Cache key includes `emailAccountId` (single-tenant today, multi-tenant safe).
- [ ] Declined/tentative events truly never enter the prompt (test fixture with a declined event, assert it's absent from the rendered prompt string).
- [ ] All-day events render with `(all-day)` marker, not a 00:00–23:59 ET pair.
- [ ] `ExecutedRule.reason` for an Urgent classification with `matches_sender = true` mentions the matched event title.
- [ ] Calendar API failure → classification still completes (no calendar block in prompt, no thrown exception).
- [ ] Token logging populates on every classification call after deploy (spot-check one row in prod within 24h).
- [ ] 7-day token rollup confirms OPS-02 before phase close.
</verification_hooks>
