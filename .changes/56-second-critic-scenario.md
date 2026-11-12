---
type: fix
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: >-
  check_fig_numbering.js gains scenario S12 with stateful role stubs
  (a critic that rejects then passes, plus a rewritten writer output)
  asserting the second critic /run call after a verifier-driven
  rewrite carries the rewritten draft's datasets and captions, not
  the rejected one's.
why: >-
  Issue #56 item (c) from the PR #55 review: the harness covered the
  single-pass critic payload but never the reject -> rewrite ->
  re-verify path, so a regression verifying stale pre-rewrite
  visuals[] would go unnoticed. visualClaims() reads `parsed` at
  call time; S12 pins that contract.
refs: "issue #56, PR #55"
---

## Spec impact
-
