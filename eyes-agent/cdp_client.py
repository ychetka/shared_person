#!/usr/bin/env python3
"""Self-contained CDP plumbing for eyes-agent - READ-OBSERVE ONLY.

The CDP read-only directive (issue #127) leaves eyes-agent exactly this
allowed set:
  - /json/list + /json/version HTTP enumeration (targets, find_page)
  - Page.enable + Page.javascriptDialogOpening/Closed event
    subscription on a persistent page socket (PageWs) - the
    corroborating js_dialog channel in dialog_watch
  - Page.captureScreenshot (capture.py page-viewport fallback)
  - Page.handleJavaScriptDialog ONLY through dialog_watch.dismiss,
    hard-gated on EYES_ALLOW_DISMISS=1 (emergency un-wedge path)

REMOVED per the directive (not gated - removed): eval_js /
Runtime.evaluate entirely, and the browser-domain Target.* writers
open_tab/close_tab/activateTab. Tab actuation now lives in
hands-agent/tab_ctl.py as real OS input (ctrl+t / ctrl+shift+tab /
ctrl+9 / ctrl+w). See docs/cdp-write-audit.md.

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


def tab_info(url_substr):
    """Read-only location/title read-back straight from /json/list -
    no websocket, no evaluate. Replaces the removed Runtime.evaluate
    state probe for callers that only need 'where did this tab land'."""
    t = find_page(url_substr)
    if t is None:
        return None
    return {"url": t.get("url"), "title": t.get("title"), "id": t.get("id")}


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
                # re-arm the socket timeout on EVERY recv: poll_event
                # narrows it to the wait remainder, and without this a
                # send_cmd right after a long watch would inherit a
                # near-zero timeout and fail spuriously. Also bounds
                # each recv so the loop can't overshoot the deadline.
                self.ws.settimeout(max(0.1, deadline - time.time()))
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
