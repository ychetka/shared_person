# CDP write-call audit (issue #127)

Directive: in the shared_person contour the Chrome DevTools Protocol is
**read-observe only**. Banned everywhere: `Target.createTarget` /
`Target.activateTarget` / `Target.closeTarget` (any tab open/close/
focus via CDP), `Runtime.evaluate`, `Input.*`, `Page.reload`,
`Page.handleJavaScriptDialog` (outside the `EYES_ALLOW_DISMISS`-gated
emergency path), and any DOM-driven field filling. All actuation is
OS-level input: xdotool keyboard/mouse and the clipboard holder.

Allowed read-observe set that STAYS:

- `GET /json/list`, `GET /json/version` - target enumeration
  (url/title/id). Used by `hands-agent/cdp.py` (`targets`, `find_page`,
  `tab_info`) and `eyes-agent/cdp_client.py`. This is the post-publish
  URL read-back channel.
- `Page.enable` + `Page.javascriptDialogOpening` /
  `Page.javascriptDialogClosed` event subscription on a persistent
  page socket (`eyes-agent/dialog_watch.py` via `PageWs`) - the typed
  js_dialog corroboration channel.
- `Page.captureScreenshot` - page-viewport pixel fallback
  (`hands-agent/vision.py`, `eyes-agent/capture.py` method `cdp`).
- `Page.handleJavaScriptDialog` ONLY through
  `dialog_watch.dismiss()`, hard-gated on `EYES_ALLOW_DISMISS=1`
  (emergency un-wedge / test path - the command only works from a
  Page-enabled session and real dismissal stays OS-level in prod).

## Write-call inventory

### hands-agent/cdp.py — REMOVED in this PR

| Call | Class | Replacement |
|---|---|---|
| `eval_js` (`Runtime.evaluate`, the transport for everything below) | write (evaluate) | none - function deleted |
| `_chrome_offset` (evaluate `window.screen*/outer*/inner*/dpr`) | write (evaluate) | not needed - `locate`/`find` answer SCREEN coords directly |
| `dom_rect` (evaluate `_CAND_SCAN` -> screen coords) | write (evaluate) | `locate`/`find` on the screenshot -> coords |
| `click_dom` (dom_rect -> `hands.click`) | write (evaluate) | `locate` + `click` recipe steps |
| `js_click` (evaluate + `el.click()`) | write | real OS `click` at located coords; if a surface truly ignores OS input that is a documented gap, not an evaluate path |
| `dom_text` (evaluate: element text+href / location read-back) | write (evaluate) | location read-back -> `tab_url` (`/json/list`); element text -> `locate`/OCR on screenshot (OCR = follow-up gap) |

Kept: `targets`, `find_page`, `tab_info`, `_call` (read-only uses only).

### hands-agent/mcp_server.py — tools removed, recipe actions stubbed

| Item | Class | Replacement |
|---|---|---|
| tools `dom_find`, `click_dom`, `js_click`, `dom_text` | write (evaluate) | tools `open_tab_bg`, `tab_url`; `locate`+`click` for elements |
| recipe actions `dom_find`/`click_dom`/`js_click`/`dom_text` | write (evaluate) | FAIL-CLOSED stubs - named error, no page contact |
| new action `open_tab_bg` | OS-level | `tab_ctl.open_tab_bg`: ctrl+t -> clipboard paste URL -> Return -> ctrl+shift+tab back to origin tab (SPA initializes occluded) -> settle -> ctrl+9 activates the last tab |
| new action `tab_url` | read-only | `cdp.tab_info` (`/json/list` only) |
| `locate` gains `optional` + `<into>_hit` ctx flag; `if:` gains `!` negation | engine | supports fail-closed gating on locate misses |

### hands-agent/recipes/*.yaml

| Recipe | Status |
|---|---|
| `habr_post.yaml` | REWRITTEN: `open_tab_bg` for the composer (settle 60), blocked-surface probes via optional `locate` + `tab_url`, title/hubs/body/publish via `locate`+`click`, hubs suggestion clicked by coordinates (the autocomplete gap fix - no paste+Enter), URL read-back via `tab_url` |
| `habr_probe.yaml` | REWRITTEN: `open_tab_bg` -> `locate` title -> OS `click` -> `tab_url` on the landed tab. The href-extraction gap is gone by doing what a human does |
| `facebook_post`, `linkedin_post`, `pangram_check`, `x_app_onboarding`, `x_post` | MIGRATION NOTICE headers added; their dom_* steps now fail closed until rewritten to `locate`+`click` |

### eyes-agent — cleanup in this PR

