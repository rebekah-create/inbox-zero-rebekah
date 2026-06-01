# Milestones

## v1.1 Calendar-Aware Email (Shipped: 2026-06-01)

**Phases completed:** 5 phases (8, 8.5, 9, 10, 11), 23 plans. Shipped over ~10 days (2026-05-22 → 2026-06-01).

**Delivered:** Email is now reconciled against the user's Google Calendar — matched, created, or flagged — and the result surfaces in the daily digest, so nothing scheduled slips through and overlaps surface before they bite.

**Key accomplishments:**

- **Calendar sync foundation (Phase 8):** a single cached read path (`getUpcomingEvents`) for the next 7 days of primary-calendar events — declined/tentative excluded at fetch, per-account Redis cache with stale-fallback degradation so Calendar API hiccups never block downstream features (CAL-01..03).
- **Email ↔ Calendar reconciliation (Phase 9):** a cheap pre-filter gates Haiku extraction; both `.ics` invites and plain-text bodies resolve to MATCHED / CREATED / AMBIGUOUS; created events are tagged `[AI]` with a Gmail back-ref; idempotent and failure-isolated so reconciliation never blocks classification or digest delivery (REC-01..06, EVT-01..05, OPS-01..02).
- **Reconciliation v2 — time-overlap arbitration (Phase 11):** replaced fragile title-similarity (token-Dice) matching with deterministic time-interval overlap detection plus a four-outcome Haiku arbiter (SAME / RESCHEDULE / SEPARATE / SKIP), eliminating false-positive AMBIGUOUS collisions on shared generic words like "Class". RESCHEDULE inserts the new event and non-destructively annotates the old one (never modifies its time).
- **Daily digest agenda + reconciliation outcomes (Phase 10):** the 9am ET digest now leads with today + tomorrow-morning agenda (overlap indicators, friendly empty-day fallbacks) and renders a one-line outcome for every reconciliation in the last 24h — including the new "Rescheduled" line (DIG-01..05).
- **Milestone audit caught and closed two gaps before sign-off:** (1) RESCHEDULE outcomes weren't surfaced in the digest — a silent functional hole, now fixed and deployed; (2) OPS-03 prompt caching never engaged in production — the cacheable minimum is 2048 tokens for the Haiku tier every cached path uses, but prompts were sized ~1500 tokens against the wrong 1024-token floor. Removed as inert and OPS-03 descoped as not-viable at single-user volume.

**Known deferred items at close:** none blocking. Pre-existing v1.0 recon checks (Phase 2) and stale planner questions (Phases 4, 10) were resolved at close; the `/etc/cron.d/inbox-zero` endpoint audit remains a carried-forward backlog todo.

---
