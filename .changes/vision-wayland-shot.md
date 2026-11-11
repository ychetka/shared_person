---
type: fix
scope: hands-agent
user_visible: false
breaking: false
user_summary: "-"
dev_summary: >-
  vision.screenshot() now falls back from ImageMagick `import -window
  root` to gnome-screenshot and then CDP Page.captureScreenshot when
  the X11 capture fails or silently returns a black frame under
  Wayland; a mock-tier tools/check_vision_shot.py covers the chain.
why: >-
  Under the GNOME Wayland session Xwayland denies root-window capture
  (import exits 1, scrot returns black), which killed recipe `shot`
  actions at step 0. The chain keeps X11 sessions unchanged, prefers
  the portal-mediated full-screen capture, and ends on a read-only CDP
  page-viewport shot - sufficient for recipe artifacts and
  browser-surface find_on_screen use, with the page-relative-coords
  caveat documented in the docstrings. If every method fails the
  original import error still propagates (fail closed).
refs: pangram_check.yaml shot step failures on Wayland
---

## Spec impact
-
