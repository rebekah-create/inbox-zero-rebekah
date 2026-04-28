# Phase 3: Classification Engine - Context

**Gathered:** 2026-04-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Every incoming email is automatically classified into exactly one of 8 categories (Receipts, Deals, Newsletters, Marketing, Urgent, 2FA, Uncertain, Greers List) within 2 minutes of arrival, using a three-tier pipeline: static rules first (free), then Haiku for uncertain cases, then Sonnet for hard cases only. Classified emails get the right action applied (label + archive, or label + stay in inbox). This phase delivers requirements CLASS-01 through CLASS-08.

**Not in scope for Phase 3:** Digest content (Phase 4), Rules UI (Phase 5), feedback signals (Phase 6), backlog triage (Phase 7).

</domain>

<decisions>
## Implementation Decisions

### Three-Tier Pipeline

- **D-01:** Tier 1 = static rules (free). Tier 2 = Haiku (`economy` model slot). Tier 3 = Sonnet (`default` model slot). Tiers run in order; a successful Tier 1 match skips Tiers 2 and 3.
- **D-02:** Haiku→Sonnet escalation trigger: `confidenceScore < 0.8` OR `noMatchFound = true`. Both conditions independently trigger escalation. Threshold of 0.8 chosen as the balance point between cost and accuracy.
- **D-03:** `confidenceScore: z.number().min(0).max(1)` must be added to the Zod schema in `ai-choose-rule.ts` (both single-rule and multi-rule modes). The score is persisted to `ExecutedRule.confidenceScore Float?` via a Prisma migration (the first migration in Phase 3).

### Classification Rules

- **D-04:** Replace the 6 existing content-classification rules (Cold Email, Calendar, Newsletter, Marketing, Notification, Receipt) with 8 new canonical rules. Keep the 4 conversation-management rules (To Reply, FYI, Awaiting Reply, Actioned) — they continue to fire automatically via Inbox Zero's existing mechanism.
- **D-05:** The 8 canonical rules and their actions:
  - **Receipts** — LABEL + ARCHIVE + DIGEST
  - **Deals** — LABEL + ARCHIVE + DIGEST
  - **Newsletters** — LABEL + ARCHIVE + DIGEST
  - **Marketing** — LABEL + ARCHIVE (no digest — too noisy)
  - **Urgent** — LABEL only (stays in inbox) + DIGEST
  - **2FA** — LABEL + DELETE after 24h (via `delayInMinutes: 1440`)
  - **Uncertain** — LABEL only (stays in inbox) + DIGEST
  - **Greers List** — LABEL + ARCHIVE (static from-address rule — Tier 1, never reaches AI)
- **D-06:** The 4 conversation-management rules are EXCLUDED from the 8-category classification prompt. The classification prompt passed to Haiku/Sonnet contains only the 8 content rules. Conversation rules run in parallel via Inbox Zero's existing mechanism.
- **D-07:** `multiRuleSelectionEnabled = false` — single category per email.

### "Uncertain" Category

- **D-08:** Uncertain is an explicit Rule in the database (not a code-level fallback). The AI can actively select it. Instructions: "Emails that don't clearly fit any of the other categories — ambiguous content, unclear sender intent, or mixed signals."
- **D-09:** Uncertain emails stay in the Gmail inbox (not archived) AND appear in the Phase 4 digest with thumbs-up/down feedback links (DIGEST-05). The Uncertain rule must have LABEL + DIGEST action rows, no ARCHIVE.

### Greers List

- **D-10:** Greers List is a Tier 1 static rule matching `from: greers@trueocean.com`. Never reaches Haiku or Sonnet. Cost: $0. Action: LABEL + ARCHIVE.

### 2FA Detection

- **D-11:** 2FA is classified by AI (Haiku), not static regex. The classification rule instructions describe OTP characteristics clearly. Auto-delete happens via `delayInMinutes: 1440` on the DELETE Action row — existing BullMQ delayed action infrastructure handles this.

### Deals Category

- **D-12:** Deals rule instructions are broad to start: "Promotional emails offering discounts, sales, or limited-time offers on products or services." No store-specific thresholds at this stage. Specificity will be refined via Phase 6 feedback once real email data reveals what's landing in Deals vs. Marketing.

### SSM Configuration

- **D-13:** Before deploying Phase 3, set in AWS SSM:
  - `ECONOMY_LLM_PROVIDER=anthropic`
  - `ECONOMY_LLM_MODEL=claude-haiku-3-5` (or `claude-haiku-4-5` — verify latest Haiku model name at docs.anthropic.com before setting)

### Claude's Discretion

