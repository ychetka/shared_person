# hands-agent

Real OS-level input + computer vision for platforms without personal-profile APIs
(Facebook, Instagram, TikTok, LinkedIn fallback). No DOM selectors, no CDP, no
browser extensions - events are trusted OS input, behaviorally human.

**CDP READ-ONLY INVARIANT (issue #127):** CDP is read-observe only in
this contour. Banned everywhere: `Runtime.evaluate`, `Target.*`,
`Input.*`, `Page.reload`, `Page.handleJavaScriptDialog` (outside the
EYES_ALLOW_DISMISS-gated emergency path), DOM-driven field filling.
Allowed reads: `/json` target listing, `Page.captureScreenshot`,
`Page.javascriptDialog*` event subscription. All actuation is OS-level:
xdotool keyboard/mouse, clipboard holder, `tab_ctl.open_tab_bg` for
tabs. See docs/cdp-write-audit.md for the full write-call inventory
and replacement mapping.

## Architecture

```
n8n --(JSON task)--> queue/inbox/*.json --+
                                          +--> engine --> xdotool (input) + OpenCV (screen)
Devin --(MCP tools)--> mcp_server.py -----+
```

- `mcp_server.py` - MCP stdio server (tools + recipe runner + queue poller)
- `hands.py` - xdotool primitives: Bezier mouse paths, jitter typing
- `tab_ctl.py` - OS-level tab control (`open_tab_bg`: background-load via
  ctrl+t + ctrl+shift+tab + ctrl+9; the heavy-SPA-safe open path)
- `cdp.py` - READ-ONLY CDP: /json target listing + the
  Page.captureScreenshot transport for vision.py's pixel fallback
- `vision.py` - screenshots + OpenCV template matching (multi-scale)
- `recipes/*.yaml` - per-platform step scripts (mini-DSL)
- `queue/{inbox,done,failed}/` - file-based task queue for n8n

## Requirements

```bash
sudo apt install xdotool imagemagick python3-opencv python3-numpy python3-yaml
# vision-model locate (optional): GEMINI_API_KEY env var
```

X11 session required (xdotool). Detected here: DISPLAY=:1, X11.

## MCP tools

| Tool | Purpose |
|---|---|
| `screenshot` | PNG of the full screen -> path |
| `click x,y` | Bezier-move + click |
| `move x,y` | Bezier mouse move |
| `type_text` | Human-jitter typing |
| `key` | Key combo (ctrl+t, Return...) |
| `scroll` | Wheel up/down |
| `find` | Template match -> coords |
| `locate` | Gemini vision locate -> coords |
| `run_recipe` | Execute recipes/<name>.yaml |
| `task_status` | Queue status |
| `set_clipboard` | Load X CLIPBOARD (PyGObject Gtk) for `key ctrl+v` long-body paste |
| `open_tab_bg` | OS-level background-load tab open (heavy-SPA-safe) |
| `tab_url` | Read-only /json tab url+title read-back |

Removed tools (banned by the CDP read-only directive): `dom_find`,
`click_dom`, `js_click`, `dom_text` - all ran on `Runtime.evaluate`.

## Recipe DSL (recipes/*.yaml)

```yaml
name: example
steps:
  - action: locate           # vision-model find -> coords into ctx[pos]
    target: "button 'Post'"
    hint: "bottom right"
    into: pos
  - action: find             # OpenCV template match
    template: templates/send.png
    confidence: 0.85
    into: pos
  - action: click            # pos: name | x,y literal
    pos: pos
  - action: type
    text: "{text}"           # {param} substitution
  - action: key
    keys: "ctrl+v"
  - action: scroll
    amount: 3
    direction: down
  - action: wait
    seconds: 2
  - action: shot             # screenshot -> queue/done/
    name: result.png
```

## n8n queue contract

Drop `task_id.json` into `queue/inbox/`:

```json
{"recipe": "facebook_post", "params": {"text": "Hello world"}}
```

Poller consumes -> `queue/done/` or `queue/failed/` + in-memory `task_status`.

Result channel (habr-driver-spec 2.4): on completion the poller also
writes `queue/<done|failed>/<task_id>.result.json` with the recipe's
returned fields (`{ok, url?, error?, log?}`) - this is how n8n records
`external_ids` and classifies pre-click vs post-click failures. Recipe
steps publish values into the result via `emit`:

```yaml
  - action: open_tab_bg        # OS-level background-load tab open
    url: "{profile_url}"
    settle: 45                 # SPA initializes while occluded
  - action: locate             # vision-model find -> coords into ctx
    target: "the first suggestion in the hubs autocomplete popup"
    into: sug
    optional: true             # a miss sets ctx[sug_hit]="" not a failure
  - action: click
    pos: sug
    if: "{sug_hit}"            # locate sets <into>_hit = "1"|""
  - action: fail               # negated if: run when the locate missed
    reason: "no clickable suggestion"
    if: "!{sug_hit}"
  - action: tab_url            # read-only /json listing -> ctx[page]=url
    url: "habr.com"
    into: page
  - action: set_clipboard      # PyGObject Gtk clipboard for ctrl+v
    text: "{text_md}"
  - action: emit               # ctx value -> result field
    key: url
    value: "{page}"
```

Fail-closed stub actions (abort the recipe with a named error, no page
contact): `dom_find`, `click_dom`, `js_click`, `dom_text`.

## Safety

- Real trusted input events (unlike JS-injected `isTrusted=false`)
- Bezier mouse + jittered typing/delays
- Per-recipe screenshots into `queue/done/` for moderation audit trail
- Vision-model `locate` degrades gracefully to template `find`

## OS-level input: long text + clipboard (survey, issue #3)

Decision (developer): text insert for long bodies must be OS-level -
no CDP `insertText`/`Input.dispatch`, so the target app cannot tell
automation input from human input. Surveyed on this box (X11,
DISPLAY :1):

- `xdotool type` - present, trusted XTEST events, already used via
  `type_text` jitter. Works for long bodies too (`--delay 5-15`),
  just slow - the zero-dependency fallback.
- `xclip` / `xsel` - NOT installed. The canonical clipboard path
  (`xclip -sel clip` + ctrl+v); smallest possible new dep.
- PyGObject (`python3-gi`, Gtk) - INSTALLED. `Gtk.Clipboard` can set
  the X CLIPBOARD selection with zero new packages, so a
  `set_clipboard` action is buildable today: set selection via GTK,
  then recipe `key ctrl+v` pastes as a normal OS paste event.
- `wl-copy`/`wl-paste` - absent and N/A (X11 session, not Wayland).
- `/dev/uinput` / `ydotool` - kernel-level path, but `/dev/uinput`
  is root-only (crw------- root:root) - needs a udev rule or group
  membership; not worth it while XTEST covers the need.

Recommendation: implement `set_clipboard` on the PyGObject path now,
keep `type` as fallback; revisit xclip only if GTK clipboard proves
flaky.

## UX rules (mandatory in recipes)

- **Ad/popup dismissal**: before acting, check for blocking overlays (ads, cookie banners, upsell modals) and close them first: `locate` the close/dismiss control ("Close", "X", "Not now" or its RU equivalent) -> `click`, or Escape. Insert a dismiss step at recipe start and after navigations.
- **Verify before click**: locate/find > shot > click; after each mutating step take a shot.
- **Moderation gate**: never publish without an explicit approve step. No `test:true`/test posts to live services (issue #58 directive update) - media-upload verification happens via metrics on REAL posts; the required post structure is baked into content generation, never ad-hoc test payloads.
