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

Trust assumption: /vk-token serves a full wall-scope token behind two
cheap gates - the loopback-only bind (127.0.0.1) and a shared-secret
header. Callers must send `X-Shared-Token` matching env
VK_TOKEN_SECRET (hmac.compare_digest, 401 otherwise). The check fails
closed when VK_TOKEN_SECRET is unset, so an unconfigured service
hands out nothing. This keeps a stray `ssh -L 8792` forward or a
random local process from turning the port into a live-token oracle;
do not expose the port beyond loopback regardless.

Flow: find vk.ru/vk.com tabs (hostname match) -> eval localStorage
web_token on each until one yields a token -> verify with users.get ->
on VK error 5 or a failed extraction reload the tabs once and poll
localStorage for the token (no fixed sleep window).

Scope limitation: users.get proves the token is valid, not that it
carries `wall` scope. The localStorage pick order narrows this (the
canonical ':web_token:login:auth' key shape first, then only
web_token keys under the VK web app id 6287487), but a token minted
for another VK app under the canonical key shape would still pass.
A stronger check would need a scope-proving call such as
account.getAppPermissions or a wall.get probe - not implemented yet.

Latency contract: get_token() enforces a GLOBAL deadline (TOTAL_BUDGET,
50s) shared across every tab eval, reload, poll and vk_check call, so
the worst case stays under the 60s timeout the n8n caller uses even
when several VK tabs hang at once. Each ws_eval() gets only its share
of the remaining budget and each recv() is capped by it.

Run:
  uv run tools/vk_token_service.py                    # serve on :8792
  uv run tools/vk_token_service.py --port 8792        # same, explicit
  uv run tools/vk_token_service.py --once             # print masked result
  uv run tools/vk_token_service.py --once --show-token  # raw token JSON

