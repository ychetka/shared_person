---
# type: fix | feat | refactor | chore | docs
type: fix
scope: n8n
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Added validateDraftShape (issue #69) - a light draft-file shape gate (id string, platform/status enums, parseable created_at) running inside every updateDraft copy and before each direct DRAFTS/<id>.json write in Handle TG Update, Prepare Draft, Compose Message and Handle Pangram Results. Malformed drafts now throw BEFORE writeJsonAtomic's tmp+rename instead of persisting corrupt state. The async content-gen dispatch timeout and per-draft withLock RMW sections from the same issue were already landed under #70/#71.
why: Pre-publish hardening - a malformed draft record (buggy producer, hand-edited file) could be persisted and later published/moderated on bad shape.
refs: "issue #69"
---

## Spec impact
-
