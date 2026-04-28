---
plan: 03-01
phase: 03-classification-engine
status: complete
completed: 2026-04-27
wave: 1
---

# Summary: Wave 0 Pre-Flight — SSM Configuration

## What Was Built

All five SSM parameters required for three-tier LLM routing are now set in AWS SSM (us-east-1). The classification engine will use Haiku instead of Sonnet as its economy tier on next container boot.

## SSM Parameters Set

| Parameter | Value | Action |
|-----------|-------|--------|
| ECONOMY_LLM_PROVIDER | anthropic | created (was missing) |
| ECONOMY_LLM_MODEL | claude-haiku-4-5-20251001 | created (was missing) |
| NANO_LLM_PROVIDER | anthropic | created (was missing) |
| NANO_LLM_MODEL | claude-haiku-4-5-20251001 | created (was missing) |
| NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS | true | created (was missing; ParameterNotFound) |

## External Verifications (Human-Confirmed)

- **Haiku model name:** `claude-haiku-4-5-20251001` — verified at docs.anthropic.com as GA (Claude Haiku 4.5)
- **Anthropic credit balance:** $2.91 — below $5 safety threshold; sufficient for Waves 2-3 (no AI calls); top up to $10 before Wave 4 deploy

## Key Facts for Downstream Waves

- Wave 3 unit test mocks must use model name: `claude-haiku-4-5-20251001`
- Wave 4 deploy will activate Haiku routing on container restart (no further SSM changes needed)
- DIGEST actions will no longer silently skip — premium bypass is active

## Open Concern: Model Name Staleness

Haiku model `claude-haiku-4-5-20251001` will eventually be deprecated by Anthropic. When that happens, `ECONOMY_LLM_MODEL` and `NANO_LLM_MODEL` in SSM must be updated manually. No automated detection is in place. Mitigation options for a future phase:
- Add a startup health check that pings the configured model and alerts on 404
- Include model version in the quarterly run-book review

## Self-Check: PASSED

- [x] All 5 SSM parameters set and verified via `get-parameter`
- [x] Haiku model name documented (used by Wave 3 test mocks)
- [x] Credit balance confirmed ($2.91 — flagged for top-up before Wave 4)
- [x] No container restart triggered — vars take effect on Wave 4 deploy boot
