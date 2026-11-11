# tgm-pangram-sched-trigger.md - one file per PR, public-safe content only.
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
dev_summary: Add the Poll Pangram Results schedule node to the triggers array of the sp-tg-moderation workflow spec so the offline deployer registers it.
# why: motivation/decision in one or two sentences. For fix/docs/
# chore this file serves as the micro-ADR - make why carry it.
why: tools/deploy_workflow.js only writes workflow_publication_trigger_status rows for nodes listed in spec.triggers, so the 2-minute pangram poller was never registered and never fired; schedule nodes need only a {"node": ...} entry (triggerKind in-memory).
# refs: task IDs, issue/PR, directive/decision links.
refs: deployer audit of workflow_publication_trigger_status
---

## Spec impact
- adds: -
- modifies: -
- removes: -
