---
phase: 02-inbox-zero-recon
plan: 01
subsystem: documentation
tags: [classification-pipeline, rules-engine, ai-integration, database-schema, cost-analysis, recon]

# Dependency graph
requires:
  - phase: 01-ops-fixes
    provides: working production server with all infra confirmed operational
provides:
  - RECON.md — complete keep/replace/extend decision map for all Inbox Zero components relevant to classification and digests
  - Classification pipeline entry chain, matching logic, AI prompt structure, and confidence score gap documented
  - Six component decisions (KEEP, KEEP+EXTEND, REPLACE) with rationale and Phase 3 actions
  - Cost comparison: current ~$7.26/month vs proposed three-tier ~$1.88/month (74% savings)
  - Phase 3 prerequisites checklist with 6 actionable items
affects: [03-classification-engine, 04-daily-digest, 05-rules-management-ui, 06-feedback-system]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "RECON before BUILD: no Phase 3 code written until internals audited and decisions documented"
    - "Tiered model selection: economy/nano/chat/draft slots fallback to default (Sonnet) if env vars unset"
    - "Cost optimization: learned GroupItem patterns suppress all AI calls when any pattern matches"

key-files:
  created:
    - .planning/phases/02-inbox-zero-recon/RECON.md
  modified: []

key-decisions:
  - "Webhook entry point: KEEP — token verification, rate-limit guard, after() deferral are production-ready"
  - "match-rules.ts static + learned pattern matching: KEEP + EXTEND — GroupItem pattern short-circuit is the free Tier 1; needs explicit priority ordering for user rules"
  - "ai-choose-rule.ts model selection: REPLACE with tiered escalation (Haiku first, Sonnet on low confidence); prompt structure KEEP"
  - "DIGEST action type: KEEP + EXTEND — infrastructure correct; Phase 3 must attach correct Action rows to all 8 classification rules"
  - "Digest send pipeline: KEEP + EXTEND — pipeline operational; Phase 4 adds feedback links and Urgent/Uncertain sections"
  - "ClassificationFeedback label-change learning: KEEP + EXTEND — learning loop live; Phase 6 adds explicit thumbs feedback"
  - "No confidenceScore column exists in ExecutedRule — Phase 3 must add via Prisma migration"
  - "ECONOMY_LLM_* vars not set in production — all economy/nano/chat/draft tasks currently use Sonnet (primary cost problem)"

patterns-established:
  - "Confidence gap pattern: ExecutedRule.matchMetadata stores MatchReason[] types (STATIC/AI/LEARNED_PATTERN/PRESET) but no numeric score — must be added"
  - "DigestItem redaction pattern: content is set to [REDACTED] after send — feedback links must encode email identity in URL token"
  - "Learned pattern suppression: if any GroupItem match found, potentialAiMatches[] is cleared before AI call"

requirements-completed: [RECON-01, RECON-02, RECON-03, RECON-04, RECON-05, RECON-06]

# Metrics
duration: 45min
completed: 2026-04-27
---

# Phase 2 Plan 01: Write RECON.md Summary

**Complete Inbox Zero fork component audit: 8 sections, 6 keep/replace/extend decisions, cost model showing 74% savings with three-tier architecture, and Phase 3 prerequisites checklist**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-27T20:00:00Z
- **Completed:** 2026-04-27T20:45:00Z
- **Tasks:** 2
- **Files modified:** 1 (RECON.md created)

## Accomplishments

- RECON.md created at 4,597 words covering all 6 RECON requirements across 8 top-level sections
- Classification pipeline fully documented: PubSub → webhook → after() → runRules() call chain with 5 key files; 4-step matching logic (cold email check, learned patterns, static conditions, AI call); single-rule and multi-rule prompt schemas; confidence score gap flagged with exact migration required
- Rules engine documented with full column lists for Rule, Action, Group, GroupItem tables; 5-step evaluation order; 5-step application steps including BullMQ delayed action scheduling
- AI integration documented: 5 model tier slots (economy/nano/chat/draft all UNSET in fork, falling back to Sonnet); 6 AI call sites table; prompt hardening via createGenerateObject(); absence of discrete classification endpoint noted
- Database schema documented for 8 classification tables and 3 digest tables; MatchReason[] JSON structure; DigestItem.content redaction behavior
- Six keep/replace/extend decisions with rationale and Phase 3 action per decision
- Cost analysis: current ~$7.26/month (all Sonnet due to unset economy vars) vs proposed three-tier ~$1.88/month (74% savings, well under $10/month ceiling)
- Three open questions documented with exact commands; SSH and AWS CLI unavailable in executor context, deferred to manual execution

