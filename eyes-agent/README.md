# eyes-agent

Blocker observation for the automation contour (issue #121, roadmap
PRIORITY-0). hands-agent acts; eyes-agent perceives. This spike is a
**library-first** deliverable: the detection kitchen lives here, the
persistent pull-model service and driver-loop integration are the next
phase.

## The incident it solves

A dirty Habr composer (`/ru/sandbox/new/`, tiptap editor, autosaves
drafts → dirty state) raises a **native beforeunload dialog** on any
navigation/reload of its tab. While that dialog sits open the renderer
is suspended: every CDP call on the page socket times out, and the
worker diagnoses "page hung" and drops steps. The dialog is invisible
to DOM queries — verified live 2026-11-12.

## Capability map — what sees what ON THIS BOX

Verified live on this host (GNOME Wayland + XWayland, audit Chrome 157
on `DISPLAY :0`, CDP `http://127.0.0.1:9223`):

| Channel | Sees | Status here |
|---|---|---|
| `Page.javascriptDialogOpening` (CDP event) | alert / confirm / prompt / beforeunload — the whole JS-dialog class, deterministic, `confidence: 1.0` | **WORKS** — primary channel for blocker class (d) |
| `Page.captureScreenshot` (CDP) | real page pixels: error pages, captcha-in-page, in-page overlays | **WORKS** — last-resort capture, page content only, never browser/OS chrome. Caveat: background/occluded tabs emit no compositor frames and the shot hangs — `capture.py` activates the matched target first (reversible tab-focus side effect, verified 2026-11-13) |
| `import -window root`, `scrot` (X11) | full screen where root capture is allowed | **UNAVAILABLE** — exit 1 / black frame (X clients see no real pixels under Wayland). Detected, reported `usable: false` |
| `gnome-screenshot` | portal-mediated full screen | binary absent here; code path kept |
| GNOME Shell D-Bus `Screenshot` | full screen on GNOME Wayland | **AccessDenied** ("Screenshot is not allowed") — call implemented, evidence recorded |
| XDG portal `Screenshot` (interactive:false) | full screen, cross-desktop | **Response code 2** (error) — call + Response-signal wait implemented. Portal consent UX is the chicken-egg deferred post-MVP |
| X11 window tree (xdotool/xwininfo) | X11 windows only; Chrome renders dialogs in-window; GNOME dialogs are Wayland surfaces | thin aux — mostly invisible here |

**Honest split of detection:** native JS dialogs are detected by
**events** (`dialog_watch.py`) — no image exemplar is possible since no
capture path can see them here. In-page blockers (error pages, overlays,
captcha-in-page) are detected by **templates** (`detector.py` +
`templates/`) on CDP shots.

## Modules

- `cdp_client.py` — self-contained CDP plumbing (targets / find_page /
  eval_js / open_tab background-settle-activate / PageWs persistent
  event socket). Mirrors `hands-agent/cdp.py`; private copy per the
  "all screenshot kitchen lives inside eyes-agent" boundary.
- `capture.py` — `screenshot(source=None, methods=None)` →
  `{ok, path?, method, ts, usable, reason?, attempts[]}`. Fallback
  chain: import → scrot → gnome-screenshot → GNOME Shell D-Bus →
  XDG portal → CDP. Every attempted method is recorded with its failure
  reason; **degraded paths report unusable, never fake success**.
- `dialog_watch.py` — `attach()` → `(PageWs|None, error|None)` +
  `poll_event()` (production shape: persistent per-target subscription
  feeding a pull-model buffer), `watch_for_dialog()` →
  `{ok, observation, error}` (sync probe helper; a broken watcher can
  never read as a clean page), `dismiss()` (**MUTATION** — hard-gated
  on `EYES_ALLOW_DISMISS=1`; tests/demos/operator-approved flows only,
  production dismissal stays OS-level via xdotool).
- `detector.py` — `match(image)` → best
  `{class, confidence, template_id, bbox}` above per-exemplar
  `match_threshold` (0.85 default, multi-scale ±25%); `ocr()` stub
  reports `{available:false}` — pytesseract absent, not hard-required.
- `observation.py` — schema + `observe(url_substr, max_age_ms, last)`
  convenience.
- `window_tree.py` — thin aux: X11 top-level window listing via
  `xwininfo`. Sees only X windows (Chrome's dialogs render in-window;
  GNOME dialogs are Wayland surfaces) — geometry evidence and an aux
  for pure-X11 envs, not a dialog detector here.
- `templates/` — exemplar library + `manifest.json`
  (`{id, class, detect, file, source_desc, captured_via, crop_region,
  match_threshold, added}`).

## Observation schema

```json
{
  "ts": 1731500000.0,
  "screenshot_ref": "/tmp/eyes_x.png",
  "capture_method": "cdp",
  "detected_blocker": {
    "class": "err_page",
    "sub_type": null,
    "confidence": 0.97,
    "source": "template",
    "text": null
  },
  "cdp_state": {"reachable": true, "readyState": "complete", "url": "...", "title": "..."},
  "generation": 3
}
```

`detected_blocker` is `null` when nothing matches. `generation` bumps
per `observe()` — a driver holding an older generation knows its view
is stale (anti-staleness). `source` is `cdp_event` for JS dialogs,
`template`/`ocr` for image detections.

## Service shape (next phase)

Pull, not blocking request/reply: the eyes service keeps latest
observation + generation per watched target; the driver asks *"any
observation fresher than T?"* instead of forcing a synchronous
capture. Eyes-agent answers "what is on screen" only — arbitration
(blocker vs hung vs idle) and decisions stay with the driver loop.
Deferred post-MVP: Wayland portal consent UX, streaming feed,
VLM fallback, reaction to arbitrary dialogs.

## Demo

`tools/eyes_probe.py` runs the end-to-end proof on the real dirty Habr
composer: open_tab → attach watcher → make dirty via real OS input →
`Page.reload` → `javascriptDialogOpening {type:'beforeunload'}` →
dismiss → cleanup. Falls back to an injected-`onbeforeunload`
about:blank variant if Habr does not arm, and reports which variant
fired.
