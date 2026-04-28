# Phase 3: Classification Engine — Discussion Log

**Date:** 2026-04-27
**Participants:** Rebekah + Claude

---

## Areas Discussed

All four areas were selected for discussion.

---

### Area 1: Haiku→Sonnet Escalation

**Q: What triggers escalation from Haiku to Sonnet?**
Options: noMatchFound only / Low confidence OR noMatchFound / Always run both
**Selected:** Low confidence OR noMatchFound

**Q: What confidence threshold should trigger Sonnet escalation?**
Options: 0.8 (Recommended) / 0.7 / 0.9
**Selected:** 0.8

**Decision locked:** Escalate when `confidenceScore < 0.8` OR `noMatchFound = true`.

---

### Area 2: "Uncertain" — Rule or Fallback?

**Q: How should "Uncertain" work in the classification system?**
Options: Explicit Rule in DB / Code-level fallback only / Both (rule + fallback)
**Selected:** Explicit Rule in DB

**Q: Should Uncertain emails appear in the morning digest alongside Urgent?**
Options: Yes — show in digest with thumbs feedback / Inbox only, no digest
**Selected:** Yes — show in digest with thumbs feedback (matches DIGEST-05)

**Decision locked:** Uncertain = explicit Rule with LABEL + DIGEST actions, stays in inbox.

---

### Area 3: Conversation Rules in Prompt

**Q: Should the 4 conversation-management rules appear in the classification prompt?**
Options: Exclude from prompt / Include in prompt
**Selected:** Exclude from prompt

**Q: How should conversation rules work going forward?**
(User clarified that Inbox Zero currently auto-applies these rules via its existing mechanism — they are not user-triggered. This changed the framing of the question.)
**Decision locked:** Conversation rules continue to fire automatically via Inbox Zero's existing mechanism in parallel with Phase 3's 8-category classification. They are excluded from the classification prompt only.

---

### Area 4: Deals Category Definition

**Q: How specific should the "Deals" classification rule instructions be?**
Options: Broad now, refine with feedback / Specific from day one / You decide (broad is better)
**Selected:** Broad is better (Claude's discretion)

**Decision locked:** Start with broad instructions: "Promotional emails offering discounts, sales, or limited-time offers." Refine via Phase 6 feedback.

---

## Deferred Ideas

- Per-sender deal thresholds (Harbor Freight, Home Depot) — v2 DEAL-01, DEAL-02
- Confidence-based Gmail filter graduation — v2 LEARN-01
- Classification monitoring dashboard — v2 MON-01, MON-02

---

## Claude's Discretion Items

- Confidence score tie-breaking at exactly 0.8: implement as strict `< 0.8`
- How to filter conversation rules from the classification prompt: Claude to choose between exclusion-list vs. inclusion-list approach based on actual query structure