Env overrides: VK_CDP_URL (default http://127.0.0.1:9223),
VK_TOKEN_SECRET (required shared secret for /vk-token).
"""

import argparse
import hmac
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CDP = os.environ.get("VK_CDP_URL", "http://127.0.0.1:9223")
SECRET = os.environ.get("VK_TOKEN_SECRET", "")
# The web-session token lives in localStorage under
# '<app_id>:web_token:login:auth'. VK can rename the key, so do NOT
# hardcode the whole name: enumerate localStorage keys instead.
# Prefer keys that still end in the known ':web_token:login:auth'
# shape, then fall back to any 'web_token' key whose value parses to
# an object carrying access_token - but ONLY when its '<app_id>:'
# prefix is 6287487 (the VK web client app id). vk_check's users.get
# proves a token is live, not that it carries the `wall` scope the
# publisher needs: a web_token minted for a different VK app would
# pass users.get, get cached, and then fail every wall.post at
# publish time. Keys with no '<app_id>:' prefix are skipped for the
# same reason.
TOKEN_EXPR = (
    "(function(){"
    "var ks=Object.keys(localStorage);"
    "var pick=function(pred){"
    "for(var i=0;i<ks.length;i++){if(!pred(ks[i]))continue;"
    "try{var v=JSON.parse(localStorage.getItem(ks[i]));"
    "if(v&&v.access_token)return v.access_token;}catch(e){}}"
    "return null;};"
    "return pick(function(k){return /(^|:)web_token:login:auth$/.test(k);})"
    "||pick(function(k){"
    "var c=k.indexOf(':');"
    "return c!==-1&&k.slice(0,c)==='6287487'"
    "&&k.indexOf('web_token')!==-1;});"
    "})()"
)
VK_API = "https://api.vk.com/method/{m}"
# One get_token() call must never outlast the 60s timeout the n8n
# vkRefresh() uses - the budget is shared across all tabs and retries.
TOTAL_BUDGET = 50.0
# get_token() mutates shared browser state (location.reload on the VK
# tabs) and polls localStorage - two concurrent /vk-token callers under
# ThreadingHTTPServer would trigger overlapping reloads and race each
# other's reads, burning the shared deadline twice. Serialize the whole
# call: /health still answers on other threads, /vk-token callers just
# queue up.
_GET_TOKEN_LOCK = threading.Lock()
# Tokens extracted during a get_token() run can surface inside
# exception text (websocket/urllib errors quote args and response
# bodies), but the do_GET catch-all sits above the locals that hold
# them. Every run registers the tokens it touched here so error
# responses and the journal can be _scrub'd against the live values.
# Bounded - the service is long-running and tokens rotate.
_SECRETS_SEEN = set()


def _remember_secret(value):
    if not value:
        return
    if len(_SECRETS_SEEN) >= 64:
        _SECRETS_SEEN.clear()
    _SECRETS_SEEN.add(str(value))


def _log(msg):
    """stderr line - the systemd unit runs this daemonized, so
    journald only sees what lands on stderr/stdout. --once keeps
    stdout clean for the JSON result, so everything goes to stderr."""
    sys.stderr.write(
        f"{time.strftime('%Y-%m-%dT%H:%M:%S')} vk_token_service: {msg}\n")
    sys.stderr.flush()


def _remaining(deadline):
    """Seconds left on the shared deadline (0 when it has passed)."""
    return max(0.0, deadline - time.time()) if deadline else 0.0


def _share(deadline, n_left, cap):
    """Split what is left across the n_left calls still to run."""
    if deadline is None:
        return cap
    return min(cap, max(0.5, _remaining(deadline) / max(1, n_left)))


def _targets(deadline=None):
    timeout = 10 if deadline is None else min(10, max(0.5,
                                                    _remaining(deadline)))
    with urllib.request.urlopen(f"{CDP}/json/list", timeout=timeout) as r:
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


def find_vk_pages(deadline=None):
    """All open VK tabs - a logged-out first tab must not hide a valid
    session in another one."""
    return [
        t for t in _targets(deadline)
        if t.get("type") == "page" and _is_vk_url(t.get("url", ""))
    ]


def ws_eval(ws_url, expr, timeout=45):
    import websocket  # websocket-client, resolved by uv

    ws = websocket.create_connection(ws_url, timeout=timeout,
                                     suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": expr,
                                       "returnByValue": True}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            # recv() can block for the full socket timeout - pin it to
            # what this call still owns so a hung tab eats only its
            # share of the global budget
            ws.settimeout(max(0.5, deadline - time.time()))
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                res = msg.get("result", {})
                if res.get("exceptionDetails"):
                    return None
                return res.get("result", {}).get("value")
        return None
    finally:
        ws.close()


def extract_token(deadline=None, per_tab_timeout=45):
    """Eval localStorage on each VK tab until a token shows up.

    `deadline` is the shared get_token() deadline: whatever time is
    left is split across the tabs still to try, so N hung tabs cost
    the remaining budget once, not N x per_tab_timeout."""
    try:
        pages = find_vk_pages(deadline)
    except Exception as e:
        # Chrome closed / CDP port down - same propagation as before,
        # but leave the cause in the journal, not just the 502 body
        _log(f"CDP unreachable at {CDP}: {e}")
        raise
    if not pages:
        _log("token extract: no vk tab in CDP targets")
        return None, "no vk tab in CDP targets"
    for i, page in enumerate(pages):
        budget = _share(deadline, len(pages) - i, per_tab_timeout)
        if deadline is not None and _remaining(deadline) <= 0:
            _log("global deadline hit during token extract")
            return None, "global deadline hit during token extract"
        try:
            tok = ws_eval(page["webSocketDebuggerUrl"], TOKEN_EXPR,
                          timeout=budget)
        except Exception as e:  # noqa: BLE001 - dead tab, try the next
            _log(f"token eval failed on tab "
                 f"{str(page.get('url', '?'))[:60]}: {e}")
            continue
        if tok:
            return tok, None
    _log(f"token eval returned nothing on all {len(pages)} vk tabs")
    return None, "token eval returned nothing on all vk tabs"


def reload_vk_tab(deadline=None, per_tab_timeout=8):
    """location.reload() every VK tab. Reload is best-effort and gets a
    short share of the shared deadline - a hung tab must not consume
    the whole budget before the poll loop even starts."""
    pages = find_vk_pages(deadline)
    for i, page in enumerate(pages):
        if deadline is not None and _remaining(deadline) <= 0:
            break
        try:
            ws_eval(page["webSocketDebuggerUrl"], "location.reload(); 'r'",
                    timeout=_share(deadline, len(pages) - i,
                                   per_tab_timeout))
        except Exception:  # noqa: BLE001 - dead tab, reload the rest
            continue
    return pages


def reload_and_extract(stale=None, deadline=None, max_wait=20.0,
                       poll=0.5):
    """Reload the VK tabs once, then poll localStorage for the token.

    `stale` is the token value vk_check just rejected (if any): a poll
    can race the reload and re-read the pre-reload localStorage value,
    which is not a win - keep polling until a DIFFERENT token shows up
    or the budget runs out.

    `max_wait` is the ceiling for the poll window after
    location.reload(): a real VK tab reload (web app boot, auth
    handshake, localStorage write) can legitimately take well over 6s
    on a loaded machine, and reporting 'token did not rotate' while the
    fresh token is still in flight fails the publish tick even though
    the reload worked. The window is clamped to the shared `deadline`
    (and each poll round splits it across the tabs), so the reload path
    can never push get_token() past TOTAL_BUDGET."""
    if deadline is not None:
        max_wait = min(max_wait, _remaining(deadline))
    poll_deadline = time.time() + max_wait
    reload_vk_tab(deadline=poll_deadline)
    if deadline is not None:
        poll_deadline = min(poll_deadline, deadline)
    tok, err = extract_token(deadline=poll_deadline)
    while (not tok or tok == stale) and time.time() < poll_deadline:
        time.sleep(min(poll, max(0.05, poll_deadline - time.time())))
        tok, err = extract_token(deadline=poll_deadline)
    if tok == stale:
        return None, err or "token did not rotate after tab reload"
    return tok, err


def vk_check(token, deadline=None):
    """users.get sanity check - returns error_code or None.

    The access token travels in the POST body (form-encoded), matching
    the n8n-side vkCall - never in the request URL, which transport
    errors and logs can echo back. `deadline` caps the HTTP timeout by
    the shared get_token() budget."""
    timeout = 15 if deadline is None else min(15, max(0.5,
                                                    _remaining(deadline)))
    body = urllib.parse.urlencode(
        {"v": "5.199", "access_token": token}).encode()
    req = urllib.request.Request(VK_API.format(m="users.get"), data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
    except Exception as e:  # noqa: BLE001 - report, do not crash
        return f"http: {e}"
    err = resp.get("error")
    return err.get("error_code") if err else None


def get_token(budget=TOTAL_BUDGET):
    """Return (result_dict). Reloads the VK tabs once when the first
    extraction fails or the token is rejected (VK error 5).

    `budget` is the global deadline for the whole call - every tab
    eval, reload, poll round and vk_check draws from it, so the worst
    case stays under the 60s timeout the n8n caller uses.

    Serialized under _GET_TOKEN_LOCK - see its comment. The lock WAIT
    draws from the same budget too: a second concurrent caller that
    cannot enter inside its own deadline fails fast with a retryable
    'busy' instead of queueing a full run and then burning a second
    budget - two back-to-back runs would blow the caller's 60s."""
    deadline = time.time() + budget
    if not _GET_TOKEN_LOCK.acquire(
            timeout=max(0.0, deadline - time.time())):
        _log("token request busy - another get_token() outlasted "
             "this call's budget")
        return {"ok": False,
                "error": "busy - another token request in flight",
                "retryable": True}
    try:
        # the serialized run gets only what the lock wait left of the
        # global budget - the caller's total wait never exceeds it
        return _get_token(max(0.0, deadline - time.time()))
    finally:
        _GET_TOKEN_LOCK.release()


def _get_token(budget):
    deadline = time.time() + budget
    tok, err = extract_token(deadline=deadline)
    _remember_secret(tok)
    refreshed = False
    if tok:
        code = vk_check(tok, deadline=deadline)
        if code == 5:
            _log("vk_check rejected the token (error 5) - "
                 "reloading vk tabs for a fresh one")
            stale = tok
            tok, err = reload_and_extract(stale=stale, deadline=deadline)
            _remember_secret(tok)
            refreshed = True
            if not tok:
                # reload path produced nothing - surface the real
                # reason from reload_and_extract (deadline hit, token
                # did not rotate, ...) instead of a generic
                # 'vk check failed: no-token' that makes a
                # token-service outage look like a VK-side rejection.
                # Scrub first: exception text may echo the stale token.
                reason = _scrub(err, stale) if err else \
                    "no token after tab reload"
                _log(f"no token after tab reload: {reason}")
                return {"ok": False, "error": reason}
            code = vk_check(tok, deadline=deadline)
        if code:
            _log(f"vk_check failed: {code}")
            return {"ok": False, "error": f"vk check failed: {code}"}
    else:
        # no token at all - try a tab reload once before giving up
        _log(f"token extract failed ({err}) - reloading vk tabs once")
        tok, err = reload_and_extract(deadline=deadline)
        _remember_secret(tok)
        refreshed = True
        if not tok:
            _log(f"no token after tab reload: {err}")
            return {"ok": False, "error": err or "no token"}
        code = vk_check(tok, deadline=deadline)
        if code:
            _log(f"vk_check failed after reload: {code}")
            return {"ok": False, "error": f"vk check failed: {code}"}
    # every path above either returns early on a falsy tok or proceeds
    # with a truthy one - tok is always set at this point
    return {"ok": True, "access_token": tok, "source": "cdp",
            "refreshed_tab": refreshed}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        # ThreadingHTTPServer gives every accepted connection its own
        # thread, but nothing bounded a STALLED one: a client that
        # connects and never finishes the request (a hung retry loop,
        # a half-open socket) sat in rfile.readline() forever, and
        # enough of those would starve the server. Cap socket
        # reads/writes at 15s - far above what a loopback client needs
        # to deliver a one-line GET, and /vk-token's 50s get_token()
        # budget is upstream work (CDP + VK API), not client socket
        # I/O, so it is unaffected.
        self.request.settimeout(15)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (socket.timeout, TimeoutError):
            # a stalled client hit the 15s read cap - close the
            # connection quietly. The default socketserver
            # handle_error would dump a traceback to journald for what
            # is a routine cleanup event.
            self.close_connection = True

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        """Shared-secret gate for /vk-token: the loopback bind alone
        trusts anything that can reach :8792, so callers must prove
        they know VK_TOKEN_SECRET. compare_digest avoids a timing
        side-channel on the prefix match. Fails closed when the env is
        unset - an unconfigured service is a dead service, not an open
        one."""
        hdr = self.headers.get("X-Shared-Token", "")
        if not SECRET:
            return False
        try:
            return hmac.compare_digest(hdr, SECRET)
        except TypeError:
            # non-ASCII bytes in the header make compare_digest raise
            # TypeError - an invalid credential, so fail closed with a
            # clean 401 instead of dropping the connection
            return False

    def do_GET(self):
        # exact path match: startswith would also route
        # /vk-token-anything to the token endpoint; urlsplit strips
        # the query string so /health?x keeps working
        try:
            path = urllib.parse.urlsplit(self.path).path
        except ValueError:
            # a malformed request-target (bad IPv6 literal in an
            # absolute-form URI, stray port text) makes urlsplit raise
            # ValueError - answer 400 instead of dropping the request
            # thread on an unhandled exception
            self._send(400, {"ok": False,
                             "error": "malformed request target"})
            return
        if path == "/health":
            self._send(200, {"ok": True})
        elif path == "/vk-token":
            if not self._authorized():
                self.log_message(
                    "/vk-token -> 401 missing/invalid X-Shared-Token")
                self._send(401, {"ok": False,
                                 "error": "missing or invalid "
                                          "X-Shared-Token header"})
                return
            try:
                res = get_token()
            except Exception as e:  # noqa: BLE001
                res = {"ok": False, "error": str(e)}
            # scrub every error surface before the journal or the HTTP
            # body sees it: exception text (the catch-all above) and
            # upstream error strings can echo a live token or the
            # shared secret
            if res.get("error"):
                res["error"] = _scrub(
                    res["error"], SECRET, *_SECRETS_SEEN)[:300]
            if res.get("ok"):
                # masked token only - the journal must never hold a
                # live wall-scope credential
                self.log_message(
                    "/vk-token -> ok source=%s refreshed_tab=%s "
                    "token=%s", res.get("source"),
                    res.get("refreshed_tab"), _mask(res["access_token"]))
            else:
                self.log_message("/vk-token -> failed: %s",
                                 res.get("error"))
            self._send(200 if res.get("ok") else 502, res)
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def log_message(self, fmt, *args):
        # the unit daemonizes the process - journald picks up stderr,
        # so route BaseHTTPRequestHandler's request/response lines
        # (send_response -> log_request -> log_message) there instead
        # of dropping them
        _log(f"{self.address_string()} {fmt % args}")


def _mask(token):
    """Mask a token for stdout - --once output lands in terminal
    scrollback and CI logs, so the raw credential stays hidden.
    Mask unconditionally: a short/malformed value returned verbatim
    would echo a live credential to journald. Under 8 chars nothing
    is shown; up to ~12 only the first 4 (a trailing 4 there would
    expose nearly the whole value)."""
    t = str(token)
    if len(t) < 8:
        return "***"
    if len(t) < 12:
        return t[:4] + "***"
    return t[:4] + "***" + t[-4:]


def _scrub(msg, *secrets):
    """Strip known secret values out of an error string before it
    reaches an HTTP response body or the journal."""
    s = str(msg)
    for sec in secrets:
        if sec:
            s = s.split(str(sec)).join("***")
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8792)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--show-token", action="store_true",
                    help="print the raw access_token with --once "
                         "(default: masked)")
    args = ap.parse_args()
    if args.once:
        try:
            res = get_token()
        except Exception as e:  # noqa: BLE001 - mirrors the HTTP path
            res = {"ok": False, "error": str(e)}
        # same scrub as do_GET - --once output lands in terminal
        # scrollback and CI logs
        if res.get("error"):
            res["error"] = _scrub(res["error"], SECRET,
                                  *_SECRETS_SEEN)[:300]
        if not args.show_token and res.get("access_token"):
            res["access_token"] = _mask(res["access_token"])
        print(json.dumps(res))
        return
    # ThreadingHTTPServer: a /vk-token reload+poll window must not stall
    # concurrent /health or other /vk-token callers
    _log(f"serving on 127.0.0.1:{args.port} cdp={CDP} "
         f"shared_secret={'set' if SECRET else 'MISSING - /vk-token fails closed'}")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
