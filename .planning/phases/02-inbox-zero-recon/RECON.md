# RECON.md — Inbox Zero Fork: Component Map and Decisions
Phase: 2 — Inbox Zero Recon
Date: 2026-04-27
Produced by: Phase 2 execution
Hand-off to: Phase 3 — Classification Engine

This document maps every major component of the Inbox Zero fork relevant to
classification and digests. Each component has a keep/replace/extend decision
with rationale. Phase 3 MUST read this document before writing any code.

---

## Classification Pipeline

### Entry Point

Full call chain from PubSub delivery to `runRules()`:

```
Google PubSub → POST /api/google/webhook
  → token verification (GOOGLE_PUBSUB_VERIFICATION_TOKEN)
  → getWebhookEmailAccount()
  → rate-limit check
  → after() — defers to background
    → processHistoryForUser()
      → getHistory()
      → processHistoryItem() for each history item
        → LABEL_REMOVED → handleLabelRemovedEvent() → saveClassificationFeedback()
        → LABEL_ADDED → handleLabelAddedEvent() → saveClassificationFeedback()
        → MESSAGE_ADDED → markMessageAsProcessing() → processHistoryItemShared()
          → fetchMessage() → runRules()
```

**Key files:**
1. `apps/web/app/api/google/webhook/route.ts` — PubSub entry point; token verification, account loading, rate-limit guard, `after()` deferral
2. `apps/web/app/api/google/webhook/process-history.ts` — history fetch loop; calls Gmail API for changed messageIds
3. `apps/web/app/api/google/webhook/process-history-item.ts` — event dispatch; routes LABEL_REMOVED, LABEL_ADDED, MESSAGE_ADDED to handlers
4. `apps/web/utils/ai/choose-rule/run-rules.ts` — rule orchestration; calls `findMatchingRules()`, executes matched rules, writes ExecutedRule
5. `apps/web/utils/ai/choose-rule/match-rules.ts` — matching logic; cold-email check, group pattern matching, static matching, AI call dispatch

### Inputs to Classification

Each email passes through `runRules()` as a `ParsedMessage` containing:
- `headers.from` — sender address (display name + email)
- `headers.to` — recipient address(es)
- `headers.subject` — email subject line
- `headers.date` — sent date header
- `textPlain` — plain text body
- `listUnsubscribe` — presence of List-Unsubscribe header; signaled to AI as a metadata hint
- `threadId` — Gmail thread identifier
- `messageId` — Gmail message identifier
- `internalDate` — Gmail internal timestamp (Unix ms)

### Matching Logic (ordered)

Matching runs in strict order. Short-circuits at the first definitive match:

1. **Cold email check** — `isColdEmail()` is called before all other rules. If the sender is identified as a cold email, the cold email rule is returned immediately and no further matching occurs.

2. **For each remaining rule:**
   a. **Learned patterns via `matchesGroupRule()`** — checks `GroupItem` rows attached to the rule's `groupId`. GroupItem types: FROM, SUBJECT, BODY. If a pattern matches (and is not an exclusion pattern), short-circuits to a match with `ConditionType.LEARNED_PATTERN` reason. If an exclusion pattern fires, the rule is skipped entirely.
   b. **Static conditions via `matchesStaticRule()`** — regex-tests the `from`, `to`, `subject`, and `body` fields of the rule against the message. Supports `*` wildcards. For `from`/`to` fields: supports pipe (`|`), comma, or ` OR ` as OR separators. Also tests display names (not just email addresses) for from/to matching.
   c. **AND/OR logic per rule via `conditionalOperator`** — if `LogicalOperator.OR`, a static match alone is sufficient; an AI condition alone will go to `potentialAiMatches`. If `LogicalOperator.AND`, both static AND AI must pass; a failed static check immediately eliminates the rule.

3. **AI call** — only if `potentialAiMatches.length > 0` AND no learned pattern already matched (learned patterns suppress all AI calls as a cost optimization). Calls `aiChooseRule()` with the subset of potential AI-match rules, classification feedback for the sender, and the email content.

4. **Conversation tracking** — a synthetic meta-rule is constructed from any `systemType` conversation status rules (TO_REPLY, FYI, etc.). This meta-rule is presented to the AI and resolved to a specific conversation rule (`determineConversationStatus()`) after main matching. Thread continuity is enforced: if the conversation meta-rule was applied to any earlier email in the thread, it is automatically re-applied without re-querying the AI.

