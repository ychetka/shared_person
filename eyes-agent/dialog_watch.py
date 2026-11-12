#!/usr/bin/env python3
"""JS-dialog detector for eyes-agent - the PRIMARY channel for blocker
class (d) (native JS dialogs: alert/confirm/prompt/beforeunload).

Why events, not screenshots: Chrome renders its JS dialogs as native
window furniture - OS screenshots cannot see them on this box anyway
(Wayland), and even where they could, template-matching every language
x every dialog variant is fragile. Page.javascriptDialogOpening is
DETERMINISTIC (verified live 2026-11-12 on this host): after
Page.enable, a page alert() fires
  {method: 'Page.javascriptDialogOpening',
   params: {type: 'alert'|'confirm'|'prompt'|'beforeunload',
            message, hasBrowserHandler, url, frameId}}
and Page.javascriptDialogClosed confirms dismissal.

The REAL incident this exists for: a dirty Habr composer
(/ru/sandbox/new/, tiptap, autosaves drafts -> dirty state) prompts a
native beforeunload dialog on ANY navigation/reload of the tab. While
it sits open the renderer is suspended - every CDP call on the page ws
times out and the tab looks 'hung' to the worker. This module turns
'hung' into a typed observation.

PRODUCTION SHAPE (documented, not a toy): the eyes service holds one
PageWs per watched target with Page.enable done once at attach; a
background pump drains poll_event() into an observation buffer keyed
by target. The driver PULLS: 'any js_dialog observation fresher than
T for target X?' - no request/reply blocking, matching the pull-model
service directive. watch_for_dialog() below is the thin sync helper
for probes/tests; it is NOT the service loop.
"""

import time

import cdp_client

# CDP 'type' param values - passed through verbatim as sub_type
_DIALOG_TYPES = ("alert", "confirm", "prompt", "beforeunload")


def _observation(ev):
    """Map a raw javascriptDialogOpening event to an observation dict."""
    p = ev.get("params", {})
    return {
        "class": "js_dialog",
        "sub_type": p.get("type"),
        "confidence": 1.0,  # a CDP event is ground truth, not a match
        "source": "cdp_event",
        "text": p.get("message") or None,
        "url": p.get("url") or None,
        "has_browser_handler": p.get("hasBrowserHandler"),
        "ts": time.time(),
    }


def attach(url_substr=None, target_id=None):
    """Open a PageWs on the given page target and Page.enable it.

    Exactly one of url_substr / target_id selects the target. Returns
    the PageWs (already enabled) or None if no such target exists.
    The caller owns the socket - close() it when done.
    """
    t = None
    for cand in cdp_client.targets():
        if cand.get("type") != "page":
            continue
        if target_id and cand.get("id") == target_id:
            t = cand
            break
        if url_substr and url_substr in cand.get("url", ""):
            t = cand
            break
    if t is None:
        return None
    ws = cdp_client.PageWs(t["webSocketDebuggerUrl"])
    r = ws.send_cmd("Page.enable")
    if r.get("error"):
        ws.close()
        return None
    return ws


def watch_for_dialog(ws_url_or_substr, seconds):
    """Sync helper for probes/tests: watch a page for up to `seconds`
    and return the FIRST dialog observation, or None.

    Accepts either a page webSocketDebuggerUrl or a url substring.
    When given a ws url the caller's Page.enable state is unknown -
    this helper enables Page itself on its own socket in that case,
    so the cleanest use is watch.attach() + poll loop.
    """
    own = None
    if ws_url_or_substr.startswith("ws://"):
        own = cdp_client.PageWs(ws_url_or_substr)
        own.send_cmd("Page.enable")
        ws = own
    else:
        ws = attach(url_substr=ws_url_or_substr)
        if ws is None:
            return None
    try:
        deadline = time.time() + seconds
        while time.time() < deadline:
            ev = ws.poll_event(deadline - time.time())
            if ev is None:
                break
            if ev.get("method") == "Page.javascriptDialogOpening":
                return _observation(ev)
            # javascriptDialogClosed and friends are drained but not
            # returned - the caller asked for the OPENING observation
        return None
    finally:
        if own is not None:
            own.close()


def dismiss_dialog(ws, accept=True):
    """MUTATION - Page.handleJavaScriptDialog ON THE WATCHER SESSION.

    Verified live 2026-11-13: the command only works from a session
    that has Page enabled - a bare one-shot connection gets
    -32602 'No dialog is showing' even while the dialog is visibly
    open. Same-session dismiss returns {} and a javascriptDialogClosed
    {result: <accept>} event follows.

    accept=True acts like pressing OK/leave; False like cancel/stay.
    Per spec, real dialog dismissal in production stays OS-level
    (xdotool) so the user sees a human-like act; this CDP path is for
    tests/demos and the emergency un-wedge case where the renderer is
    already suspended and OS input is the slower route.
    """
    r = ws.send_cmd("Page.handleJavaScriptDialog", {"accept": accept}, timeout=10)
    if r.get("error"):
        return {"error": f"handleJavaScriptDialog: {r['error']}"}
    return {"ok": True, "accepted": accept}


def dismiss(url_substr=None, target_id=None, accept=True):
    """MUTATION - standalone dismiss helper for operator-approved
    flows: attaches its own Page-enabled session and answers the open
    dialog. Prefer dismiss_dialog(ws) when a watcher session already
    exists (it is the session the event arrived on)."""
    ws = attach(url_substr=url_substr, target_id=target_id)
    if ws is None:
        return {"error": "no matching page target"}
    try:
        return dismiss_dialog(ws, accept=accept)
    finally:
        ws.close()
