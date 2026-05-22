# Requirements — Milestone v1.1: Calendar-Aware Email

**Goal:** Make the AI email pipeline calendar-aware so emails referencing dates/times are reconciled against the user's Google Calendar — either matched to an existing event or used to create a new one — and the daily digest both leads with today's agenda and reports the result of every reconciliation so the user is reassured nothing scheduled was missed and overlaps surface before they bite.

**Use-case framing (v1.1 is personal, not business):** This is single-user personal logistics — doctor appointments, kids' classes, camping reservations, birthdays, important reminders. Typical volume is 1–3 events/day. Senders are usually `noreply@` addresses (Orlando Health, REI, schools), NOT human attendees of the event. The calendar is **the thing being reconciled against**, not a relevance filter for incoming mail.

**Constraints carried from v1.0:**
- AI cost ≤$10/mo additional total
- Single tenant (rebekah@trueocean.com)
- Minimally invasive to upstream fork
- Extraction and reconciliation must ride the Haiku tier wherever possible (Sonnet only for digest narrative + true escalations, same policy as v1.0)

---

## v1.1 Requirements

### CAL — Calendar Sync Foundation

- [ ] **CAL-01** — The application fetches upcoming Google Calendar events (next 7 days, primary calendar only) and exposes them through a single cached read path consumed by every downstream feature
- [ ] **CAL-02** — Calendar events the user has declined or marked tentative are excluded from the cached event list and never reach extraction, reconciliation, or digest rendering
- [ ] **CAL-03** — The event cache is keyed per email-account and refreshed at most once per N minutes so downstream features do not hit the Calendar API per email

### REC — Email ↔ Calendar Reconciliation

- [ ] **REC-01** — A cheap pre-filter (regex/keyword + .ics attachment detection) identifies likely event-bearing emails before any LLM extraction runs, so AI cost is incurred only on real candidates
- [ ] **REC-02** — Event-bearing emails are sent through an AI extraction step that produces a candidate event with title, start/end (resolved to user TZ), location (if present), and any people mentioned
- [ ] **REC-03** — Each extracted candidate is reconciled against the cached calendar events and lands in exactly one bucket:
  - `MATCHED` — confidently matches an existing event (no new event created)
  - `CREATED` — no existing match; a new event is created on the primary calendar
  - `AMBIGUOUS` — a near-match exists but the system is not confident; no new event created, flagged for digest review
- [ ] **REC-04** — Reconciliation results are persisted (linked to the source email + the matched-or-created calendar event ID) so the digest and any future UI can read the outcome without re-running extraction
- [ ] **REC-05** — Re-processing the same email (replays, history syncs) is idempotent — dedupes by message ID + extracted event signature, never produces a duplicate event or duplicate reconciliation record
- [ ] **REC-06** — Reconciliation is strictly create-new or match-only — the system never modifies an existing calendar event (no time updates, no location updates, no cancellations from email). Reschedule emails ("moved to Tuesday") land as `AMBIGUOUS` for digest review

### EVT — Auto-Created Event Quality

- [ ] **EVT-01** — `.ics` invites attached to incoming emails are recognized by the pre-filter and feed the same reconciliation flow (existing `analyzeCalendarEvent` parser stays the .ics extraction path)
- [ ] **EVT-02** — Plain-text appointment detection (e.g. "Reminder: Rebekah will see Dr. Jones on Monday 5/25 at 3pm") is handled by the AI extraction step in REC-02 — no separate code path
- [ ] **EVT-03** — Newly created events (REC-03 `CREATED` bucket) include a back-reference to the source email (Gmail thread URL + message ID) in the event description
- [ ] **EVT-04** — Newly created events are tagged on the calendar (event color OR summary prefix like `[AI]`) so the user can identify and delete AI-created entries
- [ ] **EVT-05** — Event creation failures (API errors, quota, conflicts) do not block email classification or digest delivery — failure is logged with enough detail to debug; the email still gets classified

### DIG — Digest Enrichment

- [ ] **DIG-01** — The 9am ET daily digest opens with a "Today" section showing all events from 9am ET through midnight ET that day, so the user is oriented to the day before opening the calendar app
- [ ] **DIG-02** — The digest includes a "Tomorrow" section showing events from 6am–noon next day (so morning commitments are not a surprise)
- [ ] **DIG-03** — Each agenda item shows start time (ET), end time, title, location (if any), and a conflict indicator when two events overlap
- [ ] **DIG-04** — When the day is empty, the digest renders a friendly fallback ("Nothing on the calendar today") rather than an empty section
- [ ] **DIG-05** — For each reconciliation in the last 24h, the digest renders a one-line outcome:
  - `MATCHED` → "[Sender] confirmed [event title] — already on your calendar"
  - `CREATED` → "Added [event title] [day/time] to your calendar (from [sender])" with source email link
  - `AMBIGUOUS` → "[Sender] looks like it's about [extracted detail] — review" with source email link

### OPS — Operational Resilience

- [ ] **OPS-01** — Calendar API failures (rate limit, expired token, network) degrade gracefully — extraction skips, reconciliation skips, digest ships without agenda section, errors are logged with enough detail to debug
- [ ] **OPS-02** — Token cost of the new extraction and reconciliation steps is measured and total AI spend stays within the existing AI budget (≤$10/mo additional total); if measurement shows otherwise, the pre-filter (REC-01) tightens or extraction payload trims before milestone close
- [ ] **OPS-03** — Anthropic prompt caching is enabled on the constant-prefix portion of the v1.0 Haiku classification prompt (system prompt, categories, user-info block, rules list), the Anthropic Console shows non-zero `cache_read_input_tokens` within 24h of deploy, and the cut point is documented so Phase 9's extraction prompt inherits the pattern

---

## Future Requirements (Deferred)

- Reply-time awareness using calendar availability (e.g., "propose Tuesday 2pm" in AI draft replies) — out of v1.1 scope (separate code path in `utils/ai/calendar/availability.ts` already exists for the assistant)
- Meeting briefings emailed to the user (repurpose upstream meeting-briefs system) — out of v1.1 scope
- Multi-calendar support beyond primary calendar — single-calendar only for v1.1
- Microsoft / Outlook calendar — Google only
- Modifying existing events from email (reschedule/cancel updates) — REC-06 keeps reconciliation strictly create-or-match; modification deferred until reconciliation accuracy has a track record
- A UI to review `AMBIGUOUS` reconciliations beyond the digest line — digest links to source email; deeper review surfaces are out of scope for v1.1

## Out of Scope

- Calendar OAuth flow (already connected for rebekah@trueocean.com)
- Sending invites on behalf of the user — read + create only, no outbound invites
- Sharing or multi-tenant calendar features
- Urgency-classification bias from calendar proximity — the v1.0 three-tier classifier is unchanged in v1.1; calendar context flows through the reconciliation surface, not the classification prompt

## Traceability

| REQ-ID | Phase |
|--------|-------|
| CAL-01 | 8 |
| CAL-02 | 8 |
| CAL-03 | 8 |
| OPS-03 | 8.5 |
| REC-01 | 9 |
| REC-02 | 9 |
| REC-03 | 9 |
| REC-04 | 9 |
| REC-05 | 9 |
| REC-06 | 9 |
| EVT-01 | 9 |
| EVT-02 | 9 |
| EVT-03 | 9 |
| EVT-04 | 9 |
| EVT-05 | 9 |
| DIG-01 | 10 |
| DIG-02 | 10 |
| DIG-03 | 10 |
| DIG-04 | 10 |
| DIG-05 | 10 |
| OPS-01 | 9 |
| OPS-02 | 9 |
