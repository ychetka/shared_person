---
type: refactor
scope: hands-agent
user_visible: false
breaking: true
user_summary: "-"
dev_summary: >-
  CDP is now read-observe only across the contour:
  hands-agent/cdp.py is reduced to /json listing plus
  Page.captureScreenshot transport (eval_js, dom_rect, click_dom,
  js_click, dom_text and the _CAND_SCAN machinery removed), the new
  tab_ctl.py adds the OS-only open_tab_bg path, the mcp_server
  replaces dom_* tools with open_tab_bg/tab_url and fail-closed
  stubs, eyes-agent drops Target.* and Runtime.evaluate, and
  tools/eyes_probe.py is rewritten to OS actuation. Full write-call
  inventory and replacement mapping in docs/cdp-write-audit.md.
why: >-
  Developer directive: CDP in the shared_person contour must be
  READ-OBSERVE ONLY - no DOM writes, no JS evaluation. Removing the
  calls outright (rather than gating them) makes violation
  impossible; recipes that still need locate+click carry migration
  notices and fail closed until their OS-level migrations land.
refs: issue #127
---

## Spec impact
-
