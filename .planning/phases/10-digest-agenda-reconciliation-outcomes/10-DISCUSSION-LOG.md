# Phase 10 — Discussion Log

**Discussed:** 2026-05-23

## Gray areas presented

1. Layout & placement
2. Reconciliation outcomes section shape (+ link target)
3. Overlap / conflict semantics
4. Narrative integration & Tomorrow edge cases

User selected all four.

## Decisions

### Layout & placement
- **Q:** Where should the Today/Tomorrow Agenda block sit in the digest?
- **Options:** Top above narrative / Between narrative and Urgent / After Urgent+Uncertain
- **Choice:** Between narrative and Urgent
- **Rationale:** Calm-morning-read framing inherited from Phase 4 — narrative orients, agenda anchors the day, then action items.

### Reconciliation outcomes section shape
- **Q:** How should reconciliation outcomes (last 24h MATCHED/CREATED/AMBIGUOUS) be presented?
- **Options:** One section grouped by outcome / Chronological flat color-coded / Two sections (needs-review + activity log)
- **Choice:** One section, grouped by outcome (Review → Added → Confirmed)

### Source-email link target
- **Q:** What should source-email links open?
- **Options:** Gmail web URL / In-app deep link / Both
- **Choice (Other):** "Google Calendar open to the event if possible"
- **Resolution:** Primary link = `googleEventHtmlLink` from ReconciliationRecord. AMBIGUOUS rows (no event created) fall back to Gmail thread URL. MATCHED/CREATED with null link (legacy/error) also fall back to Gmail. Encoded as D-13.

### Overlap rule
- **Q:** What counts as overlap for the agenda overlap indicator?
- **Options:** Strict only / Strict + back-to-back <15min / Strict, exclude all-day
- **Choice:** Strict overlap, exclude all-day
- **Rationale:** Avoids "all-day birthday overlaps with everything" noise.

### Overlap UI
- **Q:** Where does the overlap indicator render?
- **Options:** Inline pill per row / Visual grouping with shared border / Summary line at top
- **Choice:** Inline pill `[⚠ overlaps]` on each overlapping row

### Narrative integration
- **Q:** Should Sonnet's narrative reference the agenda and reconciliations?
- **Options:** Agenda-aware / Inbox-only / Agenda-aware but no reconciliations
- **Choice:** Yes, agenda-aware narrative (sees both agenda + reconciliations)
- **Rationale:** Richer single-glance morning read; ~500 input token delta acceptable within OPS-02 ceiling.

### Tomorrow window edge cases
- **Q:** Tomorrow window is 6am–noon; how to handle edge cases?
- **Options:** Strict 6–noon empty→friendly fallback / Strict empty→omit / Show 6–noon, if empty show next event later in day
- **Choice:** Show 6–noon; if empty, show next event later in day
- **Rationale:** Personal-logistics use case benefits from "first thing tomorrow" orientation even when before noon is empty.

## Deferred ideas (captured in CONTEXT)

- AMBIGUOUS-review UI in inbox.tdfurn.com
- Full 7-day agenda widget
- Same-day overlap push/SMS alert
- Cross-day overlap detection
- Surfacing FAILED/PENDING reconciliations
- Per-event quick actions

## Claude's discretion (documented in CONTEXT)

- Exact `DigestV2Props` field names
- File split vs inline for new sub-components
- Tailwind palette for Calendar Activity section
- Exact Sonnet prompt wording for AGENDA/RECONCILIATIONS blocks
- Fixture data shape for visual review
- Test pattern for overlap helper
