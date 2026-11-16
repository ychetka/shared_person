---
# writer-dispatch-mvp.md - one file per PR, public-safe content only.
# type: fix | feat | refactor | chore | docs
type: feat
# scope: module/subsystem touched (llm-gateway, rss-reader,
# hands-agent, edge, n8n, prompts, tools, scripts, deploy, docs, ci)
scope: n8n
user_visible: false
breaking: false
# user_summary: one sentence for the User-facing section; required
# when user_visible is true, "-" otherwise.
user_summary: "-"
# dev_summary: one sentence for the Codebase section.
dev_summary: Add the sp-writer-dispatch n8n workflow spec (issue #143 MVP): writer-task dispatch webhook with task card + sendDocument delivery to the writers' group, submission webhook with reply-binding/sha256-dedup/scan-mutex, inline Pangram API gate with per-writer calibrated threshold, Originality queue/done file contract with a 60s poller applying GREEN/YELLOW/RED/timeout verdicts, and check_sync.js coverage for the 20 new SYNC block copies.
# why: motivation/decision in one or two sentences. For fix/docs/
# chore this file serves as the micro-ADR - make why carry it.
why: The pipeline's measured reality (writer_interface_spec.md) is that machine text cannot be bought to human detector scores, so a human writer stage sits between brief pack and moderation; this workflow implements the MVP contract - dispatch package (brief + AI etalon with the paraphrase-warning header), file-only replies bound to the task card, sequential Pangram-then-Originality acceptance gates with bounded retries, and escalation paths that never lose a draft to infrastructure failure.
# refs: task IDs, issue/PR, directive/decision links.
refs: "issue #143, .devin/writer_interface_spec.md, .devin/writer_interface_mvp.md"
---

## Spec impact
-
