---
type: feat
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: "Humanizer judge harness: added a broken_fluency fixture tier (EN-only, genuinely broken grammar), retargeted the J4 live hard-fail to broken_fluency > clean_human, demoted the ai_flop/clean_human slop ordering to a drift warning, and added a real_draft corpus cell with a real RU pipeline draft."
why: "The live judge scored all EN tiers 0/0/0 because the existing fixtures are all grammatically fluent - they test slop, not fluency, so the old J4 hard-fail could never pass. The new tier gives the fluency axis a cell a judge MUST flag near-max; slop ordering stays a warning since slop can be fluent."
refs: "issue #78"
---

## Spec impact
-