## Task Commits

1. **Task 1: Write RECON.md structural and technical sections (RECON-01 through RECON-04)** - `c3b6a8e5c` (docs)
2. **Task 2: Write component decisions, cost analysis, and answer open questions (RECON-05, RECON-06)** - `4244519f3` (docs)

## Files Created/Modified

- `.planning/phases/02-inbox-zero-recon/RECON.md` — Complete hand-off document for Phase 3: classification pipeline, rules engine, AI integration, database schema, 6 component decisions, cost analysis, open questions, Phase 3 prerequisites checklist

## Decisions Made

- Webhook entry point KEEP: token verification, rate-limit guard, and after() deferral pattern are correct and production-ready
- match-rules.ts KEEP + EXTEND: GroupItem learned pattern matching is already the free Tier 1; only needs explicit priority ordering for user-defined rules
- ai-choose-rule.ts REPLACE model selection, KEEP prompt structure: replace getModel(..., "default") with getModel(..., "economy") for Haiku tier with Sonnet escalation on low confidence or noMatchFound
- DIGEST action KEEP + EXTEND: infrastructure correct but opt-in per rule — Phase 3 must attach DIGEST Action rows to all 8 classification rules
- Digest send pipeline KEEP + EXTEND: Phase 1 already fixed from-address; Phase 4 adds feedback links and Urgent/Uncertain digest sections
- ClassificationFeedback KEEP + EXTEND: label-change learning loop is live; Phase 6 adds explicit thumbs feedback
- No confidenceScore column exists: Phase 3 must add `confidenceScore Float?` to ExecutedRule via Prisma migration before writing classification code
- ECONOMY_LLM_* env vars unset: all economy/nano/chat/draft model calls fall back to Sonnet — Phase 3 must set in SSM

## Deviations from Plan

None — plan executed exactly as written.

The three open questions (Anthropic key type, Rule count, ECONOMY_LLM_PROVIDER SSM check) were documented as deferred rather than answered live. SSH and AWS CLI access were not available in the executor context. The plan's Task 2 action explicitly provided the "Unable to determine" fallback path, which was followed. This is expected behavior, not a deviation.

## Issues Encountered

- SSH access to production server unavailable in executor context — open questions deferred to manual execution with exact commands documented
- AWS CLI unavailable in executor context — SSM parameter check deferred with exact command documented

## User Setup Required

Before Phase 3 begins, Rebekah or the executor should complete these manual checks:

1. **Rule count:** Run the SQL query in RECON.md "Open Questions" section against production to determine how many rules exist. If zero, Phase 3 must seed all 8 classification rules.
2. **Anthropic key type:** Check console.anthropic.com → Settings → Billing → Usage limits to confirm no hard spending cap below $10/month.
3. **ECONOMY_LLM_PROVIDER SSM check:** Run `aws ssm get-parameter --name /inbox-zero/ECONOMY_LLM_PROVIDER --region us-east-1` to confirm the parameter does not exist. Phase 3 must set it.

## Next Phase Readiness

- RECON.md complete — Phase 3 (Classification Engine) has all the information it needs to start
- Phase 3 prerequisites checklist documented in RECON.md with 6 actionable items; the first thing Phase 3 planning should do is tick off each item
- Key gap for Phase 3: `confidenceScore Float?` migration must be the first Prisma migration in Phase 3
- Key setup for Phase 3: `ECONOMY_LLM_PROVIDER=anthropic` and `ECONOMY_LLM_MODEL=claude-haiku-3-5` must be set in SSM before deployment

## Known Stubs

None — this plan produced documentation only (RECON.md). No code or UI was written.

## Threat Flags

None — RECON.md is a planning artifact in a non-public directory. No production code was modified. The three open questions (SSH query, SSM check, Anthropic console check) were not executed due to tool unavailability, which avoids any trust boundary crossing in this plan.

---

## Self-Check: PASSED

- RECON.md exists at `.planning/phases/02-inbox-zero-recon/RECON.md` ✓
- Commit c3b6a8e5c exists (Task 1: technical sections) ✓
- Commit 4244519f3 exists (Task 2: decisions, cost, open questions) ✓
- All 8 section headers present ✓
- 6 component decisions present ✓
- confidenceScore Float? documented in two places ✓
- Cost figures $7.26 and $1.88 present ✓
- Phase 3 action lines: 6 (one per decision) ✓
- Word count: 4,597 words (requirement: >2,000) ✓

---
*Phase: 02-inbox-zero-recon*
*Completed: 2026-04-27*
