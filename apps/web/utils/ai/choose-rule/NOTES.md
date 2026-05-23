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

### Cut point: one ephemeral marker on the system message

The full `system` text is sent as a single `SystemModelMessage` with `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }` at the **message level** (not on a content block). The per-email `prompt` stays as a plain string parameter — same shape as the non-Anthropic branch, only `system` varies. One breakpoint is sufficient for v1; multi-breakpoint caching (e.g., separating instructions from rules list) is a Phase 9+ optimization only if measurements justify it.

### AI SDK pattern (mirror in Phase 9 extraction)

```ts
import type { SystemModelMessage } from "ai";

function buildClassifierSystem(
  systemText: string,
  provider: string,
): string | SystemModelMessage[] {
  if (provider !== Provider.ANTHROPIC) return systemText;
  return [
    {
      role: "system",
      content: systemText,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
  ];
}

const result = await generateObject({
  ...modelOptions,
  system: buildClassifierSystem(systemText, modelOptions.provider),
  prompt,
  schema,
});
```

**Why this shape (and not the `messages` array variant the Anthropic docs show):**

- `SystemModelMessage.content` is typed as `string` in AI SDK v6, NOT `TextPart[]`. You cannot put `providerOptions` on a system-message content block — the cache marker must live on the message itself.
- Only `UserModelMessage.content` accepts `TextPart[]` with per-block `providerOptions`. The Anthropic docs' user-message-with-content-array example does work, but for our classifier the natural cut is system-vs-prompt, so the SystemModelMessage path is cleaner.
- `system` accepts `string | SystemModelMessage | SystemModelMessage[]`, so swapping in `SystemModelMessage[]` for the Anthropic branch requires no other call-site changes (`prompt` stays string, `schema` stays the same — generic inference preserved).
- Annotate the helper return as `string | SystemModelMessage[]` explicitly — without it, TS widens `cacheControl: { type: "ephemeral" }` to `{ type: string }` and the union won't satisfy the `system` parameter type. (Burned 4 CI rounds in 8.5 discovering this.)

**Prompt hardening still applies:** `createGenerateObject` in `apps/web/utils/llms/index.ts` only hardens when `typeof options.system === 'string'`. On the Anthropic path we pass `system: SystemModelMessage[]` so hardening is skipped — acceptable for the classifier (Phase 8.5 CONTEXT D-02). If Phase 9's extraction or any future cached prompt needs hardening, fold `applyPromptHardeningToSystem(systemText, promptHardening)` into the `content` field before wrapping in the message array.

### Provider gate

`isAnthropicProvider(provider)` returns `true` only for `Provider.ANTHROPIC`. `anthropic-vertex` and Bedrock-hosted Anthropic flow through different provider strings (`vertex` / `bedrock`) and currently take the non-Anthropic branch — extend `isAnthropicProvider` if/when those become primary paths.

### Verification

- **Unit tests** (`ai-choose-rule.test.ts`) assert the request shape for both branches.
- **Live verification** after deploy: Anthropic Console → https://console.anthropic.com/settings/usage → confirm `cache_read_input_tokens > 0` within 24h.
- **No telemetry plumbing** in `saveAiUsage` — Anthropic Console is the source of truth for cache-hit metrics in v1.
