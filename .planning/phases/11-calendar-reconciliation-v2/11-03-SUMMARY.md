---
phase: 11-calendar-reconciliation-v2
plan: 11-03
subsystem: calendar-reconciliation
tags: [arbitration, haiku, prompt-caching, prompt-injection, zod-schema]
requires: [11-01]
provides: [arbitrateOverlap-v2, arbitrationSchema-v2]
affects: [apps/web/utils/calendar/reconciliation/index.ts]
tech_stack:
  added: []
  patterns: [SystemModelMessage-ephemeral-cache, untrusted-data-delimiter, id-whitelist]
key_files:
  created: []
  modified:
    - apps/web/utils/calendar/reconciliation/arbitrate.ts
    - apps/web/utils/calendar/reconciliation/arbitrate.test.ts
decisions:
  - "Verdict union SAME / RESCHEDULE / SEPARATE / SKIP — Zod enum, no legacy AMBIGUOUS."
  - "matchedEventId whitelist check throws arbiter_invalid_matched_id when verdict is SAME or RESCHEDULE — orchestrator (11-05) catches and falls through to CREATE per D-08."
  - "matchedEventId normalized to null for SEPARATE / SKIP regardless of model output — downstream code treats null as 'no existing event'."
  - "System prompt mirrors extract-prompt.ts pattern: SystemModelMessage[] with providerOptions sibling-of-content; non-Anthropic providers fall back to plain string."
  - "findTimeOverlaps retained with @deprecated JSDoc — index.ts still imports it until 11-05; deletion deferred."
metrics:
  duration_minutes: ~75
  tasks_complete: 2
  files_touched: 2
  completed_at: 2026-05-26
---

# Phase 11 Plan 11-03: Arbitration Four-Outcome Rewrite — Summary

**One-liner:** Replaced the Phase 9 narrow two-outcome arbitration tie-breaker with a four-outcome verdict schema (`SAME` / `RESCHEDULE` / `SEPARATE` / `SKIP`), added id-whitelisting, broadened the day-schedule context window, and put the system prompt onto the Anthropic ephemeral cache breakpoint pattern from `extract-prompt.ts`.

## What changed

