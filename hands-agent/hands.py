#!/usr/bin/env python3
"""OS-level input primitives: human-like mouse (Bezier paths) and typing.

Requires: xdotool (X11). DISPLAY/XAUTHORITY must be set or detected.
All movements include jitter so events look human, not scripted.
"""
import math, os, random, subprocess, time

ENV = dict(os.environ)
ENV["DISPLAY"] = os.environ.get("HANDS_DISPLAY", ":1")
ENV["XAUTHORITY"] = os.environ.get("HANDS_XAUTHORITY", os.path.expanduser("~/.Xauthority"))

def _xd(*args):
    subprocess.run(["xdotool", *[str(a) for a in args]],
                   env=ENV, check=True, capture_output=True)

def mouse_pos():
    out = _xd("getmouselocation").stdout.decode()
    p = dict(t.split("=") for t in out.split())
    return int(p["x"]), int(p["y"])

def _bezier(p0, p1, p2, p3, n):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0]
        y = mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1]
        pts.append((x, y))
    return pts

def move(x, y, duration=None):
    """Move mouse to (x,y) along a Bezier curve with human pacing."""
    x0, y0 = mouse_pos()
    dist = math.hypot(x - x0, y - y0)
    if dist < 2:
        return
    dur = duration if duration is not None else min(1.2, max(0.15, dist / 2500))
    # control points offset perpendicular to the path -> human-ish arc
    mx, my = (x0 + x) / 2, (y0 + y) / 2
    off = random.uniform(-0.25, 0.25) * dist
    dx, dy = y - y0, x - x0
    ln = math.hypot(dx, dy) or 1
    nx, ny = -dy / ln, dx / ln
    p1 = (x0 + (mx - x0) * 0.4 + nx * off, y0 + (my - y0) * 0.4 + ny * off)
    p2 = (mx + (x - mx) * 0.6 + nx * off * 0.5, my + (y - my) * 0.6 + ny * off * 0.5)
    pts = _bezier((x0, y0), p1, p2, (x, y), max(10, int(dur * 60)))
    dt = dur / len(pts)
    for px, py in pts:
        _xd("mousemove", int(px + random.uniform(-0.5, 0.5)),
            int(py + random.uniform(-0.5, 0.5)))
        time.sleep(dt * random.uniform(0.6, 1.4))

def click(x=None, y=None, button=1, pre_delay=(0.05, 0.2)):
    if x is not None:
        move(x, y)
    time.sleep(random.uniform(*pre_delay))
    _xd("click", button)
    time.sleep(random.uniform(0.05, 0.15))

def double_click(x, y):
    move(x, y)
    time.sleep(random.uniform(0.05, 0.15))
    _xd("click", "1", "click", "1")

def type_text(text, wpm_range=(30, 60)):
    """Type with per-char jitter; handles unicode via xdotool type."""
    for ch in text:
        if ch == "\n":
            _xd("key", "Return")
            time.sleep(random.uniform(0.1, 0.3))
            continue
        _xd("type", "--", ch)
        time.sleep(random.uniform(1.0 / wpm_range[1], 1.0 / wpm_range[0]) / 5)
        if random.random() < 0.03:  # occasional human pause
            time.sleep(random.uniform(0.15, 0.45))

def key(*keys):
    _xd("key", *keys)
    time.sleep(random.uniform(0.05, 0.15))

def scroll(amount=3, direction="down"):
    _xd("click", "5" if direction == "down" else "4",
        "--repeat", amount)

def wait_for_image(template_path, timeout=10, confidence=0.85):
    """Poll the screen until template appears; returns (x,y) center or None."""
    from vision import find_on_screen
    deadline = time.time() + timeout
    while time.time() < deadline:
        hit = find_on_screen(template_path, confidence)
        if hit:
            return hit
        time.sleep(0.4)
    return None
