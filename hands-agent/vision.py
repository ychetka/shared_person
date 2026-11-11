#!/usr/bin/env python3
"""Computer vision: screenshots + template matching. Zero DOM selectors.

Screenshot via ImageMagick `import` (X11), with a Wayland fallback
chain (gnome-screenshot -> CDP Page.captureScreenshot). Matching via
OpenCV multi-scale template match -> returns center coords for
xdotool clicks. Optional vision-model fallback is wired in mcp_server
(Gemini), not here.
"""

import base64
import os
import shutil
import subprocess
import tempfile

import cv2

ENV = dict(os.environ)
ENV["DISPLAY"] = os.environ.get("HANDS_DISPLAY", ":1")
ENV["XAUTHORITY"] = os.environ.get("HANDS_XAUTHORITY", os.path.expanduser("~/.Xauthority"))

# mean gray level below which a capture counts as "black" - Xwayland
# under Wayland can return exit 0 with an all-black frame. A legit dark
# fullscreen (dark terminal/video) can false-positive this check and
# trigger the fallback chain unnecessarily; acceptable here since
# hands-agent shots target browser content
_BLACK_MEAN = 5


def _is_black(path):
    img = cv2.imread(path, 0)
    return img is None or img.mean() < _BLACK_MEAN


def _gnome_screenshot(path):
    """gnome-screenshot goes through the Wayland portal - it may pop a
    one-time permission dialog on first use."""
    exe = shutil.which("gnome-screenshot")
    if not exe:
        return False
    try:
        subprocess.run([exe, "-f", path], check=True, capture_output=True, timeout=15)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # a pending portal permission dialog must not wedge the chain -
        # treat a timeout like a failure and let CDP take over
        return False
    return not _is_black(path)


def _cdp_screenshot(path):
    """Page-level shot via CDP Page.captureScreenshot on the first
    page target - read-only inspection per project policy, never an
    action. /json/list exposes no visibility flag, so 'first page
    target' is the closest available proxy for the visible tab."""
    try:
        # lazy import inside the try - an ImportError must advance the
        # fail-closed chain like any other CDP failure, not escape it
        import cdp

        pages = [t for t in cdp.targets() if t.get("type") == "page"]
        if not pages:
            return False
        r = cdp._call(pages[0]["webSocketDebuggerUrl"], "Page.captureScreenshot", {"format": "png"})
        data = r.get("result", {}).get("data")
        if not data:
            return False
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
    except Exception:  # noqa: BLE001 - any CDP/network failure just advances the chain
        return False
    return not _is_black(path)


def screenshot(path=None):
    """PNG capture, best available surface. Returns file path.

    Primary: `import -window root` (full screen; X11 and Xwayland
    sessions where root capture is permitted). Under GNOME Wayland the
    Xwayland root window denies capture, so on a non-zero exit OR an
    effectively black frame the chain falls back to:
      1. gnome-screenshot (portal-mediated full screen, may prompt
         once for permission);
      2. CDP Page.captureScreenshot - a PAGE-VIEWPORT shot, not the
         screen. Sufficient for recipe artifacts and browser-surface
         find_on_screen() use, but template coords matched on such a
         shot are page-relative, NOT screen coords - callers must not
         feed them to xdotool blindly.
    If every method fails the original `import` error is re-raised
    (fail closed)."""
    if path is None:
        fd, path = tempfile.mkstemp(suffix=".png", prefix="hands_")
        os.close(fd)
    import_err = None
    try:
        subprocess.run(
            ["import", "-window", "root", path], env=ENV, check=True, capture_output=True
        )
    except subprocess.CalledProcessError as e:
        import_err = e
    else:
        # exit 0 is not proof under Wayland - Xwayland can silently
        # hand back an all-black frame
        if not _is_black(path):
            return path
    if _gnome_screenshot(path) or _cdp_screenshot(path):
        return path
    if import_err is not None:
        raise import_err
    raise RuntimeError(f"screenshot: black frame from import, all fallbacks failed ({path})")


def find_on_screen(template_path, confidence=0.85, scales=(1.0, 0.9, 1.1, 0.8, 1.25)):
    """Locate template image on screen. Returns (x, y) center or None.

    Coords are relative to whatever surface screenshot() captured -
    screen coords for the full-screen paths, PAGE-relative when the
    CDP fallback produced the shot (see screenshot() docstring)."""
    shot = screenshot()
    img = cv2.imread(shot, 0)
    tpl0 = cv2.imread(template_path, 0)
    if img is None or tpl0 is None:
        return None
    best = None
    for s in scales:
        tpl = cv2.resize(tpl0, None, fx=s, fy=s)
        if tpl.shape[0] > img.shape[0] or tpl.shape[1] > img.shape[1]:
            continue
        res = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if mx >= confidence and (best is None or mx > best[0]):
            h, w = tpl.shape
            best = (mx, loc[0] + w // 2, loc[1] + h // 2)
    return (best[1], best[2]) if best else None


def find_text_on_screen(query, hint_regions=None):
    """Placeholder for vision-model OCR/VLM lookup - implemented at MCP layer
    via Gemini screenshot reasoning. Kept as stub for engine API parity."""
    raise NotImplementedError("use mcp tool 'locate' (vision-model) instead")
