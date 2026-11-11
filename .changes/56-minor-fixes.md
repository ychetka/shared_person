---
type: fix
scope: n8n
user_visible: false
breaking: false
user_summary: "-"
dev_summary: >-
  Generate Drafts now sends every visual caption to the critic (not
  only dataset-less tasks), bounds the whole per-visual claim line at
  640 chars, and logs a 'delivered' count next to 'matched' in the
  perf-summary line; render_viz disables mathtext so literal '$$' in
  matrix cells no longer kills chart renders; check_analytics printed
  labels now match their documented scenario ids; writer-fb documents
  the optional top_performers brief field; check_li_media gains an S9
  bearer-token scrub assertion.
why: >-
  PR #55 review follow-ups (issue #56): captions on dataset-backed
  visuals bypassed fact-checking, the 600-char claim cap ignored the
  'visual N ...' head prefix, a '$$' in a table cell raised a mathtext
  ParseException, and the perf-summary 'matched' counter conflated
  injected entries with delivered drafts. The prompt/check-file items
  keep docs and assertions in sync with behavior.
refs: issue #56, PR #55, PR #66
---

## Spec impact
-
