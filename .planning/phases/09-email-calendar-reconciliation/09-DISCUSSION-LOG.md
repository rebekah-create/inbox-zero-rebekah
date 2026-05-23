# Phase 9: Email ↔ Calendar Reconciliation — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `09-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-05-22
**Phase:** 9-email-calendar-reconciliation
**Areas discussed:** Pre-filter strategy, Matching algorithm, Pipeline integration point, Persistence + idempotency, AI tagging

---

## Pre-filter strategy (REC-01)

| Option | Description | Selected |
|--------|-------------|----------|
| ICS + subject keyword | ICS attachment OR subject keyword hit | (revised, see below) |
| ICS + subject + sender allowlist | Adds curated event-sender allowlist | |
| ICS-only (defer plain-text) | Only `.ics` for v1; violates EVT-02 | |
| No pre-filter | Run Haiku on every email body | |

**User's choice:** First option as base, with a security concern raised: ICS attachments can carry prompt-injection content (user has seen ICS files attached to phishing in spam folder).

**Revised decision:** Two-path design — `.ics` uses deterministic `analyzeCalendarEvent()` (no LLM call → no injection surface); plain-text uses Haiku gated by classifier label OR subject keyword backstop, wrapped in `<email_body_untrusted>` delimited block with 2000-char body cap.

**Spam guard sub-decision:** User noted that the Gmail PubSub watch likely doesn't fire on spam-labeled threads in the first place — deferred to researcher to verify against existing webhook code rather than adding a defensive guard speculatively.

---

## Matching algorithm (REC-03, REC-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Time-window + fuzzy title | ±60 min window + Dice similarity ≥ 0.7 | ✓ (refined) |
| Time-window only | No title similarity | |
| Sender-aware matching | Attendee-email match boost | |
| Strict exact-match | Title exact + ±15 min window | |

**User's choice:** Time-window + fuzzy title (recommended).

**Claude refinement (accepted):** Extended title-similarity check from same-day-only to the full 7-day window so reschedule emails ("moved to Tuesday") land in `AMBIGUOUS` per REC-06 rather than producing a duplicate `CREATED` event. Final 4-step decision tree in CONTEXT.md D-06.

**Open for plan-phase:** Specific thresholds (0.7 strong, 0.4 weak, ±60 min) tuned against a real-inbox sample.

---

## Pipeline integration point (EVT-05/OPS-01)

| Option | Description | Selected |
|--------|-------------|----------|
| After-write via `after(() => ...)` | Separate Haiku call post-classification | (refined, see below) |
| Fold into existing classifier call | Extend `aiChooseRule` schema | |
| Async BullMQ job | Out-of-process worker | (rejected — no queue backend runs in fork) |

**User's choice:** Proposed a hybrid — reuse the existing classifier's Haiku call as the free pre-filter by adding a new `Calendar` label/category. If classifier picks `Calendar`, email proceeds to extraction. Keep subject-keyword matching as a backstop for misses.

**Final design:** Two-stage pipeline.
- **Stage 1 (free):** New `Calendar` rule added to v1.0 classifier. Classifier label OR keyword backstop = candidate.
- **Stage 2 (extraction):** Runs in `after(() => ...)` after response flush. Separate Haiku call (new prompt, cached system prefix per Phase 8.5 pattern) → structured event fields → reconciliation. Extraction failure cannot block classification or digest delivery.

**Open for plan-phase:** Action mapping for the new `Calendar` category (label + archive? label + keep in inbox?). Probably mirrors existing `Receipts` behavior — verify against user preference once we see real classifier output.

---

## Persistence + idempotency (REC-04, REC-05)

| Option | Description | Selected |
|--------|-------------|----------|
| New `ReconciliationRecord` model, unique on `(emailAccountId, messageId, eventSignature)` | Dedicated table with triple-unique constraint | ✓ |
| Same model, unique on `messageId` only | One reconciliation per message | |
| Reuse `ExecutedRule` / `ExecutedAction` JSON | No new model | |

**User's choice:** Dedicated `ReconciliationRecord` model with triple unique constraint.

**Rationale:** Unique constraint gives free P2002-based idempotency; lets one email reference two distinct events (different signatures); typed columns make Phase 10 digest queries clean. CONTEXT.md D-13..D-16 capture full schema + index + stale-row protection.

---

## AI tagging (EVT-04)

| Option | Description | Selected |
|--------|-------------|----------|
| `[AI]` summary prefix | Searchable + visible in every Calendar view | ✓ |
| Event color only | Visually distinct, not searchable | |
| Both prefix + color | Belt and suspenders | |

**User's choice:** `[AI]` summary prefix only. Matches ROADMAP.md success-criteria wording.

---

## Claude's Discretion

- Exact file layout under `apps/web/utils/calendar/reconciliation/` (`extract.ts`, `match.ts`, `persist.ts`, `create-event.ts`, `index.ts`) — plan-phase finalizes.
- `Calendar` rule provisioning mechanism (Prisma seed vs admin script vs rules-UI) — researcher confirms convention used for v1.0 categories.
- TDD plan structure — likely mirrors Phase 8 (pure helpers in isolation, then orchestrator with mocked Prisma/Google).
- Whether `getUpcomingEvents` returning empty-list (stale-fallback exhaustion) defaults the outcome to `CREATED` (degraded mode = better to risk a duplicate than silently lose a scheduling email) — verification hook flags this for explicit confirmation in plan-phase.

## Deferred Ideas

- UI to review AMBIGUOUS reconciliations beyond the digest line (v2).
- Modifying existing events from email (reschedule/cancel) — REC-06 hard constraint keeps Phase 9 create-or-match only.
- Event color tagging — `[AI]` prefix is sufficient for v1.1.
- Sender-aware matching boost — doesn't apply to personal-logistics use case.
- Manual `ReconciliationRecord` admin tools (cancel created event from record, force re-extract) — build only if real usage exposes a need.
- Outlook / Microsoft calendar — Google only for v1.1.
- Multi-calendar support — primary only for v1.1.