### AI Prompt Structure

Single-rule mode (default when `multiRuleSelectionEnabled = false`):

**SYSTEM:**
```
"You are an AI assistant that helps people manage their emails."

<instructions>
  <priority> — specificity rules: match specific rule > catch-all > noMatchFound </priority>
  <guidelines> — exclusion behavior, specificity, List-Unsubscribe metadata hint </guidelines>
</instructions>

getUserRulesPrompt({ rules }) — serialized rule names + instructions for each rule
formatClassificationFeedback() — up to 10 past label-add/remove events for this sender (XML block)
getUserInfoPrompt({ emailAccount }) — user name, about, role, writing style
```

**PROMPT:**
```
"Select a rule to apply to this email that was sent to me:"
<email>stringifyEmail(email, 500)</email>
[Note: This email has a List-Unsubscribe header.] — appended if listUnsubscribe is present
```

**SCHEMA (Zod — single-rule mode):**
```typescript
z.object({
  reasoning: z.string().describe("The reason you chose the rule. Keep it concise"),
  ruleName: z.string().nullable().describe("The exact name of the rule you want to apply"),
  noMatchFound: z.boolean().describe("True if no match was found, false otherwise"),
})
```

**Multi-rule mode** (`multiRuleSelectionEnabled = true`): Same system/prompt structure but schema returns:
```typescript
z.object({
  matchedRules: z.array(z.object({
    ruleName: z.string(),
    isPrimary: z.boolean(),
  })),
  reasoning: z.string(),
  noMatchFound: z.boolean(),
})
```

### Confidence Scoring — GAP

There is NO numeric confidence score in the current codebase. `ExecutedRule.reason` stores the AI's text reasoning. `ExecutedRule.matchMetadata` stores `MatchReason[]` with types STATIC, AI, LEARNED_PATTERN, PRESET — no numeric score. Phase 3 MUST add `confidenceScore Float?` to `ExecutedRule` via Prisma migration.

### Outputs

For each matched rule, execution proceeds in four steps:

1. `getActionItemsWithAiArgs()` — second AI call to fill template variables in action fields (label name, draft content, to/cc/bcc, etc.); only called when the rule's actions have unfilled template variables
2. `executeAct()` — performs immediate Gmail API calls (archive, label, reply, mark-read, etc.)
3. `prisma.executedRule.create()` — writes `ExecutedRule` row (with status APPLYING) + `ExecutedAction` rows atomically via nested createMany
4. For `ActionType.DIGEST` actions → `enqueueDigestItem()` → writes `DigestItem` row linking the message to the current `Digest`

Delayed actions (those with `delayInMinutes > 0`) are written to `ScheduledAction` via BullMQ and executed by a background worker.

---

## Rules Engine

### Storage

Rules are stored in Postgres across three tables:

**`Rule`** — one row per rule:

| Column | Type | Role |
|--------|------|------|
| `id` | String (cuid) | Primary key |
| `name` | String | Display name; used as rule identifier in AI prompts |
| `enabled` | Boolean | If false, rule is skipped during matching |
| `emailAccountId` | String | FK to EmailAccount; scopes rule to one account |
| `instructions` | String? | AI instruction text (null for purely static rules) |
| `from` | String? | Static regex pattern for sender; supports wildcards and OR syntax |
| `to` | String? | Static regex pattern for recipient |
| `subject` | String? | Static regex pattern for subject line |
| `body` | String? | Static regex pattern for body text |
| `conditionalOperator` | LogicalOperator (AND/OR) | Controls AND/OR logic between static and AI conditions |
| `groupId` | String? | FK to Group containing learned patterns (null = no learned patterns) |
| `systemType` | SystemType? | Identifies system-managed rules (TO_REPLY, FYI, COLD_EMAIL, NEWSLETTER, etc.); null for user-created rules |
| `runOnThreads` | Boolean | If false, only runs on first message in thread (not replies) |
| `promptText` | String? | Natural-language description for prompt file generation |

**`Action`** — one row per action per rule:

