#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websocket-client>=1.6"]
# ///
"""vk_token_service.py - VK access-token provider for the n8n publish workflow.

The VK wall.post driver in sp-publish needs a working access token. The
standalone token in ENV expires; the reliable source on this box is the
logged-in VK tab in the operator's Chrome (CDP on 127.0.0.1:9223). The
web session token stored in localStorage has full `wall` scope
(wall.post / wall.getById / wall.delete verified end-to-end).

n8n runs rootless `network_mode: host`, which is really a slirp4netns
namespace: inside the container the real host is 10.0.2.2. This service
binds host loopback:8792 so the Code node calls
http://10.0.2.2:8792/vk-token.

Endpoints:
  GET /health    -> {"ok": true}
  GET /vk-token  -> {"ok": true, "access_token": "...", "source": "cdp",
                     "refreshed_tab": bool}
                  -> {"ok": false, "error": "..."}

Trust assumption: /vk-token serves a full wall-scope token with NO
authentication. The loopback-only bind (127.0.0.1) is the whole trust
boundary - any local process, or anything that ever reaches :8792 via
a port forward, gets a live VK credential. Acceptable on this
single-operator box; do not expose the port beyond loopback.

Flow: find vk.ru/vk.com tabs (hostname match) -> eval localStorage
web_token on each until one yields a token -> verify with users.get ->
on VK error 5 or a failed extraction reload the tabs once and poll
localStorage for the token (no fixed sleep window).

Run:
  uv run tools/vk_token_service.py --serve            # port 8792
  uv run tools/vk_token_service.py --port 8792        # same, explicit
  uv run tools/vk_token_service.py --once             # print token JSON

Env overrides: VK_CDP_URL (default http://127.0.0.1:9223).
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CDP = os.environ.get("VK_CDP_URL", "http://127.0.0.1:9223")
TOKEN_EXPR = (
    "JSON.parse(localStorage.getItem('6287487:web_token:login:auth'))"
    ".access_token"
)
VK_API = "https://api.vk.com/method/{m}?{q}&v=5.199&access_token={t}"


def _targets():
    with urllib.request.urlopen(f"{CDP}/json/list", timeout=10) as r:
        return json.loads(r.read())


def _is_vk_url(url):
    """Hostname match: vk.ru / vk.com and their subdomains only.

    A substring check would also match e.g. `vk.ru.evil.example`."""
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return (
        host in ("vk.ru", "vk.com")
        or host.endswith(".vk.ru")
        or host.endswith(".vk.com")
    )


def find_vk_pages():
    """All open VK tabs - a logged-out first tab must not hide a valid
    session in another one."""
    return [
        t for t in _targets()
        if t.get("type") == "page" and _is_vk_url(t.get("url", ""))
    ]


def ws_eval(ws_url, expr, timeout=30):
    import websocket  # websocket-client, resolved by uv

    ws = websocket.create_connection(ws_url, timeout=timeout,
                                     suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": expr,
                                       "returnByValue": True}}))
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


def extract_token():
    pages = find_vk_pages()
    if not pages:
        return None, "no vk tab in CDP targets"
    for page in pages:
        try:
            tok = ws_eval(page["webSocketDebuggerUrl"], TOKEN_EXPR)
        except Exception:  # noqa: BLE001 - dead tab, try the next one
            continue
        if tok:
            return tok, None
    return None, "token eval returned nothing on all vk tabs"


def reload_vk_tab():
    for page in find_vk_pages():
        ws_eval(page["webSocketDebuggerUrl"], "location.reload(); 'r'")


def reload_and_extract(max_wait=6.0, poll=0.5):
    """Reload the VK tabs once, then poll localStorage for the token.

    A fixed post-reload sleep stalls this (single event loop) request
    handler for the whole window even when localStorage is repopulated
    within a second; polling exits as soon as the token shows up and
    keeps worst-case get_token() latency well under the 60s timeout
    the n8n side uses."""
    reload_vk_tab()
    deadline = time.time() + max_wait
    tok, err = extract_token()
    while not tok and time.time() < deadline:
        time.sleep(poll)
        tok, err = extract_token()
    return tok, err


def vk_check(token):
    """users.get sanity check - returns error_code or None."""
    url = VK_API.format(m="users.get", q="", t=urllib.request.quote(token))
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            body = json.loads(r.read())
    except Exception as e:  # noqa: BLE001 - report, do not crash
        return f"http: {e}"
    err = body.get("error")
    return err.get("error_code") if err else None


def get_token():
    """Return (result_dict). Reloads the VK tabs once when the first
    extraction fails or the token is rejected (VK error 5)."""
    tok, err = extract_token()
    refreshed = False
    if tok:
        code = vk_check(tok)
        if code == 5:
            tok, err = reload_and_extract()
            refreshed = True
            code = vk_check(tok) if tok else "no-token"
        if code:
            return {"ok": False, "error": f"vk check failed: {code}"}
    else:
        # no token at all - try a tab reload once before giving up
        tok, err = reload_and_extract()
        refreshed = True
        if not tok:
            return {"ok": False, "error": err or "no token"}
        code = vk_check(tok)
        if code:
            return {"ok": False, "error": f"vk check failed: {code}"}
    return {"ok": True, "access_token": tok, "source": "cdp",
            "refreshed_tab": refreshed}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - http.server API
        if self.path.startswith("/health"):
            self._send(200, {"ok": True})
        elif self.path.startswith("/vk-token"):
            try:
                res = get_token()
            except Exception as e:  # noqa: BLE001
                res = {"ok": False, "error": str(e)[:300]}
            self._send(200 if res.get("ok") else 502, res)
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def log_message(self, *a):  # quiet
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--port", type=int, default=8792)
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    if args.once:
        print(json.dumps(get_token()))
        return
    # ThreadingHTTPServer: a /vk-token reload+poll window must not stall
    # concurrent /health or other /vk-token callers
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
