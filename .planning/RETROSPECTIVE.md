# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.1 — Calendar-Aware Email

**Shipped:** 2026-06-01
**Phases:** 5 (8, 8.5, 9, 10, 11) | **Plans:** 23–24 | **Timeline:** ~10 days (2026-05-22 → 2026-06-01)

### What Was Built
- Calendar sync foundation — single cached read path (`getUpcomingEvents`) for next-7-day primary-calendar events, with declined/tentative filtering and stale-fallback degradation.
- Email ↔ Calendar reconciliation — pre-filter → Haiku extraction (+ `.ics`) → MATCHED / CREATED / AMBIGUOUS, idempotent, `[AI]`-tagged events with Gmail back-ref, fully failure-isolated.
- Reconciliation v2 — time-interval overlap detection + a four-outcome Haiku arbiter (SAME / RESCHEDULE / SEPARATE / SKIP) replacing fragile title-Dice matching; non-destructive RESCHEDULE annotation.
- Daily digest agenda + reconciliation outcomes — today/tomorrow-morning agenda lead, per-reconciliation one-line outcomes including the Rescheduled line.

### What Worked
- **The milestone audit earned its keep.** `/gsd-audit-milestone` caught a CRITICAL produced-but-never-consumed gap (Phase 11's RESCHEDULE outcome was invisible in the Phase 10 digest) that manual UAT never would have — RESCHEDULE is low-frequency, so happy-path testing missed it.
- **"Verify the delivered artifact" caught a silent failure.** The user pasting the Anthropic Console ("you're not using prompt caching") turned a bookkeeping gap into a confirmed production failure (OPS-03). The root cause was documented *in the code's own comments* (wrong 1024-token floor) — reading the artifact, not the source's claims, is what surfaced it.
- **Reconcile-not-classify reframing.** Pivoting the v1.1 mental model from "calendar-aware classification (urgency context)" to "reconcile email against the calendar" matched the actual 1–3-events/day personal-logistics use case and produced a much cleaner design.
- Phase 11's deterministic-overlap + semantic-arbitration split (cheap interval math gates the expensive Haiku call) kept the cost model intact while fixing the false-positive AMBIGUOUS class.

### What Was Inefficient
- **OPS-03 shipped non-functional and sat inert for the whole milestone.** Prompt caching was built in Phase 8.5 and mirrored into Phases 9 and 11 against a 1024-token floor that doesn't apply to the Haiku tier those calls use (Haiku needs 2048). It never engaged, was never measured until milestone close, and the misbelief propagated across three files. A live cache-read check right after the 8.5 deploy (per the phase's own success criterion) would have caught it immediately.
- Phase 11 added the RESCHEDULE outcome without updating the Phase 10 digest consumer in the same change — a cross-phase contract gap that only surfaced at audit.

### Patterns Established
- **Audit before milestone close is non-negotiable** — it catches cross-phase contract gaps (produced-but-not-consumed) that per-phase verification misses.
- **Verify external/live signals against the artifact, not the spec's claims** — console dashboards, running containers, live DB. Code comments can confidently assert the wrong thing.
- **When adding a new enum/outcome, grep every consumer** — a new `ReconciliationOutcome` value needs the DB query filter, type unions, surface-sets, render switches, and the AI narrative context all updated together.
- **Tier-specific provider limits matter** — Anthropic's cacheable-prefix minimum differs by model tier (1024 Opus/Sonnet vs 2048 Haiku). Encoded in memory `project_haiku_prompt_cache_floor`.

### Key Lessons
1. A feature isn't done when the code ships — it's done when the delivered artifact is observed doing the thing. OPS-03 "passed" code review and shipped, but never worked.
2. Phase boundaries are where contracts silently drift. The RESCHEDULE gap and the OPS-03 floor error both lived at seams between phases/tiers.
3. Descoping is a legitimate, honest outcome. OPS-03 was the wrong tool at single-user volume; removing the inert code and reframing the requirement beat chasing a fix that would have raised cost.

### Cost Observations
- Whole pipeline runs on the economy/Haiku tier; AI spend held near the ~$10/mo ceiling.
- Prompt caching (intended to cut input cost ~90% on the cached prefix) delivered **zero** benefit — never engaged. No cost regression either (inert cache_control incurs no write premium).

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Key Change |
|-----------|--------|------------|
| v1.0 | 7 (4 built, 3 closed as already-satisfied) | Recognized upstream/manual tooling already satisfied several specs — closed rather than built |
| v1.1 | 5 | Milestone audit caught + closed 2 gaps at sign-off; descoping a non-viable requirement (OPS-03) accepted as a valid outcome |

### Top Lessons (Verified Across Milestones)

1. Audit what upstream / the live system already does before building (or before declaring done) — verified in both v1.0 (closed already-satisfied phases) and v1.1 (caught OPS-03 + RESCHEDULE at audit).
2. Verify the delivered artifact, not the source or the plan — running container, live console, real digest.