| Column | Type | Role |
|--------|------|------|
| `id` | String (cuid) | Primary key |
| `type` | ActionType enum | Action to take when rule matches |
| `ruleId` | String | FK to Rule |
| `emailAccountId` | String | FK to EmailAccount |
| `label` | String? | Label name for LABEL action |
| `labelId` | String? | Stable label ID (Gmail label ID or Outlook category ID) |
| `subject` | String? | Subject for REPLY/SEND_EMAIL/DRAFT_EMAIL |
| `content` | String? | Body content for messaging actions |
| `to` | String? | Recipient override for FORWARD/SEND_EMAIL |
| `cc` | String? | CC for email actions |
| `bcc` | String? | BCC for email actions |
| `delayInMinutes` | Int? | If set, action is deferred via BullMQ ScheduledAction |

**ActionType enum values:** `ARCHIVE`, `LABEL`, `REPLY`, `SEND_EMAIL`, `FORWARD`, `DRAFT_EMAIL`, `DRAFT_MESSAGING_CHANNEL`, `NOTIFY_MESSAGING_CHANNEL`, `MARK_SPAM`, `CALL_WEBHOOK`, `MARK_READ`, `DIGEST`, `MOVE_FOLDER`, `NOTIFY_SENDER`

**`Group` / `GroupItem`** — learned sender patterns attached to rules:

| Column | Type | Role |
|--------|------|------|
| `Group.id` | String | Primary key |
| `Group.name` | String | Display name (not currently used for matching) |
| `Group.emailAccountId` | String | FK to EmailAccount |
| `GroupItem.id` | String | Primary key |
| `GroupItem.groupId` | String? | FK to Group |
| `GroupItem.type` | GroupItemType (FROM/SUBJECT/BODY) | Which message field this pattern matches against |
| `GroupItem.value` | String | Pattern value (e.g., `@amazon.com`, `Receipt from`) |
| `GroupItem.exclude` | Boolean | If true, this is an exclusion pattern — matching sender is blocked from this rule |
| `GroupItem.source` | GroupItemSource? | How the item was learned: AI, USER, LABEL_REMOVED, LABEL_ADDED |

### Evaluation

Evaluation happens in `match-rules.ts` inside `findPotentialMatchingRules()`:

1. **Learned pattern check** — for rules with a `groupId`, lazy-load all Groups for the account (one DB call per account, not per rule), then call `findMatchingGroup()` — O(n) scan of GroupItems. If an exclusion item matches, skip the rule entirely. If an inclusion item matches, add to `matches[]` with `ConditionType.LEARNED_PATTERN` and skip remaining condition checks for this rule.

2. **Static evaluation** — `matchesStaticRule()` tests regex patterns on `from`, `to`, `subject`, `body` fields. Empty fields match everything; the rule only fails if a non-empty pattern does not match.

3. **AND/OR logic** — controlled by `conditionalOperator`. OR: static match alone is sufficient to add to `matches[]`. AND: static must pass before AI is consulted; failed static eliminates the rule.

4. **AI candidate collection** — if only AI conditions remain unsatisfied after static evaluation (or if no static conditions exist and AI instructions are present), the rule is added to `potentialAiMatches[]`.

5. **Learned pattern suppression** — after iterating all rules: if any `matches[]` entry has a `LEARNED_PATTERN` reason, the entire `potentialAiMatches[]` list is discarded. This avoids AI calls when patterns already gave a confident match.

### Application

After matching, `executeMatchedRule()` in `run-rules.ts`:

1. `getActionItemsWithAiArgs()` — fills template variables in action fields via a second LLM call (uses `default` model slot)
2. Split actions into `immediateActions` (no `delayInMinutes`) and `delayedActions` (has `delayInMinutes > 0`)
3. Write `ExecutedRule` + `ExecutedAction` records atomically via `prisma.executedRule.create()` with nested `actionItems.createMany`
4. `executeAct()` for immediate actions — performs Gmail API calls (archive, label, reply, etc.)
5. `scheduleDelayedActions()` via BullMQ for delayed actions — creates `ScheduledAction` rows and enqueues to Upstash Redis

---

## AI Integration

### Model Tier Slots

The LLM layer (`utils/llms/model.ts`) supports five model type slots:

