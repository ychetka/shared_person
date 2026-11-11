---
# type: fix | feat | refactor | chore | docs
type: chore
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Byte-for-byte adoption of canonical fleet templates (agents, gate scripts incl. new migration_pattern.sh, hazards docs, full harness.md, new development-cycle.md) plus .gitignore entry for .devin/cycle_log.jsonl.
why: Canonical templates now carry the hardened versions audited under PR #105 (closed as superseded); copying byte-for-byte removes drift and pulls in the expanded 53-test gate suite. cycle_log.jsonl is runtime-regenerated, so ignoring it prevents accidental re-staging while keeping it tracked in history.
refs: "issue #106, task 277, supersedes PR #105"
---

## Spec impact
-
