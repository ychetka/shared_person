#!/usr/bin/env python3
"""CDP client: READ-OBSERVE ONLY.

Project directive (issue #127): CDP in this contour is read-observe
only. There is no Runtime.evaluate, no Input.*, no Target.*, no
Page.handleJavaScriptDialog, no DOM-driven field filling anywhere in
hands-agent - every page actuation is real OS input via xdotool /
the clipboard holder (hands.py, tab_ctl.py).

What remains here and is legitimately read-only:
  - /json/list target enumeration (targets, find_page) - a plain
    HTTP GET against the debugging endpoint; observes tab URL/title.
  - Page.captureScreenshot via _call (used by vision.py as a
    page-viewport pixel fallback) - pixels out, nothing in.

Everything that previously lived here (eval_js, the _CAND_SCAN DOM
targeting machinery, dom_rect/click_dom/js_click/dom_text) ran on
Runtime.evaluate and is REMOVED, not gated: a gate implies a path
back, and the directive leaves none. See docs/cdp-write-audit.md for
the full inventory and the OS-level replacement for each call.

Requires: websocket-client (python3-websocket).
"""

import json
import os
import time
import urllib.request

import websocket

DEBUG = os.environ.get("HANDS_CDP", "http://127.0.0.1:9223")


def targets():
    return json.loads(urllib.request.urlopen(f"{DEBUG}/json/list", timeout=10).read())


def find_page(substr):
    for t in targets():
        if t["type"] == "page" and substr in t["url"]:
            return t
    return None


def tab_info(url_substr):
    """Read-only page location read-back for the tab whose URL contains
    url_substr -> {url, title} straight from the /json/list endpoint
    (no websocket, no evaluate). This is the post-publish URL read-back
    the habr result channel needs; it replaces the old
    Runtime.evaluate location probe. Returns None when no tab matches.
    """
    t = find_page(url_substr)
    if t is None:
        return None
    return {"url": t.get("url"), "title": t.get("title")}


def _call(ws_url, method, params=None, mid=1):
    ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + 30
    while time.time() < deadline:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            ws.close()
            return msg
    ws.close()
    return {"error": "timeout"}