### `apps/web/utils/calendar/reconciliation/arbitrate.ts`
- New `arbitrationSchema` (Zod) with two fields: `verdict: enum(["SAME","RESCHEDULE","SEPARATE","SKIP"])`, `matchedEventId: string | null`. Legacy `reasoning` field dropped.
- New exports: `ArbitrationVerdict`, `ArbitrationResult` types.
- `arbitrateOverlap` signature changed (incompatible with the previous call site in `index.ts`, which 11-05 will rewrite):
  - `existingEvents` (events within ±60 min) → `daySchedule` (full day's events, computed by orchestrator).
  - `candidate` now carries `endISO` and `location` alongside `title`/`startISO`.
  - Returns `{ verdict, matchedEventId }` (was `{ matchedEventId }`).
- New `buildArbitrationSystem(provider)` helper — mirrors `buildExtractionSystem` exactly: returns `SystemModelMessage[]` with `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` when provider is Anthropic, plain string otherwise.
- Post-parse validation:
  - `SEPARATE` / `SKIP` → `matchedEventId` normalized to `null`.
  - `SAME` / `RESCHEDULE` → id MUST appear in `daySchedule`; otherwise throw `Error("arbiter_invalid_matched_id")`.
  - Zod parse failure / network error → propagate (no `try`/`catch` here; caller owns D-08 fallback).
- Logging: structured fields only via injected `Logger`. Verdict is the only enum logged; titles, locations, body, schedule contents NEVER logged.
- `findTimeOverlaps` kept verbatim with a `@deprecated` JSDoc tag (orchestrator still imports it pre-11-05). Removal scheduled for plan 11-05.

### `apps/web/utils/calendar/reconciliation/arbitrate.test.ts`
- Rewritten end-to-end. Old `findTimeOverlaps` tests dropped (the function is deprecated and its behavior is unchanged; the new overlap function is tested in 11-02's overlap.test.ts).
- 17 `it()` blocks across two `describe` groups:
  - `arbitrationSchema` (5 tests): accepts each of the four verdicts, rejects legacy `AMBIGUOUS`.
  - `arbitrateOverlap` (12 tests): whitelist pass/fail, id normalization, failure passthrough, prompt structure, providerOptions cacheControl shape, fallback to plain-string system for non-Anthropic, temperature/maxOutputTokens contract.
- Mocking pattern copied verbatim from `extract.test.ts`: `vi.mock` declared before the SUT import; `Provider.ANTHROPIC` mocked via `@/utils/llms/config`.

## Decisions made

### System prompt design (Claude's discretion per D-06)
The system prompt is a single static string covering: per-verdict definitions with worked examples (SAME-via-semantic-equivalence, SAME-across-marketing-wording, RESCHEDULE-with-explicit-wording, SEPARATE-same-slot-different-domain, SKIP-marketing-CTA, prompt-injection-defense). Decision discipline appendix: prefer SEPARATE over SAME when in doubt, prefer SAME over RESCHEDULE when in doubt, prefer SEPARATE over SKIP when in doubt — under-match is recoverable, falsely silencing is not.

**Token count estimate:** SYSTEM_PROMPT is approximately 1300 words / 9000 characters → roughly **2000–2400 tokens**. Well above the 1024-token Anthropic ephemeral-cache floor, so the cache breakpoint engages as soon as arbitration volume warms up (1–3 calls/day per the v1.1 use case is below the 5-minute TTL on cold-cache days but the system prompt size still serves as token-count headroom for examples).

### Prompt-injection defense
The untrusted-data paragraph diverges from `arbitrate.ts`'s previous wording: rather than instructing the model to "return null", the new prompt instructs the model to fall back to `verdict="SEPARATE"`. SEPARATE is the safe default because it creates a new event the user can manually delete — under no circumstance should body-injected text be allowed to silence a real event by forcing SAME or SKIP. This aligns with the project-wide "over-creation is recoverable; under-creation is not" discipline (D-08).

### Schema field ordering
Schema dropped the Phase 9 `reasoning` field. It was logged-only and never read by downstream code, and removing it tightens the output token budget (the schema now realistically fits in `maxOutputTokens: 100`).

## Verification

**Static gates from the plan (acceptance criteria) — all PASS:**

```text
$ grep -cE '"SAME"|"RESCHEDULE"|"SEPARATE"|"SKIP"' arbitrate.ts
14            # plan required ≥4; the enum literal + worked examples bring it to 14

$ grep -c cacheControl arbitrate.ts
1             # plan required ≥1

$ grep -cE '<calendar_context>|<email_body_untrusted>' arbitrate.ts
10            # plan required ≥2 (system prompt + worked examples reuse the tag)

$ grep daySchedule arbitrate.ts | head -1
arbitrateOverlap signature renamed parameter — visible at call site (11-05).

$ grep -A1 '@deprecated' arbitrate.ts
# findTimeOverlaps carries the JSDoc tag.
```

**Test counts:** 17 `it()` blocks committed (plan required ≥11). Test 7 (`SAME with unknown id throws`) asserts on `/arbiter_invalid_matched_id/` regex match per acceptance criteria.

## Deferred Issues

### Test execution deferred to CI (per CLAUDE.md hardware constraint)
The plan's `<verify><automated>` step calls for `cd apps/web; pnpm test -- utils/calendar/reconciliation/arbitrate.test.ts --run`. Per the project's `CLAUDE.md` "CRITICAL — do not run locally" section and the executor's hardware-constraint guardrail (Intel N150 / 3.6 GB RAM), `pnpm test` is not run in this worktree. The test file is committed and follows the exact pattern of the adjacent `extract.test.ts`, which CI runs green. Test verification happens in GitHub Actions on the next push.

### Orchestrator call-site breakage is expected (resolved in 11-05)
`apps/web/utils/calendar/reconciliation/index.ts` still calls `arbitrateOverlap` with the old signature (`existingEvents`, no `endISO`/`location`, expects `{matchedEventId}` back). This will break the TypeScript build until plan 11-05 rewrites the orchestrator. The plan explicitly scoped this transitional state — `index.ts` is not in `files_modified` for 11-03.

Similarly `apps/web/utils/calendar/reconciliation/index.test.ts` mocks `arbitrateOverlap` with the old return shape; 11-05 will update those mocks.

## Deviations from Plan

**None — plan executed exactly as written.** Two adjustments worth flagging but neither qualifies as a deviation:

1. **Worktree path-routing repair (Rule 1, bug).** The first attempt at `Write` resolved the `C:\Users\rebek\projects\inbox-zero-rebekah\...` absolute path through the **main repo** rather than the agent's worktree. Caught by post-write `git status` showing no changes inside the worktree but a dirty file in the main checkout. Recovery: `git checkout -- apps/web/utils/calendar/reconciliation/arbitrate.ts` in the main repo (no commits were lost — the bad write never made it into git history); re-applied the same content via the worktree-prefixed absolute path `C:\Users\rebek\projects\inbox-zero-rebekah\.claude\worktrees\agent-abe054ef63157feec\...`. This is exactly the failure mode documented in the executor's worktree-path-safety reference. No content change, no commit-history impact.

2. **`buildArbitrationSystem` extracted as a private function** rather than reusing `buildExtractionSystem` directly. The arbitration prompt has no `{{TZ}}` placeholder (timezone is not relevant to identity arbitration), so reusing `buildExtractionSystem` would require either passing a junk TZ argument or threading a generic builder. A separate dedicated function with no parameters beyond `provider` is cleaner. The cache_control shape is byte-identical to the extract version.

## Threat Surface Scan

The plan's threat register covers T-11-03-01 through T-11-03-04 plus T-11-03-SC. Implementation status:

- **T-11-03-01 (body injection):** Mitigated. `promptHardening: { trust: "untrusted", level: "full" }` threaded through `createGenerateObject`. Body wrapped in `<email_body_untrusted>` delimiter. Untrusted-data paragraph in system prompt explicitly tells the model that body content is data and that any instruction-like text inside it forces `verdict="SEPARATE", matchedEventId=null` (the safe default — produces a new event, never silences an existing one).
- **T-11-03-02 (id spoofing):** Mitigated. Post-parse `validIds` Set check; mismatch throws `arbiter_invalid_matched_id`. Tested directly.
- **T-11-03-03 (info disclosure via logging):** Mitigated. `logger.info` / `logger.warn` calls in `arbitrateOverlap` only emit `{ verdict, dayScheduleCount }`. No title, no location, no body content, no schedule contents.
- **T-11-03-04 (DoS via overlong schedule):** Accepted per plan. Day-bound size cap is enforced by the orchestrator's day-of-overlap selection upstream.
- **T-11-03-SC (supply chain):** N/A — no new dependencies. `zod`, `ai-sdk`, and `@/utils/llms` were all already in package.json.

No new threat surface beyond what the plan enumerated.

## Self-Check: PASSED

Commits exist on the agent branch:

```text
$ git log --oneline -3
72e6f87ca test(11-03): cover four-outcome arbitration schema and whitelist semantics
8c14a766e feat(11-03): rewrite arbitrate.ts with four-outcome verdict schema
5d1fa7d7d chore(reconciliation): satisfy ultracite formatter on arbitrate diff
```

Files exist and contain expected content:

- `apps/web/utils/calendar/reconciliation/arbitrate.ts` — 395 lines, 14 hits on verdict literals, 1 hit on `cacheControl`, 10 hits on the two delimiter tags, `@deprecated` tag on `findTimeOverlaps`.
- `apps/web/utils/calendar/reconciliation/arbitrate.test.ts` — 17 `it()` blocks, 4 references to `arbiter_invalid_matched_id`.

---

*Phase 11 Plan 03 complete. Orchestrator (11-05) will swap to the new `arbitrateOverlap` contract and remove the deprecated `findTimeOverlaps` helper.*