| Slot | Env vars | Current fork value | Fallback behavior |
|------|----------|--------------------|-------------------|
| `default` | `DEFAULT_LLM_PROVIDER` / `DEFAULT_LLM_MODEL` | `anthropic` / `claude-sonnet-4-6` | n/a — this is the base |
| `economy` | `ECONOMY_LLM_PROVIDER` / `ECONOMY_LLM_MODEL` | UNSET | Falls back to `selectDefaultModel()` → Sonnet |
| `nano` | `NANO_LLM_PROVIDER` / `NANO_LLM_MODEL` | UNSET | Falls back to `selectEconomyModel()` → then Sonnet |
| `chat` | `CHAT_LLM_PROVIDER` / `CHAT_LLM_MODEL` | UNSET | Falls back to `selectDefaultModel()` → Sonnet |
| `draft` | `DRAFT_LLM_PROVIDER` / `DRAFT_LLM_MODEL` | UNSET | Falls back to `selectDefaultModel()` → Sonnet |

**Current production state:** `DEFAULT_LLM_PROVIDER=anthropic` resolves to `claude-sonnet-4-6`. No `ECONOMY_LLM_*` vars are set — economy tasks fall back to Sonnet. This is the primary cost problem Phase 3 must fix.

Note: If a user has set their own `aiApiKey` in their account settings, `selectModelByType()` always returns `selectDefaultModel()` regardless of the modelType parameter. For the single-tenant self-hosted fork, this path is not used.

### AI Call Sites

All classification-relevant AI call sites:

| File | Function | Model slot | Purpose |
|------|----------|-----------|---------|
| `utils/ai/choose-rule/ai-choose-rule.ts` | `aiChooseRule` | `default` (Sonnet today) | Picks which Rule to apply to an email; single-rule or multi-rule mode |
| `utils/ai/choose-rule/choose-args.ts` | `getActionItemsWithAiArgs` | `default` | Fills action template variables (label name, draft content, etc.) |
| `utils/ai/digest/summarize-email-for-digest.ts` | `aiSummarizeEmailForDigest` | `economy` (= Sonnet today, UNSET) | Summarizes each email for inclusion in the morning digest |
| `utils/cold-email/is-cold-email.ts` | `isColdEmail` | `default` | Cold email classification — separate from rule selection, runs first |
| `utils/reply-tracker/generate-draft.ts` | draft generation functions | `draft` (= Sonnet today, UNSET) | Draft reply generation |
| `utils/ai/categorize-sender/ai-categorize-senders.ts` | bulk sender categorization | `economy` (= Sonnet today, UNSET) | Bulk sender categorization for onboarding / backlog |

### SDK and Prompt Hardening

All LLM calls go through `createGenerateObject()` from `utils/llms/index.ts`. This wrapper:
- Applies prompt hardening (`promptHardening: { trust: "untrusted", level: "full" | "compact" }`) — defends against prompt injection by treating email content as untrusted input
- Uses Vercel AI SDK `generateObject()` with Zod schemas for structured output
- Logs token usage for monitoring and cost tracking

The prompt hardening level for `aiChooseRule` is `"full"`, which applies the most aggressive injection defenses.

### No Discrete Classification Endpoint

No dedicated `/api/ai/classify` endpoint exists. Classification happens inline during webhook processing via `after()`. The `apps/web/app/api/ai/` directory has specialized endpoints (analyze-sender-pattern, drafts, etc.) but classification is NOT a discrete HTTP endpoint — it is embedded in the webhook flow.

---

## Database Schema

### Classification Tables

**Rule**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `name` | String | Rule name; used as identifier in AI prompts |
| `enabled` | Boolean | Enables/disables the rule |
| `emailAccountId` | String | Scopes rule to one email account |
| `instructions` | String? | AI instruction text for rule matching |
| `from`, `to`, `subject`, `body` | String? | Static regex filter fields |
| `conditionalOperator` | LogicalOperator | AND/OR logic between condition types |
| `groupId` | String? | FK to Group (learned patterns) |
| `systemType` | SystemType? | Identifies system-managed rules |
| `runOnThreads` | Boolean | Whether to re-evaluate on thread replies |
| `promptText` | String? | Natural-language description for prompt generation |

