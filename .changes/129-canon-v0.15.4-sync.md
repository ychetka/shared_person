---
# type: fix | feat | refactor | chore | docs
type: chore
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Byte-for-byte sync of canonical infra v0.15.4 into tracked .devin/ — new repo_* verbs (issue_create, issue_close, pr_open, pr_edit, pr_review, read, status_check, branch_delete), check_setup/session_audit/verify_constraints scripts, agents git.md/hygiene.md/repository.md, and refreshed diffs on gate_tests, hygiene_check, repo_issue_comment, repo_merge, repo_release, ship_push, code_writer.md, reviewer.md. ship_commit.sh and migration_gate.sh carry no diff vs main: an earlier sync draft had pulled stale runtime copies from the workspace root .devin/ (the runtime copies lagged canonical, not the reverse — corrected by orchestrator audit msg_1005); they are restored to origin/main, which already matches canonical fleet templates.
why: Canon at the workspace root moved to v0.15.4; the tracked tree drifted behind. Syncing byte-for-byte (md5-verified, same procedure as PR #107) removes drift and ships the repository-agent verbs doc.
refs: "issue #129"
---

## Spec impact
-
