---
type: feat
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Adds tools/text_metrics.js (TF-IDF meaning cosine, length-ratio guardrails, LLM-judge readability via the inhouse gateway) and tools/pilot_metrics.js, which rescans the pilot artifacts and appends metrics rows to the Pangram pilot ledger.
why: HumanizerBench proposal P1 - the Pangram-only eval gate misses the drift/padding/deletion failure modes the benchmark penalizes; these three zero-cost signals mirror its meaning/length/readability dimensions without paid API calls.
refs: task 342
---

## Spec impact
-