**Action**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `type` | ActionType enum | Action to take (ARCHIVE, LABEL, REPLY, SEND_EMAIL, FORWARD, DRAFT_EMAIL, DRAFT_MESSAGING_CHANNEL, NOTIFY_MESSAGING_CHANNEL, MARK_SPAM, CALL_WEBHOOK, MARK_READ, DIGEST, MOVE_FOLDER, NOTIFY_SENDER) |
| `ruleId` | String | FK to Rule |
| `emailAccountId` | String | FK to EmailAccount |
| `label`, `labelId` | String? | Label name and stable ID for LABEL action |
| `subject`, `content`, `to`, `cc`, `bcc` | String? | Parameters for email actions |
| `delayInMinutes` | Int? | Deferred execution delay |

**ExecutedRule**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `threadId`, `messageId` | String | Identifies the email processed |
| `status` | ExecutedRuleStatus (APPLYING/APPLIED/SKIPPED/ERROR) | Current execution state |
| `automated` | Boolean | True for webhook-triggered classification |
| `reason` | String? | AI's text reasoning for the match |
| `matchMetadata` | Json? | Structured match information (see MatchReason below) |
| `ruleId` | String? | FK to Rule (nullable — rule may have been deleted) |
| `emailAccountId` | String | FK to EmailAccount |
| `createdAt` | DateTime | Timestamp; batch timestamp used for grouping within a runRules() call |

`matchMetadata` stores a `MatchReason[]` JSON array:

```typescript
// MatchReason[]
type MatchReason =
  | { type: "STATIC" }
  | { type: "AI" }
  | { type: "PRESET"; systemType: SystemType }
  | { type: "LEARNED_PATTERN"; groupItem: GroupItem; group: Group }
```

No `confidenceScore` column exists. Phase 3 must add it.

**ExecutedAction**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `type` | ActionType enum | Which action was taken |
| `executedRuleId` | String | FK to ExecutedRule |
| `label`, `labelId` | String? | Label applied |
| `subject`, `content`, `to`, `cc`, `bcc` | String? | Email parameters used |
| `draftId` | String? | Gmail draft ID if DRAFT_EMAIL action |
| `draftModelProvider`, `draftModelName` | String? | Model that generated the draft |

**Group**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `name` | String | Display name (not used in matching) |
| `emailAccountId` | String | FK to EmailAccount |
| `items` | GroupItem[] | Learned patterns for this group |
| `rule` | Rule? | The rule this group is attached to (one-to-one) |

**GroupItem**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `groupId` | String? | FK to Group |
| `type` | GroupItemType (FROM/SUBJECT/BODY) | Which field to match against |
| `value` | String | Pattern value (e.g., `@amazon.com`, `Receipt from`) |
| `exclude` | Boolean | If true, exclusion pattern — blocks rule for matching sender |
| `source` | GroupItemSource? | How learned: AI, USER, LABEL_REMOVED, LABEL_ADDED |

**ClassificationFeedback**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `sender` | String | Normalized (lowercase) sender email address |
| `eventType` | ClassificationFeedbackEventType (LABEL_ADDED/LABEL_REMOVED) | Type of feedback event |
| `ruleId` | String | Which rule was affected |
| `emailAccountId` | String | FK to EmailAccount |
| `threadId`, `messageId` | String | Identifies the email that triggered the feedback |

Up to 10 feedback items per sender are injected into the AI prompt via `formatClassificationFeedback()`.

**Newsletter**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `email` | String | Sender email address |
| `name` | String? | Sender display name |
| `status` | NewsletterStatus? | User disposition (unsubscribed, etc.) |
| `patternAnalyzed` | Boolean | Whether sender pattern analysis has run |
| `emailAccountId` | String | FK to EmailAccount |
| `categoryId` | String? | FK to Category for bulk categorization |

Note: Despite the name "Newsletter", this table covers all auto-categorized senders — not just newsletters.

### Digest Tables

**Digest**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `emailAccountId` | String | FK to EmailAccount |
| `status` | DigestStatus (PENDING/PROCESSING/SENT/FAILED) | State machine for send lifecycle |
| `sentAt` | DateTime? | When the digest email was sent |
| `createdAt` | DateTime | Creation timestamp |
| `items` | DigestItem[] | Emails included in this digest batch |

**DigestItem**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `messageId`, `threadId` | String | Identifies the source email |
| `content` | String (Text) | JSON-encoded summarized content |
| `digestId` | String | FK to Digest |
| `actionId` | String? | FK to ExecutedAction (the DIGEST action that triggered queuing) |

