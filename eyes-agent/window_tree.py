#!/usr/bin/env python3
"""Thin auxiliary channel: X11 window tree listing.

Honest scope on this box (GNOME Wayland + XWayland): xwininfo/xdotool
on HANDS_DISPLAY see ONLY X windows - Chrome is one of them, and it
renders its JS dialogs IN-WINDOW (no separate X window), while native
GNOME dialogs are Wayland surfaces invisible to the X tree entirely.
So this channel can enumerate browser/app windows and their geometry
but CANNOT detect dialog-class blockers here; it exists as the cheap
aux for environments where native dialogs DO surface as top-level X
windows (pure-X11 sessions, Xfce, etc.) and for geometry evidence in
observations.
"""

import os
import subprocess

ENV = dict(os.environ)
ENV["DISPLAY"] = os.environ.get("HANDS_DISPLAY", ":0")
ENV["XAUTHORITY"] = os.environ.get("HANDS_XAUTHORITY", os.path.expanduser("~/.Xauthority"))


def list_windows():
    """Top-level X windows: [{id, x, y, w, h, title}] via
    `xwininfo -root -children`. Returns [] on any failure (no X
    server, dead cookie) - an aux channel degrades silently rather
    than fail an observation."""
    try:
        r = subprocess.run(
            ["xwininfo", "-root", "-children"],
            env=ENV,
            check=True,
            capture_output=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return []
    wins = []
    for line in r.stdout.decode(errors="replace").splitlines():
        line = line.strip()
        if not line or not line.startswith("0x"):
            continue
        # '0x2000007 "title": ("class" "instance")  1920x1080+0+0  +0+0'
        try:
            wid = line.split()[0]
            title = line.split('"')[1] if '"' in line else ""
            geo = line.split('"')[-1].strip().split()[-2]
            w, rest = geo.split("x")
            h, rest = rest.split("+", 1)
            x, y = rest.split("+")[:2]
            wins.append(
                {"id": wid, "x": int(x), "y": int(y), "w": int(w), "h": int(h), "title": title}
            )
        except (IndexError, ValueError):
            continue  # malformed line - skip, don't fail the listing
    return wins


def suspect_dialogs(min_w=100, min_h=60, max_w=1400, max_h=900):
    """Aux heuristic: small standalone top-level windows that COULD be
    native dialogs. On this box it only ever sees X-wayland windows
    (Chrome's own dialogs render in-window and never appear here) -
    kept for envs where OS dialogs surface as real X windows."""
    return [w for w in list_windows() if min_w <= w["w"] <= max_w and min_h <= w["h"] <= max_h]
