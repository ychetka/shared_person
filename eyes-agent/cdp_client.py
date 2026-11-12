#!/usr/bin/env python3
"""Self-contained CDP plumbing for eyes-agent.

Mirrors the hands-agent/cdp.py API shape (targets / find_page / _call /
eval_js) plus the open_tab pattern proven on issue #74 (background
Target.createTarget -> settle -> activateTarget), kept as a private
copy per the boundary rule: all screenshot/CDP kitchen lives INSIDE
eyes-agent so the service carries no import-time dependency on the
hands-agent directory.

Requires: websocket-client (python3-websocket).
"""

import json
import os
import time
import urllib.request

import websocket

DEBUG = os.environ.get("EYES_CDP", os.environ.get("HANDS_CDP", "http://127.0.0.1:9223"))


def targets():
    return json.loads(urllib.request.urlopen(f"{DEBUG}/json/list", timeout=10).read())


def find_page(substr):
    for t in targets():
        if t["type"] == "page" and substr in t["url"]:
            return t
    return None


def _call(ws_url, method, params=None, mid=1, timeout=30):
    """One-shot ws call: connect, send, read until matching id, close.

    Adequate for request/response commands; NOT for event subscription -
    use PageWs for that (a one-shot socket drops events that arrive
    between recv calls and dies with the connection).
    """
    try:
        ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    except Exception as e:  # noqa: BLE001 - an unattachable target is an error result, not a crash
        return {"error": f"connect: {str(e)[:120]}"}
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid:
                return msg
        return {"error": "timeout"}
    except Exception as e:  # noqa: BLE001 - socket timeout/closed = unreachable target (e.g. suspended behind a native dialog)
        return {"error": f"recv: {str(e)[:120]}"}
    finally:
        ws.close()


def eval_js(ws_url, expr):
    r = _call(
        ws_url,
        "Runtime.evaluate",
        {"expression": expr, "returnByValue": True, "awaitPromise": True},
    )
    res = r.get("result", {})
    if res.get("exceptionDetails"):
        raise RuntimeError(
            str(res["exceptionDetails"].get("exception", {}).get("description", "js error"))[:200]
        )
    return res.get("result", {}).get("value")


def _browser_ws_url():
    """Browser-level websocket (NOT a page ws) - the endpoint for
    browser-domain commands like Target.createTarget/activateTarget/
    closeTarget. These answer instantly regardless of renderer health."""
    v = json.loads(urllib.request.urlopen(f"{DEBUG}/json/version", timeout=10).read())
    return v["webSocketDebuggerUrl"]


def open_tab(url, settle_s=45, activate=True):
    """Open a URL in a NEW BACKGROUND tab via CDP, let it settle, then
    bring it to the foreground.

    Why background: a heavy SPA (Habr composer) that INITIALIZES in a
    foreground tab can wedge the renderer on this box (GNOME Wayland +
    Xwayland Chrome, software rendering) - verified live 2026-11-12:
    3/3 background loads reached readyState=complete and stayed
    responsive, 2/2 foreground loads hung permanently. Browser-domain
    commands answer on the browser socket instantly even when no
    renderer is healthy, so the ws timeout is never in play.

    Returns {"ok": True, "target_id": ...} or {"error": ...}."""
    try:
        ws_url = _browser_ws_url()
    except Exception as e:  # noqa: BLE001 - transport/HTTP failure surfaces as a plain error
        return {"error": f"browser ws: {e}"}
    r = _call(ws_url, "Target.createTarget", {"url": url, "newWindow": False, "background": True})
    if r.get("error"):
        return {"error": f"Target.createTarget: {r['error']}"}
    target_id = r.get("result", {}).get("targetId")
    if not target_id:
        return {"error": f"Target.createTarget: no targetId in {r}"}
    # the tab loads while backgrounded - renderer-safe settle window
    time.sleep(settle_s)
    if activate:
        r = _call(ws_url, "Target.activateTarget", {"targetId": target_id})
        if r.get("error"):
            return {"error": f"Target.activateTarget: {r['error']}"}
        # let the now-foregrounded page run its deferred init while healthy
        time.sleep(5)
    return {"ok": True, "target_id": target_id}


def close_tab(target_id):
    """Close a tab by target id (browser-domain command). A dirty page's
    beforeunload prompt can appear here too - callers needing a clean
    close on a possibly-armed page should dismiss first."""
    r = _call(_browser_ws_url(), "Target.closeTarget", {"targetId": target_id})
    if r.get("error"):
        return {"error": f"Target.closeTarget: {r['error']}"}
    return {"ok": True}


def activate_tab(target_id):
    r = _call(_browser_ws_url(), "Target.activateTarget", {"targetId": target_id})
    if r.get("error"):
        return {"error": f"Target.activateTarget: {r['error']}"}
    return {"ok": True}


class PageWs:
    """Persistent page-target websocket for EVENT SUBSCRIPTION.

    The one-shot _call() shape cannot watch events: it closes after the
    first matching reply and races messages arriving between recvs.
    PageWs keeps the socket open, buffers non-command traffic, and is
    the production shape the eyes service will run per watched target
    (pull model: the driver asks 'any observation fresher than T?').
    """

    def __init__(self, ws_url, timeout=30):
        self.url = ws_url
        self.ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
        self._mid = 0
        self.events = []  # buffered CDP events in arrival order

    def send_cmd(self, method, params=None, timeout=30):
        """Send a command and wait for ITS reply, buffering events seen
        on the way (a dialog can open while we wait for Page.enable)."""
        self._mid += 1
        mid = self._mid
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        try:
            while time.time() < deadline:
                msg = json.loads(self.ws.recv())
                if msg.get("id") == mid:
                    return msg
                if "method" in msg:
                    self.events.append(msg)
            return {"error": "timeout"}
        except Exception as e:  # noqa: BLE001 - suspended renderer / dead socket
            return {"error": f"recv: {str(e)[:120]}"}

    def poll_event(self, timeout):
        """Return the next buffered/arriving CDP event dict or None."""
        deadline = time.time() + timeout
        while True:
            if self.events:
                return self.events.pop(0)
            left = deadline - time.time()
            if left <= 0:
                return None
            self.ws.settimeout(left)
            try:
                msg = json.loads(self.ws.recv())
            except Exception:  # noqa: BLE001 - timeout or dead socket both end the wait
                return None
            if "method" in msg:
                self.events.append(msg)

    def close(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001 - teardown must never raise
            pass
