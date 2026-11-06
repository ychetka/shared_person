# hands-agent

Real OS-level input + computer vision for platforms without personal-profile APIs
(Facebook, Instagram, TikTok, LinkedIn fallback). No DOM selectors, no CDP, no
browser extensions - events are trusted OS input, behaviorally human.

## Architecture

```
n8n --(JSON task)--> queue/inbox/*.json --+
                                          +--> engine --> xdotool (input) + OpenCV (screen)
Devin --(MCP tools)--> mcp_server.py -----+
```

- `mcp_server.py` - MCP stdio server (tools + recipe runner + queue poller)
- `hands.py` - xdotool primitives: Bezier mouse paths, jitter typing
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

- **Ad/popup dismissal**: before acting, check for blocking overlays (ads, cookie banners, upsell modals) and close them first: click_dom on "Close/X/Not now/Не сейчас" or Escape. Insert a dismiss step at recipe start and after navigations.
- **Verify before click**: dom_find > shot > click; after each mutating step take a shot.
- **Moderation gate**: never publish without an explicit approve step (test posts = neutral AI-themed text + neutral image).