`DigestItem.content` stores JSON matching `storedDigestContentSchema`:
```typescript
{ content: string }  // AI-summarized text; redacted to "[REDACTED]" after send
```

DigestItem.content is redacted to `[REDACTED]` after digest send. Feedback links in the digest email must encode sufficient state in the URL token to identify the email without re-reading DigestItem.content.

**Schedule**

| Column | Type | Role |
|--------|------|------|
| `id` | String | Primary key |
| `emailAccountId` | String | FK to EmailAccount (unique — one schedule per account) |
| `daysOfWeek` | Int? | Bitmask (0-127); each bit = one day (Sunday=bit 0 through Saturday=bit 6) |
| `timeOfDay` | DateTime? | Time stored as DateTime with canonical date 1970-01-01; only time portion used |
| `intervalDays` | Int? | Total interval in days for non-weekly schedules |
| `occurrences` | Int? | Number of times within the interval |
| `lastOccurrenceAt` | DateTime? | When the last digest was sent |
| `nextOccurrenceAt` | DateTime? | Pre-computed next send time |

---

## Component Decisions

### Decision 1: Webhook Entry Point (`/api/google/webhook`)

**Decision: KEEP**

**Rationale:** Token verification, rate-limit guard, and `after()` deferral pattern are correct and production-ready. Provider-agnostic (handles both Gmail and Outlook paths). No changes needed for the classification engine.

**Phase 3 action:** None — keep as-is.

---

### Decision 2: `match-rules.ts` — Static and Learned Pattern Matching

**Decision: KEEP + EXTEND**

**Rationale:** Static regex matching and learned-pattern (Group) short-circuit are sound and cost-free. GroupItem matching already functions as a free fast path equivalent to Tier 1 of the proposed three-tier architecture. The extension needed is explicit priority ordering so user-defined explicit rules from the new Rules UI are evaluated as the highest-priority tier before learned patterns.

**Phase 3 action:** Add explicit priority ordering — user-created explicit rules run before system/learned rules. No replacement of the matching logic itself.

---

### Decision 3: `ai-choose-rule.ts` — LLM Rule Selection

**Decision: REPLACE (model selection); KEEP (prompt structure)**

**Rationale:** The prompt structure (system instructions + rules list + classification feedback + email content → structured JSON output) is well-designed. What must change: replace `getModel(emailAccount.user, "default")` with tiered escalation — call Haiku first; escalate to Sonnet only if Haiku returns low confidence or `noMatchFound = true`. Also: add `confidenceScore: number` field to the Zod response schema so Phase 3 can persist it.

**Phase 3 action:**
1. Change model call from `getModel(..., "default")` to `getModel(..., "economy")` for Haiku tier.
2. Add `confidenceScore: z.number().min(0).max(1)` to the Zod schema.
3. On `noMatchFound = true` or `confidenceScore < threshold`, re-call with `getModel(..., "default")` (Sonnet).
4. Set `ECONOMY_LLM_PROVIDER=anthropic` and `ECONOMY_LLM_MODEL=claude-haiku-3-5` in SSM.

---

### Decision 4: `actions.ts` — DIGEST Action Type

**Decision: KEEP + EXTEND**

**Rationale:** The `DIGEST` action type and `enqueueDigestItem()` infrastructure are correct. Digest is opt-in per rule: a rule must have an `Action` row of type `DIGEST` for its matched emails to appear in the morning summary. This is not automatic.

**Phase 3 action:** Ensure each of the eight classification rules (Receipts, Deals, Newsletters, Marketing, Urgent, 2FA, Uncertain, Greers List) has the correct actions attached: LABEL + ARCHIVE + DIGEST for most; LABEL + DIGEST (no ARCHIVE) for Urgent and Uncertain; DELETE after 24h for 2FA via `delayInMinutes`.

---

### Decision 5: Digest Send Pipeline (`/api/resend/digest`, `send-digest.ts`)

**Decision: KEEP + EXTEND**

**Rationale:** React Email + Resend rendering, Schedule table, and PENDING→PROCESSING→SENT state machine are correct and operational. The pipeline is already sending digests (Phase 1 fixed the from-address).

