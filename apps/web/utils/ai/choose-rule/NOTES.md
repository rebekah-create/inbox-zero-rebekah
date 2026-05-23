# AI Rules

When we receive an email for processing:

1. We choose how to act on the rule (AI/Static/Group)
2. If needed we choose the arguments for the rule using AI
3. We perform the action

We don't always perform the action immediately. We may need user confirmation from the user first.

## Prompt Caching (Anthropic only, since Phase 8.5)

The classifier prompt in `ai-choose-rule.ts` uses Anthropic prompt caching to drop the input-token cost on the constant prefix to ~10% of uncached price. Implementation is gated on `modelOptions.provider === Provider.ANTHROPIC` via `isAnthropicProvider`; non-Anthropic providers keep the original `{ system, prompt }` call shape unchanged.

### What caches vs what varies

| Segment | Lives in | Cacheable? |
| --- | --- | --- |
| Instructions (priority + guidelines + isPrimary_field block) | `system` string | YES — cached |
| User rules list (`getUserRulesPrompt`) | `system` string | YES — cached |
| Classification feedback (`formatClassificationFeedback`) | `system` string | YES — cached |
| User-info block (`getUserInfoPrompt`) | `system` string | YES — cached |
| Per-email body / subject / from / List-Unsubscribe note | `prompt` string → first user message | NO — varies per email |

### Cut point: one ephemeral marker on the trailing system block

The full `system` text is sent as a single text content block with `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }`. The per-email `prompt` becomes the first `user` message (no cache marker). One breakpoint is sufficient for v1; multi-breakpoint caching (e.g., separating instructions from rules list) is a Phase 9+ optimization only if measurements justify it.

### AI SDK pattern (mirror in Phase 9 extraction)

```ts
const result = await generateObject({
  ...modelOptions,
  messages: [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: systemText,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ],
    },
    { role: "user", content: prompt },
  ],
  schema,
});
```

When passing `messages` to `generateObject`, do NOT also pass top-level `system` or `prompt` — the AI SDK throws on the combination. The `createGenerateObject` wrapper in `apps/web/utils/llms/index.ts` handles this correctly: it only injects `system: applyPromptHardeningToSystem(...)` when the caller passed `system` as a string, otherwise it writes `system: undefined` and the `messages` array is the source of truth.

**Caveat on prompt hardening:** `applyPromptHardeningToSystem` is bypassed on the Anthropic path because we no longer send `system` as a string. This is acceptable for the classifier prompts (Phase 8.5 CONTEXT D-02 explicitly accepts this). If Phase 9's extraction prompt or any future cached prompt needs prompt hardening, fold the hardened text into the cached `text` field before constructing the messages array.

### Provider gate

`isAnthropicProvider(provider)` returns `true` only for `Provider.ANTHROPIC`. `anthropic-vertex` and Bedrock-hosted Anthropic flow through different provider strings (`vertex` / `bedrock`) and currently take the non-Anthropic branch — extend `isAnthropicProvider` if/when those become primary paths.

### Verification

- **Unit tests** (`ai-choose-rule.test.ts`) assert the request shape for both branches.
- **Live verification** after deploy: Anthropic Console → https://console.anthropic.com/settings/usage → confirm `cache_read_input_tokens > 0` within 24h.
- **No telemetry plumbing** in `saveAiUsage` — Anthropic Console is the source of truth for cache-hit metrics in v1.
