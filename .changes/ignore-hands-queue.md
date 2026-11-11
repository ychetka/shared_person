---
type: chore
scope: hands-agent
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Adds hands-agent/queue/inbox/ and hands-agent/queue/failed/ to .gitignore so runtime queue state is no longer reported as untracked.
why: The hands-agent task queue is runtime state written by n8n and the worker; inbox/failed files are transient and should never be committed, while queue/done keeps its tracked historical PNGs.
refs: chore/ignore-hands-queue
---

## Spec impact
-
