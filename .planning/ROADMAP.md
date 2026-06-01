# Roadmap: Personal Email AI

## Milestones

- ✅ **v1.0** — Three-tier classification + 9am ET daily digest (shipped 2026-05-17, Phases 1–7)
- ✅ **v1.1 Calendar-Aware Email** — Email ↔ Google Calendar reconciliation surfaced in the digest (shipped 2026-06-01, Phases 8–11)
- 📋 **v1.2+** — not yet planned (see Backlog; start with `/gsd-new-milestone`)

## Shipped Milestones

- **v1.0** *(2026-04-27 → 2026-05-17, 21 days)* — Three-tier classification pipeline + 9am ET daily digest with Sonnet narrative + production deploy on EC2. 7 of 7 phases complete (4 built, 3 closed by recognizing the spec was already satisfied by upstream features or manual triage). See [`milestones/v1.0-ROADMAP.md`](milestones/v1.0-ROADMAP.md) and [`milestones/v1.0-REQUIREMENTS.md`](milestones/v1.0-REQUIREMENTS.md).

- **v1.1 — Calendar-Aware Email** *(2026-05-22 → 2026-06-01, ~10 days)* — Reconciles email against the user's Google Calendar (match / create / flag) and surfaces the result in the daily digest. Phases 8 (calendar sync foundation), 8.5 (prompt-caching attempt — later descoped), 9 (reconciliation: Haiku extract + `.ics` → MATCHED/CREATED/AMBIGUOUS), 10 (digest agenda + reconciliation outcomes), 11 (time-overlap arbitration replacing title-Dice, adding RESCHEDULE). Milestone audit caught + closed two gaps at sign-off (RESCHEDULE digest surfacing; OPS-03 caching never engaged on Haiku → descoped). See [`milestones/v1.1-ROADMAP.md`](milestones/v1.1-ROADMAP.md), [`milestones/v1.1-REQUIREMENTS.md`](milestones/v1.1-REQUIREMENTS.md), and [`milestones/v1.1-MILESTONE-AUDIT.md`](milestones/v1.1-MILESTONE-AUDIT.md).

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
- **Audit `/etc/cron.d/inbox-zero` endpoints** — verify whether `/api/cron/automation-jobs`, `/api/cron/scheduled-actions`, `/api/watch/all` are needed in this self-hosted fork; delete the cron file if unused (carried from 2026-05-09)

Promote any of these into a future milestone via `/gsd-new-milestone` or `/gsd-review-backlog`.
