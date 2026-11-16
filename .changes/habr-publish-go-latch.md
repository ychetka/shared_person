---
type: feat
scope: hands-agent
user_visible: false
breaking: false
user_summary: "-"
dev_summary: >-
  habr_post.yaml gains a publish_go latch gating every step from the
  publish-click boundary onward (absent = dry-run proof: filled
  composer + shots, never publishes), a publish_armed result field,
  and sp-publish's Publish Tick now sends publish_go: true in the
  habr_post enqueue params.
why: >-
  Issue #74's live-verification milestone needs dry-run proof runs
  against the real site before any real-account publish; before this
  the recipe's publish click fired unconditionally once the composer
  filled. The flag is fail-safe by construction - the DSL
  if-semantics skip on absent/empty, so a missing publish_go can
  never publish - while the driver (which only runs in the live
  path) always arms it. The test retract block keeps its {test}
  gate: the DSL has no AND and {test} is only ever sent armed.
refs: issue #74, stacked on PR #113 (Wayland shot fallback for proof
  screenshots)
---

## Spec impact
-
