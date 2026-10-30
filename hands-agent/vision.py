#!/usr/bin/env python3
"""Computer vision: screenshots + template matching. Zero DOM selectors.

Screenshot via ImageMagick `import` (X11). Matching via OpenCV
multi-scale template match -> returns center coords for xdotool clicks.
Optional vision-model fallback is wired in mcp_server (Gemini), not here.
"""

import os
import subprocess
import tempfile

import cv2

ENV = dict(os.environ)
ENV["DISPLAY"] = os.environ.get("HANDS_DISPLAY", ":1")
ENV["XAUTHORITY"] = os.environ.get("HANDS_XAUTHORITY", os.path.expanduser("~/.Xauthority"))


def screenshot(path=None):
    """Full-screen PNG. Returns file path."""
    if path is None:
        fd, path = tempfile.mkstemp(suffix=".png", prefix="hands_")
        os.close(fd)
    subprocess.run(["import", "-window", "root", path], env=ENV, check=True, capture_output=True)
    return path


def find_on_screen(template_path, confidence=0.85, scales=(1.0, 0.9, 1.1, 0.8, 1.25)):
    """Locate template image on screen. Returns (x, y) center or None."""
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