- Confidence score tie-breaking when exactly `= 0.8`: implement as `< 0.8` (strict less-than). Scores of exactly 0.8 stay with Haiku's result.
- Implementation of the prompt filter (how to exclude the 4 conversation rules): filter by `systemType IS NOT NULL AND systemType IN ('TO_REPLY', 'FYI', 'AWAITING_REPLY', 'ACTIONED')` exclusion, or by only passing rules with `systemType IN (<8 content types>)` — Claude to choose whichest is cleaner given the actual query structure.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 2 Recon (primary source — read before touching any existing code)
- `.planning/phases/02-inbox-zero-recon/RECON.md` — Complete component map: classification pipeline entry chain, rules engine, AI integration, database schema, 6 keep/replace/extend decisions, cost analysis. MUST READ before planning.

### Classification pipeline (files to read before modifying)
- `apps/web/app/api/google/webhook/route.ts` — Entry point: PubSub → webhook → `after()` deferral
- `apps/web/utils/ai/choose-rule/run-rules.ts` — Rule orchestration: calls matching logic, invokes AI
- `apps/web/utils/ai/choose-rule/match-rules.ts` — Tier 1 matching: static + learned pattern (GroupItem) short-circuit
- `apps/web/utils/ai/choose-rule/ai-choose-rule.ts` — Tier 2/3 AI call: model selection, Zod schema, prompt structure — **primary file to modify for tiered escalation**
- `apps/web/utils/llms/model.ts` — Model slot resolution: `getModel(user, "economy")` → Haiku; `getModel(user, "default")` → Sonnet
- `prisma/schema.prisma` — Database schema: Rule, Action, ExecutedRule (add `confidenceScore Float?`), Group, GroupItem

### Requirements (traceability)
- `.planning/REQUIREMENTS.md` §Classification — CLASS-01 through CLASS-08 (all 8 must be satisfied)
- `.planning/ROADMAP.md` §Phase 3 — Success criteria: 6 items, all must be TRUE

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `aiChooseRule()` in `ai-choose-rule.ts` — Keep the prompt structure and Zod schema; replace `modelType = "default"` with tiered call pattern (Haiku first, Sonnet on escalation)
- `matchesStaticRule()` in `match-rules.ts` — Already handles Greers List `from:` field matching; no changes needed for Tier 1
- `matchesGroupRule()` via GroupItem — Existing learned-pattern short-circuit is already the free Tier 1 fast path; keep as-is
- BullMQ delayed actions via `scheduleDelayedActions()` — Already exists for `delayInMinutes`; 2FA auto-delete uses `delayInMinutes: 1440` on a DELETE Action row

### Established Patterns
- `createGenerateObject()` with `promptHardening: { trust: "untrusted", level: "full" }` — All AI calls must use this wrapper, not raw `generateObject()`
- `getModel(emailAccount.user, "economy")` returns Haiku when ECONOMY_LLM_PROVIDER is set, falls back to Sonnet if unset — SSM vars must be set before deploy
- Rule-to-prompt serialization via `getUserRulesPrompt({ rules })` — Pass only the 8 content rules (filter out the 4 conversation rules before calling)
- Prisma migration flow: add `confidenceScore Float?` to `ExecutedRule` model, run `prisma migrate dev`, deploy migration first

### Integration Points
- `findPotentialMatchingRules()` in `match-rules.ts` — This is where the 4 conversation rules should be filtered out of the AI candidate list
- `executeMatchedRule()` — Where Action rows drive behavior; 2FA DELETE action via `delayInMinutes: 1440` hooks into existing delayed action scheduler
- `executedRule.create()` — Add `confidenceScore` field write here after the AI call returns

</code_context>

<specifics>
## Specific Ideas

- The Haiku→Sonnet escalation is a two-call pattern in `ai-choose-rule.ts`: first call with `getModel(..., "economy")`, check confidence/noMatchFound, second call with `getModel(..., "default")` only if threshold not met.
- Greers List FROM match is `greers@trueocean.com` exactly — this is a Google Group so all messages from the group share this address.
- The existing Newsletter rule has a DIGEST action row — when replacing it, transfer that DIGEST action to the new Newsletters rule (critical: the digest currently receives items only from this rule).
- Uncertain rule instructions should make it explicit that Uncertain is the "I genuinely don't know" bucket — not a catch-all for anything slightly ambiguous. The AI should prefer other categories when any reasonable match exists.

</specifics>

<deferred>
## Deferred Ideas

- Per-sender deal thresholds (Harbor Freight ≥20%, Home Depot power tools only) — Phase 6 / v2 DEAL-01, DEAL-02 after real email data is available
- Automatic confidence-based graduation to Gmail filters — v2 LEARN-01, needs Phase 3 confidence data first
- Classification accuracy dashboard / monitoring — v2 MON-01, MON-02

</deferred>

---

*Phase: 3-classification-engine*
*Context gathered: 2026-04-27*
