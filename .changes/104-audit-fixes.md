---
# type: fix | feat | refactor | chore | docs
type: fix
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Audit of unreviewed rollout issue #104 - migration gate hardened (rollback-section markers, per-file roll-forward notes, project.json dry-run), scope gate checks rename source paths, harness excerpt declares its scope, reviewer wrapper is portable, judge exec boundary stated, untrusted-content review rule added.
why: The fleet quality gates and adopted harness excerpt were merged without review; this PR applies the audit findings that close bypass paths in the mechanical gates and documents capability boundaries for the agent profiles.
refs: "issue #104, task 272"
---

## Spec impact
-
