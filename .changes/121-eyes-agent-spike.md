---
type: feat
scope: eyes-agent
user_visible: false
breaking: false
user_summary: "-"
dev_summary: >-
  New self-contained eyes-agent package (blocker observation,
  roadmap PRIORITY-0): honest screenshot fallback chain ending on CDP
  Page.captureScreenshot, a Page.javascriptDialogOpening detector for
  the whole JS-dialog class (alert/confirm/prompt/beforeunload), a
  cv2 template-match library with an err_page exemplar, observation
  schema with generation counter, and a window_tree thin aux.
  tools/eyes_probe.py proves the channel live: a real dirty Habr
  composer fires {type:beforeunload} while the tab reads 'hung'.
why: >-
  A native beforeunload dialog on the dirty Habr composer is
  invisible to DOM/CDP queries and suspends the renderer, so the
  worker misdiagnosed the tab as hung and dropped steps. OS-level
  capture is impossible on this GNOME Wayland host (verified:
  import exit 1, scrot black frame, GNOME Shell AccessDenied, XDG
  portal Response 2), so the honest split is CDP events for JS
  dialogs and templates on CDP shots for in-page blockers. Pull-model
  service and driver integration are the next phase.
refs: issue #121, roadmap PRIORITY-0
---

## Spec impact
-