**Phase 3 action:** Ensure Urgent and Uncertain rules have no ARCHIVE action; verify `Schedule.timeOfDay` is set to deliver between 6-7am Eastern.
**Phase 4 action:** Add thumbs-up/down feedback links per DigestItem (DIGEST-07) — links must encode email identity in URL token since DigestItem.content is redacted post-send; add explicit Urgent and Uncertain sections to the digest template.

---

### Decision 6: `ClassificationFeedback` + Label-Change Learning

**Decision: KEEP + EXTEND**

**Rationale:** The label-add/remove learning loop is live and already feeding back into AI prompts (up to 10 items per sender). This is a strong foundation for Phase 6. No replacement needed.

**Phase 3 action:** No code changes needed. Ensure the eight classification rules use LABEL actions with names that map to Gmail labels the webhook can detect via LABEL_ADDED events — this ensures the existing learning loop works for the new rules automatically.
**Phase 6 action:** Add thumbs-up/down feedback from digest email. This requires either a new `eventType` value or a companion table since digest votes are explicit (user-initiated) rather than implicit (label changes observed by webhook).

---

## Cost Analysis

### Current Architecture Cost Estimate

**Inputs:**
- Single user: rebekah@trueocean.com
- Estimated email volume: 20-50 emails/day [ASSUMED]
- Model today: claude-sonnet-4-6 for ALL calls (default AND economy, because ECONOMY_LLM_* unset)
- Pricing: claude-sonnet-4-6 at $3.00/MTok input, $15.00/MTok output [ASSUMED — verify at anthropic.com/pricing]

**Per-email AI calls today:**
- `aiChooseRule()`: ~500-800 tokens input, ~50-100 tokens output
- `getActionItemsWithAiArgs()`: ~300-500 tokens input, ~50 tokens output (when template vars needed)
- Average: 1.5 AI calls per email

**Monthly estimate (35 emails/day average):**
- Input per email: ~900 tokens average; output: ~100 tokens average
- Monthly volume: 945K input tokens, 105K output tokens
- Classification cost: (0.945 MTok × $3.00) + (0.105 MTok × $15.00) = $2.84 + $1.58 = **~$4.42/month**
- Digest summarization (also Sonnet due to unset economy vars): 1,050 summaries × 500 tokens = (0.42 × $3.00) + (0.105 × $15.00) = $1.26 + $1.58 = **~$2.84/month**
- **Total current estimate: ~$7.26/month** [ALL NUMBERS ASSUMED — not measured]

### Proposed Three-Tier Architecture Cost

**Tier 1 (explicit rules — free):** Estimated 60-70% of emails matched by static rules or learned GroupItems → zero AI cost. At 35 emails/day, ~22 caught free, ~13 reach AI. [ASSUMED]

**Tier 2 (Haiku for uncertain cases):** claude-haiku-3-5 at $0.80/MTok input, $4.00/MTok output [ASSUMED — verify at anthropic.com/pricing]
- 13 emails/day × 30 days = 390 emails/month
- Cost: (0.351 × $0.80) + (0.039 × $4.00) = $0.28 + $0.16 = **~$0.44/month**

**Tier 3 (Sonnet for hard cases only):** ~10-15% of Haiku cases escalate (~45 emails/month).
- Cost: (0.0405 × $3.00) + (0.0045 × $15.00) = $0.12 + $0.07 = **~$0.19/month**

**Digest summarization (move to Haiku):** 1,050 summaries × 500 tokens.
- Cost: (0.525 × $0.80) + (0.105 × $4.00) = $0.42 + $0.42 = **~$0.84/month**

**Daily digest narrative (Sonnet, once/day):** 30 calls/month × ~2,000 input, ~500 output.
- Cost: (0.06 × $3.00) + (0.015 × $15.00) = $0.18 + $0.23 = **~$0.41/month**

**Total proposed estimate: ~$1.88/month** [ALL NUMBERS ASSUMED]

### Summary Table

| Scenario | Monthly AI Cost | Savings |
|----------|----------------|---------|
| Current (all Sonnet) | ~$7.26 | — |
| Proposed three-tier | ~$1.88 | ~$5.38/month (74%) |
| Budget ceiling | $10.00 additional | Well under ceiling |

