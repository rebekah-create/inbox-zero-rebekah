# AI Rules

When we receive an email for processing:

1. We choose how to act on the rule (AI/Static/Group)
2. If needed we choose the arguments for the rule using AI
3. We perform the action

We don't always perform the action immediately. We may need user confirmation from the user first.

## Prompt Caching — removed after v1.1 audit (2026-06-01)

Phase 8.5 added Anthropic ephemeral prompt caching to the classifier (and Phase 9/11 mirrored it for extraction/arbitration). **It never engaged in production** — the Anthropic Console showed zero cache usage over a 7-day window.

**Root cause:** the cacheable-prefix minimum is **2048 tokens for Haiku** (only 1024 for Opus/Sonnet). All three caching paths run on the economy/**Haiku** tier, but the prompts were sized to ~1500 tokens against the mistaken belief that the floor was 1024. A ~1500-token prefix on Haiku is below the floor, so Anthropic accepted the `cache_control` block, declined to cache, and billed full input price.

**Why we didn't just pad the prompts past 2048:** at single-user volume (~85 emails/day ≈ 1 per 17 min, 1–3 calendar emails/day) versus the 5-minute cache TTL, most calls would be lone cache-*writes* (1.25× input price) with no read to amortize them — so padding extract/arbitration would likely *raise* cost. Caching is the wrong tool at this scale.

**Outcome:** `cache_control` removed from `ai-choose-rule.ts`, `extract-prompt.ts`, and `arbitrate.ts`; `system` is now a plain string for every provider. OPS-03 is reframed as not-viable at single-user volume. Full analysis: `.planning/v1.1-MILESTONE-AUDIT.md`.

If volume ever becomes bursty (e.g. backlog triage processing many emails within a 5-min window), revisit — the **classifier** is the only path with a shared, reused prefix that could benefit, and it would need padding past 2048 tokens first.