| Call | Class | Replacement |
|---|---|---|
| `cdp_client.open_tab` (`Target.createTarget` background + `Target.activateTarget`) | write | `hands-agent/tab_ctl.open_tab_bg` (OS chords) |
| `cdp_client.close_tab` (`Target.closeTarget`) | write | OS `ctrl+9` + `ctrl+w` on the target tab |
| `cdp_client.activate_tab` (`Target.activateTarget`) | write | OS `ctrl+9` / `xdotool windowactivate` (already used in capture.py) |
| `cdp_client.eval_js` (`Runtime.evaluate`) | write (evaluate) | deleted; `tab_info` (`/json/list`) covers url/title needs |
| `observation._cdp_state` readyState probe (`Runtime.evaluate`) | write (evaluate) | `/json` listing only; `reachable` = live page target listed, `readyState` no longer reported (suspended-renderer signal now comes from x_window capture + dialog events) |
| `dialog_watch.dismiss` (`Page.handleJavaScriptDialog`) | write, GATED | stays - `EYES_ALLOW_DISMISS=1` emergency path only; prod dismissal is the OS `Return` keypress |

### tools/eyes_probe.py — REWRITTEN in this PR

| Call | Class | Replacement |
|---|---|---|
| `cdp_client.open_tab`/`close_tab` | write | `tab_ctl.open_tab_bg` / OS `ctrl+9`+`ctrl+w` |
| `Page.reload` (fire-and-forget) | write | real `F5` keypress |
| `_click_el` / `_make_dirty` evaluate (rect resolve + read-back) | write (evaluate) | `locate` -> OS click + clipboard paste; read-back reported as unavailable |
| injected-variant `eval_js` (`window.onbeforeunload=...`) | write (evaluate) | TYPED `javascript:` URL in the omnibox (Chrome strips the scheme on paste, not on typed input) + real click for user activation |
| `_page_responsive` (`Runtime.evaluate` timeout probe) | write (evaluate) | x_window pixel capture reported as `pixels_captured` (honest proxy, not renderer liveness) |
| `dialog_watch.dismiss_dialog` | gated write | OS `Return` on the in-window dialog |

### tools/vk_token_service.py / tools/vk_token_issue.py — FLAGGED, follow-up

| Call | Class | Status |
|---|---|---|
| `ws_eval`/`_ws_eval` (`Runtime.evaluate` -> localStorage token read, consent DOM scan) | write (evaluate) | **DOCUMENTED GAP - requires developer decision.** The call is a pure READ in intent but travels on a banned transport. There is no OS-level equivalent for localStorage extraction; candidate replacements are (a) operator copies the token manually, (b) a Network-domain response sniff (also needs a ruling), or (c) a narrowly-scoped directive exception for this separate service. Not silently left as-is in spirit - flagged for a dedicated issue. |
| `Page.bringToFront` (vk_token_issue) | write | `xdotool windowactivate` / `ctrl+9` on the target tab |

### eyes-agent — legitimately read-only, STAYS

- `dialog_watch.attach` / `watch_for_dialog`: `Page.enable` +
  `Page.javascriptDialog*` event subscription (`PageWs`).
- `capture._cdp_shot`: `Page.captureScreenshot` page-viewport fallback.
- `cdp_client.targets`/`find_page`/`tab_info`: `/json` HTTP listing.

## Replacement architecture (implemented vs designed)

- IMPLEMENTED: `hands-agent/tab_ctl.py` (`open_tab_bg`, `close_active_tab`),
  `cdp.tab_info`/`cdp_client.tab_info` (`/json` read-back), recipe
  actions `open_tab_bg`/`tab_url`, `locate`+`optional`+`_hit` flags,
  `if: "!..."` negation, fail-closed dom_* stubs.
- IMPLEMENTED: `habr_post.yaml` + `habr_probe.yaml` on the OS-only
  split; `eyes_probe.py` fully OS-actuated.
- DESIGNED / FOLLOW-UP GAP: generic 'find element by TEXT on
  screenshot -> click coords' without the vision model. Today text
  targeting needs `locate` (GEMINI_API_KEY) or a pre-cut `find`
  template. An OCR locator (tesseract or similar) keyed by visible
  text is the documented follow-up - until it lands, text-target
  steps fail closed rather than degrade to Enter-fallbacks or CDP.
- DESIGNED / FOLLOW-UP GAP: vk_token_* evaluate calls (above).
- DESIGNED / FOLLOW-UP: recipe migrations for facebook/linkedin/
  pangram/x_* (headers flag them; they fail closed today).
