---
# type: fix | feat | refactor | chore | docs
type: fix
# scope: module/subsystem touched (llm-gateway, rss-reader,
# hands-agent, edge, n8n, prompts, tools, scripts, deploy, docs, ci)
scope: n8n
user_visible: false
breaking: false
# user_summary: one sentence for the User-facing section; required
# when user_visible is true, "-" otherwise.
user_summary: "-"
# dev_summary: one sentence for the Codebase section.
dev_summary: sp-publish Publish Tick - local fs errors and malformed registerUpload answers become per-file terminal drops instead of endless requeues, probeOrphan gains a media-only match arm on both drivers, and the LinkedIn upload loop normalizes mech.headers plus polls asset availability before ugcPosts.
# why: motivation/decision in one or two sentences. For fix/docs/
# chore this file serves as the micro-ADR - make why carry it.
why: PR #57 review follow-ups (issue #58): Node system errors and a missing uploadUrl carried no HTTP status and fell into the no-status requeue arm, dead-lettering drafts on per-file problems; media-only posts could never orphan-match on a text key; mech.headers can arrive as a {name,value} array and a still-processing asset could sink ugcPosts.
# refs: task IDs, issue/PR, directive/decision links.
refs: issue #58, PR #57
---

## Spec impact
-
