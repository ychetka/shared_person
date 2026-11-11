---
type: fix
scope: hands-agent
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Reverts the pangram_check recipe submit/back steps to OS-level click_dom actions targeting the 'Check for AI' button.
why: Live verification refuted issue #86's premise - js_click/JS probes leave 'Check for AI' inert, while real xdotool OS clicks reach the handler, so the recipe goes back to click_dom.
refs: PR #109, issue #86
---

## Spec impact
- "-"