**Key uncertainty:** Email volume and tier-1 hit rate are estimated, not measured. Revisit after Phase 3 is live and real token counts are available from Anthropic's usage dashboard.

---

## Open Questions — Live Production Answers

### Question 1: Is the Anthropic API key pay-as-you-go or prepaid credits?

- **Command attempted:** Check Anthropic console or SSM for spending limit configuration
- **Result:** **PREPAID CREDITS** (confirmed by Rebekah 2026-04-27). The account uses a prepaid credit balance, not pay-as-you-go billing. Phase 3 implication: prepaid credits expire and do not auto-replenish — monitor the balance at console.anthropic.com before and during Phase 3 deployment. The $10/month budget ceiling from the cost analysis is still valid as a guideline, but actual available budget depends on remaining credit balance. Rebekah must top up credits if the balance drops below the expected Phase 3 usage (~$1.88/month proposed).

---

### Question 2: How many Rules currently exist for rebekah@trueocean.com?

- **Command to run:**
```sql
SELECT count(*) FROM "Rule"
WHERE "emailAccountId" IN (
  SELECT id FROM "EmailAccount"
  WHERE "userId" IN (
    SELECT id FROM "User" WHERE email = 'rebekah@trueocean.com'
  )
);
```
- **SSH command:**
```bash
ssh ec2-user@<production-host> 'docker exec <postgres-container> psql -U inbox_zero -d inbox_zero -c "SELECT count(*) FROM \"Rule\" WHERE \"emailAccountId\" IN (SELECT id FROM \"EmailAccount\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email = '"'"'rebekah@trueocean.com'"'"'))"'
```
- **Result:** **10 rules exist** (confirmed 2026-04-27 via `ssh -i ~/.ssh/inbox_key ubuntu@inbox.tdfurn.com 'docker exec inbox-zero-postgres psql -U inboxzero -d inboxzero -c ...'`). Phase 3 implication: 10 rules will appear in the AI classification prompt. Phase 3 must decide whether to keep these 10 rules as-is, replace them with the 8 canonical classification rules (Receipts, Deals, Newsletters, Marketing, Urgent, 2FA, Uncertain, Greers List), or merge them. The current 10 rules likely include some of the upstream systemType rules (TO_REPLY, FYI, etc.) — Phase 3 planning should inspect the actual rule names before writing the seed script.

---

### Question 3: Is ECONOMY_LLM_PROVIDER set in production SSM?

- **Command attempted:** `aws ssm get-parameter --name /inbox-zero/ECONOMY_LLM_PROVIDER --region us-east-1 2>&1`
- **Result:** **ParameterNotFound** (confirmed by Rebekah 2026-04-27 via `aws ssm get-parameter --name /inbox-zero/ECONOMY_LLM_PROVIDER --region us-east-1`). The parameter does not exist in SSM. This validates the cost analysis assumption: all economy/nano/chat/draft model calls are currently falling back to Sonnet (`claude-sonnet-4-6`), confirming the ~$7.26/month current cost estimate. Phase 3 must set `ECONOMY_LLM_PROVIDER=anthropic` and `ECONOMY_LLM_MODEL=claude-haiku-3-5` in SSM before deploying the tiered classification engine.

---

## Phase 3 Prerequisites Checklist

Before writing any Phase 3 classification code, complete these items:

- [ ] Add `confidenceScore Float?` to `ExecutedRule` in prisma/schema.prisma and run migration
- [ ] Set `ECONOMY_LLM_PROVIDER=anthropic` and `ECONOMY_LLM_MODEL=claude-haiku-3-5` in SSM
- [ ] Set `NANO_LLM_PROVIDER=anthropic` and `NANO_LLM_MODEL=claude-haiku-3-5` in SSM
- [ ] Inspect the existing 10 Rules in production (names, types, actions) before deciding whether to replace, merge, or keep — `SELECT id, name, "systemType", enabled FROM "Rule" WHERE "emailAccountId" IN (...)`; then create/replace with the eight canonical classification rules with correct Action rows
- [ ] Verify Anthropic prepaid credit balance at console.anthropic.com is sufficient for Phase 3 usage (~$1.88/month projected) and top up if needed
- [ ] Confirm `multiRuleSelectionEnabled = false` is correct for single-rule eight-category taxonomy
