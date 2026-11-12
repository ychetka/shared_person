---
# type: fix | feat | refactor | chore | docs
type: chore
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Byte-for-byte sync of canonical infra v0.15.3 into tracked .devin/ — new repo_* verbs (issue_create, issue_close, pr_open, pr_edit, pr_review, read, status_check, branch_delete), check_setup/session_audit/verify_constraints scripts, agents git.md/hygiene.md/repository.md, and refreshed diffs on gate_tests, hygiene_check, migration_gate, repo_issue_comment, repo_merge, repo_release, ship_commit, ship_push, code_writer.md, reviewer.md.
why: Canon at the workspace root moved to v0.15.3; the tracked tree drifted behind. Syncing byte-for-byte (md5-verified, same procedure as PR #107) removes drift and ships the repository-agent verbs doc.
refs: "issue #129"
---

## Spec impact
-
