# Roadmap: Personal Email AI

## Shipped Milestones

- **v1.0** *(2026-04-27 → 2026-05-17, 21 days)* — Three-tier classification pipeline + 9am ET daily digest with Sonnet narrative + production deploy on EC2. 7 of 7 phases complete (4 built, 3 closed by recognizing the spec was already satisfied by upstream features or manual triage). See [`milestones/v1.0-ROADMAP.md`](milestones/v1.0-ROADMAP.md) and [`milestones/v1.0-REQUIREMENTS.md`](milestones/v1.0-REQUIREMENTS.md) for full detail.

## Current Milestone: v1.1 — Calendar-Aware Email

**Goal:** Reconcile email against the user's Google Calendar — match existing events, create new ones, flag the ambiguous ones — and surface the result in the daily digest so the user is reassured nothing scheduled was missed and overlaps surface before they bite.

**Use-case framing:** Personal life logistics (doctor appointments, kids' classes, camping reservations, birthdays) at ~1–3 events/day. The calendar is the thing being reconciled against, not a relevance filter for incoming mail. See REQUIREMENTS.md for the use-case framing in full.

**Phase numbering continues from v1.0:** v1.1 starts at Phase 8. Original Phase 10 (separate AI extraction phase) folded into Phase 9 — v1.1 is now 3 phases instead of 4.

### Phase 8: Calendar Sync Foundation

**Goal:** Fetch + Redis-cache the user's primary-calendar events (next 7 days, declined/tentative excluded) and expose a single read path that downstream phases consume. No prompt injection, no urgency bias — pure plumbing.

**Requirements:** CAL-01, CAL-02, CAL-03

**Success criteria:**
1. A single cache-aware read function returns normalized events for the next 7 days
2. Declined and tentative events are excluded at fetch time and never enter the cache
3. Cache is keyed per email-account, TTL bounded so Calendar API calls are well within Google's free quota
4. On Calendar API failure with a stale cache present, the stale data is returned with a logged warning; with no cache present, an empty list is returned and downstream callers degrade gracefully

**Plans:** 2/3 plans executed

Plans:
- [ ] 08-PLAN-01-types-and-pure-helpers.md — D-02 type contract + pure isExcluded/normalize/pastPrune helpers with full unit-test coverage
- [ ] 08-PLAN-02-cache-and-read-path.md — Redis envelope cache + getUpcomingEvents single read path + integration tests
- [ ] 08-PLAN-03-oauth-scope-verification.md — soft-verify live OAuth grant matches CALENDAR_SCOPES (Phase 9 readiness check)

### Phase 8.5: Prompt Caching for Classification

**Goal:** Enable Anthropic prompt caching on the v1.0 Haiku classification prompt so the constant-prefix portion (system prompt, categories, user-info block, rules list) is cached, cutting input-token cost on the repetitive prefix to ~10% of uncached price. Phase 9's new extraction prompt then inherits the same caching pattern from day one.

**Requirements:** OPS-03

**Depends on:** None (the v1.0 classifier is the target; Phase 8 plumbing is independent)

**Success criteria:**
1. The constant-prefix portion of the classification system prompt is marked with `cache_control: { type: 'ephemeral' }` per Anthropic SDK conventions
2. The Anthropic Console usage dashboard shows non-zero `cache_read_input_tokens` within 24h of deploy
3. Average per-classification input cost (sum of `input_tokens` + `cache_read_input_tokens` × pricing) is measurably lower than the pre-deploy baseline
4. Caching is documented (which prompt segments cache, which vary) so Phase 9's extraction prompt can mirror the pattern without re-discovering the cut point

### Phase 9: Email ↔ Calendar Reconciliation

**Goal:** When an email references a date/time, extract the candidate event and reconcile it against the cached calendar. Result lands in one of three buckets — `MATCHED` (already on calendar), `CREATED` (new event added with `[AI]` tag + source-email back-ref), or `AMBIGUOUS` (near-match flagged for digest review). Strictly create-or-match — never modifies existing events.

**Requirements:** REC-01, REC-02, REC-03, REC-04, REC-05, REC-06, EVT-01, EVT-02, EVT-03, EVT-04, EVT-05, OPS-01, OPS-02

**Depends on:** Phase 8 (consumes the cached event list)

**Success criteria:**
1. Cheap pre-filter (regex/keyword + .ics detection) gates expensive LLM extraction — LLM runs only on candidates
2. Extraction produces title, start/end (user TZ), location, mentioned people from both `.ics` invites (via existing `analyzeCalendarEvent`) and plain-text bodies
3. Every extraction outcome persists as a reconciliation record linked to source email + (when applicable) calendar event ID
4. `MATCHED` never creates a new event; `CREATED` writes with `[AI]` tag + source email link in description; `AMBIGUOUS` writes no event
5. Reprocessing the same email is idempotent — dedupe by message ID + event signature
6. Calendar API or extraction failures log + do not block classification or digest delivery
7. Token cost measured per call; total v1.1 AI spend projects ≤ $10/mo before phase close

### Phase 10: Digest Agenda + Reconciliation Outcomes

**Goal:** Lead the 9am ET digest with today + tomorrow's agenda so the user is oriented to the day, and render a one-line outcome for every reconciliation in the last 24h (`MATCHED` / `CREATED` / `AMBIGUOUS`).

**Requirements:** DIG-01, DIG-02, DIG-03, DIG-04, DIG-05

**Depends on:** Phase 8 (event cache) and Phase 9 (reconciliation records)

**Success criteria:**
1. Digest opens with a Today section (9am ET → midnight ET) and a Tomorrow morning section (6am–noon next day)
2. Each agenda item renders time/title/location/overlap indicator
3. Empty days render a friendly fallback rather than a blank section
4. Each reconciliation in the last 24h renders one of three sentence shapes: "already on your calendar," "added to your calendar," "looks like it's about X — review"
5. `CREATED` and `AMBIGUOUS` lines link to the source email

---

## Coverage Check

| Category | Reqs | Phase |
|----------|------|-------|
| CAL | CAL-01..03 | 8 |
| OPS | OPS-03 | 8.5 |
| REC | REC-01..06 | 9 |
| EVT | EVT-01..05 | 9 |
| DIG | DIG-01..05 | 10 |
| OPS | OPS-01..02 | 9 |

All 20 v1.1 requirements mapped to a phase.

---

## Backlog (carries forward across milestones)

### Carried-Forward Deferred Items (from v1.0)

- **CLASS-09** — Gmail `CATEGORY_PROMOTIONS` clean-route to Marketing (added 2026-05-08, scope trimmed; pending)
- **FEEDBACK-06** — Inject accumulated feedback into classification prompt. Deferred unless accuracy degrades.
- **LEARN-01..03** — Pattern graduation to native Gmail filters; periodic prompt regeneration from feedback history
- **DEAL-01, DEAL-02** — Per-sender deal thresholds (e.g., Harbor Freight ≥20%, Home Depot power tools only)
- **MON-01, MON-02** — Classification stats dashboard + AI cost alerting

### Carried-Forward Deferred Items (from v1.1)

- Reply-time awareness using calendar availability in AI draft replies
- Meeting briefings emailed to the user (repurpose upstream meeting-briefs system)
- Multi-calendar support beyond primary calendar
- Microsoft / Outlook calendar parity

Promote any of these into a future milestone via `/gsd-new-milestone` or `/gsd-review-backlog`.
