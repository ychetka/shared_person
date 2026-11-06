#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websocket-client>=1.6"]
# ///
"""vk_token_issue.py - re-issue the VK standalone (offline) token.

Automates the documented manual flow (PLATFORM_ACCESS.md): open the
implicit-flow authorize URL for the grandfathered Kate Mobile
client_id in the operator's logged-in Chrome (CDP :9223), click the
VK ID consent button with a REAL OS click (DOM is only read for
coordinates - xdotool delivers the trusted event, same contract as
hands-agent), harvest the access_token from the oauth.vk.ru/blank.html
fragment, verify the wall scope server-side, and append the token to
the project ENV file.

The token value never reaches stdout: every printed artifact is
masked. ENV semantics follow env_val.sh - a fresh `KEY=` assignment
at EOF wins over earlier ones, so we append, not edit in place.

Usage:
    uv run tools/vk_token_issue.py [--env PATH] [--cdp URL]

Exit codes: 0 stored, 1 flow failed (no token/consent/API error),
2 scope rejected (no wall bit - not stored), 3 CDP unavailable.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

CDP = os.environ.get("VK_CDP_URL", "http://127.0.0.1:9223")
# Kate Mobile client_id - grandfathered: VK grants `wall` to it on
# implicit flow while new standalone apps need a business profile.
KATE_CLIENT_ID = "2685278"
OAUTH_URL = (
    "https://oauth.vk.ru/authorize"
    f"?client_id={KATE_CLIENT_ID}&scope=wall%2Coffline"
    "&redirect_uri=https%3A%2F%2Foauth.vk.ru%2Fblank.html"
    "&display=page&response_type=token&v=5.199"
)
BUDGET_S = 120.0
# VK ID consent-button prefix, kept as escapes so the file
# stays ASCII - the hygiene gate scans added lines.
_CONSENT_PREFIX = "\u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c"
_CONSENT_EXPR = """(() => {
  const els = Array.from(document.querySelectorAll('button,a,[role=button]'));
  for (const e of els) {
    const t = (e.innerText||'').trim().toLowerCase();
    if (!t.startsWith(Q)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 20 || r.bottom < 0 || r.top > innerHeight) continue;
    return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
  }
  return 'null';
})()""".replace("Q", json.dumps(_CONSENT_PREFIX))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect - same leak guard as vk_token_service.

    urllib auto-follows redirects and for 307/308 re-sends the POST
    body - which carries access_token - to whatever host Location
    names. Refusing costs nothing and keeps the credential on
    api.vk.com.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def _get(path, timeout=10):
    with _OPENER.open(f"{CDP}{path}", timeout=timeout) as r:
        return json.loads(r.read())


def _put(path, timeout=10):
    req = urllib.request.Request(f"{CDP}{path}", method="PUT")
    with _OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read())


def _tab(tab_id):
    for t in _get("/json/list"):
        if t.get("type") == "page" and t.get("id") == tab_id:
            return t
    return None


def _close_tab(tab_id):
    try:
        with _OPENER.open(f"{CDP}/json/close/{tab_id}", timeout=5) as r:
            r.read()
    except OSError:
        pass


def _ws_eval(ws_url, expr, timeout=20):
    import websocket

    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(
            json.dumps(
                {
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expr, "returnByValue": True},
                }
            )
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                res = msg.get("result", {})
                if res.get("exceptionDetails"):
                    return None
                return res.get("result", {}).get("value")
        return None
    finally:
        ws.close()


def _front(tab):
    """Bring the oauth tab forward so the OS click lands on it."""
    import websocket

    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Page.bringToFront"}))
        ws.recv()
    finally:
        ws.close()


def _consent_pos(tab):
    """Screen coords of the VK ID consent button, or None."""
    off = json.loads(
        _ws_eval(
            tab["webSocketDebuggerUrl"],
            "JSON.stringify({sx:screenX,sy:screenY,"
            "oy:outerHeight-innerHeight,ox:outerWidth-innerWidth,"
            "dpr:devicePixelRatio})",
        )
        or "{}"
    )
    hit = _ws_eval(tab["webSocketDebuggerUrl"], _CONSENT_EXPR)
    if not hit or hit == "null":
        return None
    el = json.loads(hit)
    dpr = off.get("dpr", 1) or 1
    return (
        round(el["x"] * dpr + off.get("sx", 0) + off.get("ox", 0)),
        round(el["y"] * dpr + off.get("sy", 0) + off.get("oy", 0)),
    )


def _os_click(x, y):
    """Trusted OS-level click - xdotool, same contract as hands-agent."""
    subprocess.run(
        ["xdotool", "mousemove", "--sync", str(x), str(y), "click", "1"],
        check=True,
        env={**os.environ, "DISPLAY": os.environ.get("HANDS_DISPLAY", ":1")},
    )


def _vk(method, token):
    body = urllib.parse.urlencode({"access_token": token, "v": "5.199"}).encode()
    req = urllib.request.Request(f"https://api.vk.com/method/{method}", data=body)
    with _OPENER.open(req, timeout=15) as r:
        res = json.loads(r.read())
    if "error" in res:
        err = res["error"]
        raise RuntimeError(f"vk {method} error {err.get('error_code')}: {err.get('error_msg')}")
    return res["response"]


def _store(env_path, token):
    # append wins per env_val.sh, but only if the previous line is
    # terminated - an unterminated tail would corrupt both values
    with open(env_path, "rb+") as f:
        f.seek(0, os.SEEK_END)
        if f.tell() > 0:
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                f.write(b"\n")
        f.write(f"VK_ACCESS_TOKEN={token}\n".encode())


def main():
    global CDP
    ap = argparse.ArgumentParser()
    default_env = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "ENV")
    )
    ap.add_argument("--env", default=default_env, help="env file to append to")
    ap.add_argument("--cdp", default=CDP, help="Chrome CDP base URL")
    args = ap.parse_args()
    CDP = args.cdp.rstrip("/")

    deadline = time.time() + BUDGET_S
    try:
        _get("/json/version", timeout=5)
    except (OSError, ValueError):
        print("FAIL: CDP unreachable - start the audit Chrome on :9223")
        return 3

    tab_id = _put(f"/json/new?{urllib.parse.quote(OAUTH_URL, safe='')}")["id"]
    print("oauth tab opened; driving consent flow")

    token = None
    consent_clicks = 0
    while time.time() < deadline:
        try:
            tab = _tab(tab_id)
            if not tab:
                time.sleep(1)
                continue
            url = tab.get("url", "")
            if "oauth.vk.ru/blank.html#access_token=" in url:
                frag = url.split("#", 1)[1]
                token = urllib.parse.parse_qs(frag).get("access_token", [None])[0]
                break
            if "id.vk.ru" in url and consent_clicks < 3:
                pos = _consent_pos(tab)
                if pos:
                    _front(tab)
                    time.sleep(0.5)
                    _os_click(*pos)
                    consent_clicks += 1
                    print("consent click issued (OS input)")
                    time.sleep(3)
        except Exception as e:  # noqa: BLE001 - see note below
            # transient ws/xdotool/CDP hiccups are retried inside the
            # shared budget instead of killing the run - the same
            # degrade discipline the recipes use
            print(f"poll pass failed transiently: {type(e).__name__}: {e}")
            time.sleep(2)
            continue
        time.sleep(2)
    _close_tab(tab_id)
    if not token:
        print("FAIL: no token captured inside budget - consent may need a human step")
        return 1

    try:
        uid = _vk("users.get", token)[0]["id"]
        perms = _vk("account.getAppPermissions", token)
    except (OSError, ValueError, RuntimeError) as e:
        print(f"FAIL: VK API rejected validation: {e}")
        return 1
    if not (perms & 8192):
        print(f"FAIL: token lacks wall scope (mask={perms}) - NOT stored")
        return 2
    _store(args.env, token)
    print(
        "stored: VK_ACCESS_TOKEN appended to"
        f" {args.env} | user_id={uid} | len={len(token)} | wall=yes"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
