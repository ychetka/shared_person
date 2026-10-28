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
  GET /vk-token  -> 200 {"ok": true, "access_token": "...", "source": "cdp",
                         "refreshed_tab": bool}
                  -> 503 {"ok": false, "error": "...", "retryable": true}
                     for transient failures (lock contention, transport
                     errors, deadline hits, CDP unreachable), 502
                     {"ok": false, "error": "..."} for real rejections

Trust assumption: /vk-token serves a full wall-scope token behind two
cheap gates - the loopback-only bind (127.0.0.1) and a shared-secret
header. Callers must send `X-Shared-Token` matching env
VK_TOKEN_SECRET (hmac.compare_digest, 401 otherwise). The check fails
closed when VK_TOKEN_SECRET is unset, so an unconfigured service
hands out nothing. This keeps a stray `ssh -L 8792` forward or a
random local process from turning the port into a live-token oracle;
do not expose the port beyond loopback regardless.

Nuance on the bind: "loopback-only" does NOT restrict callers to host
processes under rootless docker - every sibling container's own
slirp4netns gateway (its own 10.0.2.2) reaches host loopback:8792,
which is exactly how the n8n Code node calls this service. The
X-Shared-Token gate is the real trust boundary; the bind only keeps
the port off the LAN and the host's external interfaces.

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
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import deque
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
# Bounded - the service is long-running and tokens rotate. Eviction
# is incremental FIFO (oldest first), never a full clear() at the cap:
# wiping every entry at once would un-scrub ALL older tokens in one
# step - a still-referenced stale token could then reach the journal
# verbatim. _SECRETS_ORDER tracks insertion order for the eviction.
_SECRETS_CAP = 64
_SECRETS_SEEN = set()
_SECRETS_ORDER = deque()
# Mutations and snapshots both go through this dedicated lock, NOT
# _GET_TOKEN_LOCK: the scrub path in do_GET runs on a handler thread
# while another thread's get_token() holds the big lock for up to
# TOTAL_BUDGET, and a snapshot that queued on it would stall the error
# response for the whole run. _remember_secret is only called inside
# _GET_TOKEN_LOCK anyway, so the small lock adds no contention.
_SECRETS_LOCK = threading.Lock()
# minimum value length _scrub/_remember_secret act on - see _scrub
_MIN_SCRUB_LEN = 8


def _remember_secret(value):
    # same length floor as _scrub: a sub-8-char value is never masked
    # anyway, and a real VK token is far longer - skip it here so it
    # cannot occupy an eviction slot
    if not value or len(str(value)) < _MIN_SCRUB_LEN:
        return
    with _SECRETS_LOCK:
        s = str(value)
        if s in _SECRETS_SEEN:
            return
        _SECRETS_SEEN.add(s)
        _SECRETS_ORDER.append(s)
        while len(_SECRETS_ORDER) > _SECRETS_CAP:
            _SECRETS_SEEN.discard(_SECRETS_ORDER.popleft())


def _secrets_snapshot():
    """Tuple copy of _SECRETS_SEEN under its lock. Iterating the live
    set (list()/tuple() at the call site) races _remember_secret
    mutations on the request thread holding _GET_TOKEN_LOCK and can
    raise RuntimeError 'Set changed size during iteration', killing
    the handler mid-response."""
    with _SECRETS_LOCK:
        return tuple(_SECRETS_SEEN)


def _log(msg):
    """stderr line - the systemd unit runs this daemonized, so
    journald only sees what lands on stderr/stdout. --once keeps
    stdout clean for the JSON result, so everything goes to stderr.

    Every line passes through _scrub with the shared secret plus a
    locked snapshot of every token this process has seen - the same
    masking the HTTP error bodies get. The invariant is 'journald
    never stores a live wall-scope credential': websocket/urllib
    exception text can echo args or response payloads (the
    Runtime.evaluate response carries the raw token), so scrubbing
    at the sink covers every _log call site, present and future,
    instead of relying on each caller to scrub first."""
    sys.stderr.write(
        f"{time.strftime('%Y-%m-%dT%H:%M:%S')} vk_token_service: "
        f"{_scrub(msg, SECRET, *_secrets_snapshot())}\n")
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

    `max_wait` is the ceiling for the poll window AFTER
    location.reload(): a real VK tab reload (web app boot, auth
    handshake, localStorage write) can legitimately take well over 6s
    on a loaded machine, and reporting 'token did not rotate' while the
    fresh token is still in flight fails the publish tick even though
    the reload worked. The window is clamped to the shared `deadline`
    (and each poll round splits it across the tabs), so the reload path
    can never push get_token() past TOTAL_BUDGET."""
    # bound the reload phase itself: by the shared get_token()
    # deadline when there is one, else by max_wait so an unbounded
    # call cannot hang on many slow tabs
    reload_vk_tab(deadline=deadline if deadline is not None
                  else time.time() + max_wait)
    # start the poll window only AFTER the reload returns: max_wait is
    # the ceiling for the post-reload observation window, so a slow
    # reload (several tabs at up to ~8s each) must not consume it -
    # the poll would otherwise get almost no time to observe the
    # rotated token and report a false 'token did not rotate'
    if deadline is not None:
        max_wait = min(max_wait, _remaining(deadline))
    poll_deadline = time.time() + max_wait
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
    """users.get sanity check - returns error_code, None, or a
    {'transport': ...} marker.

    The access token travels in the POST body (form-encoded), matching
    the n8n-side vkCall - never in the request URL, which transport
    errors and logs can echo back. `deadline` caps the HTTP timeout by
    the shared get_token() budget.

    A transport failure (timeout, reset, DNS blip) is NOT a token
    rejection: returning a truthy 'http: ...' string used to file it
    under the same non-retryable 502 as a real VK error code, and the
    publish tick then parked the queue item in failed/ until a manual
    re-approve. The dict marker lets _check_result classify it as
    retryable instead - a momentary api.vk.com outage is transient by
    definition."""
    timeout = 15 if deadline is None else min(15, max(0.5,
                                                    _remaining(deadline)))
    body = urllib.parse.urlencode(
        {"v": "5.199", "access_token": token}).encode()
    req = urllib.request.Request(VK_API.format(m="users.get"), data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
    except Exception as e:  # noqa: BLE001 - report, do not crash
        return {"transport": str(e)}
    err = resp.get("error")
    return err.get("error_code") if err else None


def _check_result(code, ctx):
    """Map a vk_check() outcome to a result dict or None.

    None -> None (token accepted). Of the integer VK error codes only
    5 (invalid token) is a genuine token rejection -> a non-retryable
    error. Every other users.get code is a transient VK-side
    condition, not a verdict on the token: 6 too many requests per
    second, 9 flood control, 10 internal server error, 29 rate limit
    reached, 601 too many actions this day. Classifying them all as
    non-retryable made a momentary api.vk.com rate-limit answer 502,
    and the publish tick parked the queue file in failed/ until a
    manual re-approve - a permanent failure for a temporary error.
    Anything but 5 is retryable: /vk-token answers 503 and the file
    comes back next tick. A {'transport': ...} marker is transient
    for the same reason. `ctx` is a log-line suffix telling apart the
    pre- and post-reload checks."""
    if code is None:
        return None
    if isinstance(code, dict):
        _log(f"vk_check transport failure{ctx}: {code['transport']}")
        return {"ok": False,
                "error": "vk check transport failure: " +
                         _scrub(code["transport"],
                                *_secrets_snapshot())[:200],
                "retryable": True}
    _log(f"vk_check failed{ctx}: {code}")
    if code == 5:
        return {"ok": False, "error": "vk check failed: 5 "
                                      "(token rejected)"}
    return {"ok": False, "error": f"vk check failed: {code}",
            "retryable": True}


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
    try:
        tok, err = extract_token(deadline=deadline)
    except Exception as e:  # noqa: BLE001 - CDP unreachable etc
        # a dead Chrome/CDP port is transient (the browser restarts,
        # the tab comes back), not a token rejection - retryable so
        # the publish tick requeues instead of filing under failed/
        _log(f"token extract raised: {e}")
        return {"ok": False,
                "error": "token extract failed: " +
                         _scrub(e, *_secrets_snapshot())[:200],
                "retryable": True}
    _remember_secret(tok)
    refreshed = False
    if tok:
        code = vk_check(tok, deadline=deadline)
        if code == 5:
            _log("vk_check rejected the token (error 5) - "
                 "reloading vk tabs for a fresh one")
            stale = tok
            try:
                tok, err = reload_and_extract(stale=stale,
                                              deadline=deadline)
            except Exception as e:  # noqa: BLE001 - CDP died mid-reload
                _log(f"token reload raised: {e}")
                return {"ok": False,
                        "error": "token reload failed: " +
                                 _scrub(e, stale,
                                        *_secrets_snapshot())[:200],
                        "retryable": True}
            _remember_secret(tok)
            refreshed = True
            if not tok:
                # reload path produced nothing - surface the real
                # reason from reload_and_extract (deadline hit, token
                # did not rotate, ...) instead of a generic
                # 'vk check failed: no-token' that makes a
                # token-service outage look like a VK-side rejection.
                # Scrub first: exception text may echo the stale token.
                # retryable: a deadline hit or a slow reload is
                # transient - the tick requeues for the next run.
                reason = _scrub(err, stale) if err else \
                    "no token after tab reload"
                _log(f"no token after tab reload: {reason}")
                return {"ok": False, "error": reason,
                        "retryable": True}
            code = vk_check(tok, deadline=deadline)
        bad = _check_result(code, "")
        if bad:
            return bad
    else:
        # no token at all - try a tab reload once before giving up
        _log(f"token extract failed ({err}) - reloading vk tabs once")
        try:
            tok, err = reload_and_extract(deadline=deadline)
        except Exception as e:  # noqa: BLE001 - CDP died mid-reload
            _log(f"token reload raised: {e}")
            return {"ok": False,
                    "error": "token reload failed: " +
                             _scrub(e, *_secrets_snapshot())[:200],
                    "retryable": True}
        _remember_secret(tok)
        refreshed = True
        if not tok:
            # every extraction path failed - deadline hit, no VK tab,
            # token did not rotate. All are environmental/transient,
            # not a token rejection: retryable so the tick requeues.
            _log(f"no token after tab reload: {err}")
            return {"ok": False, "error": err or "no token",
                    "retryable": True}
        bad = _check_result(vk_check(tok, deadline=deadline),
                            " after reload")
        if bad:
            return bad
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
        except (socket.timeout, TimeoutError, ConnectionError,
                ssl.SSLError):
            # routine-disconnect outcomes, all ending the same way -
            # the connection is dead, so close it quietly:
            # - socket.timeout/TimeoutError: a stalled client hit the
            #   15s read cap
            # - ConnectionError (reset/broken pipe/aborted): a loopback
            #   client died mid-request or closed before the response
            #   body landed in _send
            # - ssl.SSLError: TLS noise against a plain-HTTP port, and
            #   belt-and-braces if a TLS wrapper ever fronts this
            # The default socketserver handle_error would dump a full
            # traceback to journald for each of these. Non-disconnect
            # errors still reach handle_error with their traceback.
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
                # an unclassified exception is never a classified VK
                # rejection - every deliberate non-retryable answer is
                # built in _check_result, so whatever escapes here is
                # an unexpected/environmental failure. A flat
                # non-retryable 502 would make the publish tick park
                # the queue file in failed/ permanently over a
                # transient edge; retryable answers 503 and the file
                # comes back next tick
                res = {"ok": False, "error": str(e),
                       "retryable": True}
            # scrub every error surface before the journal or the HTTP
            # body sees it: exception text (the catch-all above) and
            # upstream error strings can echo a live token or the
            # shared secret
            if res.get("error"):
                # locked snapshot: an in-flight get_token() on another
                # request thread mutates _SECRETS_SEEN via
                # _remember_secret while this handler thread is outside
                # _GET_TOKEN_LOCK - iterating the live set could raise
                # RuntimeError and kill the connection
                res["error"] = _scrub(
                    res["error"], SECRET, *_secrets_snapshot())[:300]
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
            # 503 (not a flat 502) for retryable results: get_token()
            # answers {"ok": False, "retryable": True} on lock
            # contention ('busy - another token request in flight',
            # e.g. two overlapping publish ticks refreshing on the
            # same stale cached token). sp-publish's Publish Tick
            # treats a busy answer as transient and returns the queue
            # file to the root for the next tick - a momentary overlap
            # must not permanently fail a publish into failed/.
            self._send(200 if res.get("ok")
                       else 503 if res.get("retryable") else 502, res)
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def log_message(self, fmt, *args):
        # the unit daemonizes the process - journald picks up stderr,
        # so route BaseHTTPRequestHandler's request/response lines
        # (send_response -> log_request -> log_message) there instead
        # of dropping them
        _log(f"{self.address_string()} {fmt % args}")


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with a bound on concurrent connections.

    The stock server is unbounded thread-per-connection: every
    accepted socket spawns a worker, so a local process flooding the
    loopback port (the shared-secret gate only rejects AFTER accept,
    and the 15s socket cap still leaves a window) could exhaust the
    process's thread budget. Cap concurrent handlers with a
    semaphore - extra connections wait at accept() until a slot frees
    - and mark workers daemon so a wedged handler can never block
    shutdown.

    /health never starves behind a full semaphore: _conn_sem is
    acquired on the accept thread, so blocking on it also stalls every
    connection still queued in the listen backlog - while all slots
    are held by /vk-token callers (each can wait up to TOTAL_BUDGET on
    _GET_TOKEN_LOCK), a liveness probe would not even be accepted, and
    a busy token window would make a live service look dead. Under
    contention process_request() peeks the request line and answers
    `GET /health` inline on the accept thread - a fixed trivial
    response, no worker slot, no queue. Identified non-health
    overflow gets a 503 'busy' refusal instead of an unbounded queue;
    Handler's do_GET stays the fallback for anything the peek could
    not confirm (e.g. a request line split across packets)."""

    daemon_threads = True
    max_workers = 8
    # MSG_PEEK budget for a contended connection - long enough for a
    # loopback client to have its request line delivered, short enough
    # that a connect-and-stall pattern cannot pin the accept thread
    # under load. Only contended connections pay it; with a free
    # worker slot nothing is peeked at all.
    _PEEK_TIMEOUT = 1.0
    _HEALTH_BODY = b'{"ok": true}'
    _BUSY_BODY = (b'{"ok": false, "error": "server busy", '
                  b'"retryable": true}')
    _HEALTH_RESP = (
        b"HTTP/1.0 200 OK\r\n"
        b"Content-Type: application/json\r\n"
        b"Content-Length: " + str(len(_HEALTH_BODY)).encode() + b"\r\n"
        b"Connection: close\r\n\r\n" + _HEALTH_BODY)
    _BUSY_RESP = (
        b"HTTP/1.0 503 Service Unavailable\r\n"
        b"Content-Type: application/json\r\n"
        b"Content-Length: " + str(len(_BUSY_BODY)).encode() + b"\r\n"
        b"Connection: close\r\n\r\n" + _BUSY_BODY)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._conn_sem = threading.BoundedSemaphore(self.max_workers)

    def _serve_overflow(self, request):
        """Handle a connection accepted with no free worker slot.

        Peek the request line: a confirmed `GET /health` is answered
        inline - the liveness surface must respond during a busy token
        window or a live service gets restarted mid-burst. Any other
        identified request gets a bounded 503 'server busy' - a clean
        refusal the n8n caller classifies as retryable, instead of a
        silent reset or an unbounded backlog queue. A request the peek
        cannot identify (nothing readable within _PEEK_TIMEOUT) is
        closed without an answer: under contention only identifiable
        traffic is served. No journal line for the health answer - a
        liveness probe's only audience is the checker, and logging
        every probe would spam journald."""
        head = b""
        try:
            prev = request.gettimeout()
            request.settimeout(self._PEEK_TIMEOUT)
            try:
                head = request.recv(512, socket.MSG_PEEK)
            finally:
                request.settimeout(prev)
        except OSError:
            head = b""
        resp = None
        parts = head.split(b"\r\n", 1)[0].split(b" ")
        if len(parts) >= 2 and parts[1].startswith(b"/"):
            try:
                # same query-stripping as do_GET, so /health?x also
                # qualifies for the inline answer
                path = urllib.parse.urlsplit(
                    parts[1].decode("latin-1")).path
            except ValueError:
                path = ""
            if parts[0] == b"GET" and path == "/health":
                resp = self._HEALTH_RESP
            else:
                resp = self._BUSY_RESP
        if resp is not None:
            try:
                request.settimeout(self._PEEK_TIMEOUT)
                request.sendall(resp)
            except OSError:
                pass  # dead peer - close anyway
        # the framework only shutdown_request()s connections it routed
        # to a worker - an overflow-handled socket is ours to close
        self.shutdown_request(request)

    def process_request(self, request, client_address):
        # fast path first: with a free worker slot the connection goes
        # straight to a thread, no peek, no delay - acquire BEFORE
        # spawning so a full semaphore cannot leak a thread per
        # pending socket. The acquire is NON-blocking: blocking here
        # would pin the accept thread and strand every queued
        # connection (including liveness probes) behind the caller
        # holding the last slot - the exact starvation this server
        # exists to avoid. Contended connections are triaged by
        # _serve_overflow instead.
        if self._conn_sem.acquire(blocking=False):
            try:
                super().process_request(request, client_address)
            except Exception:
                self._conn_sem.release()
                raise
            return
        self._serve_overflow(request)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._conn_sem.release()


def _mask(token):
    """Mask a token for stdout - --once output lands in terminal
    scrollback and CI logs, so the raw credential stays hidden.
    Mask unconditionally: a short/malformed value returned verbatim
    would echo a live credential to journald. Under 8 chars nothing
    is shown; longer values get only the first-4 prefix - the journal
    never holds a live credential, and a 'first4***last4' slice still
    hands an attacker 8 real chars of the secret plus a checksum hint
    for the middle."""
    t = str(token)
    if len(t) < 8:
        return "***"
    return t[:4] + "***"


def _scrub(msg, *secrets):
    """Strip known secret values out of an error string before it
    reaches an HTTP response body or the journal.

    Values under _MIN_SCRUB_LEN are skipped: a short secret matches
    common substrings and would shred unrelated words out of the
    message (over-masking), while a real token is far longer."""
    s = str(msg)
    for sec in secrets:
        if sec and len(str(sec)) >= _MIN_SCRUB_LEN:
            # "***".join(split): str.split returns a list, so the
            # previous s.split(sec).join order raised AttributeError
            # on every non-empty secret
            s = "***".join(s.split(str(sec)))
    return s


def _selftest():
    """Offline unit checks for the pure helpers - no Chrome/CDP, no
    VK API, no socket. Run: vk_token_service.py --selftest.

    These protect the 'journald never stores a live credential'
    invariant: _mask/_scrub/_check_result sit on every error surface,
    so a regression there leaks a wall-scope token to journald or an
    HTTP body. _authorized's compare_digest gate is covered too (the
    fake-handler call exercises the real code path with a stubbed
    self)."""
    global SECRET  # patched below to exercise _authorized both ways
    failures = []

    def check(name, cond):
        if cond:
            print(f"PASS {name}")
        else:
            failures.append(name)
            print(f"FAIL {name}")

    tok = "vk1.a." + "t" * 60
    check("_mask short -> ***", _mask("abc") == "***")
    check("_mask none -> ***", _mask(None) == "***")
    masked = _mask(tok)
    check("_mask long prefix-only",
          masked == tok[:4] + "***" and tok[4:] not in masked)
    s = _scrub(f"err {tok} mid {tok} end", tok)
    check("_scrub masks every occurrence",
          tok not in s and s.count("***") == 2)
    check("_scrub sub-8-char secret skipped",
          _scrub("a b c", "b") == "a b c")
    check("_scrub empty/None secrets ignored",
          _scrub("plain", None, "") == "plain")
    check("_scrub non-str msg", _scrub(12345, tok) == "12345")
    check("_check_result None -> accept",
          _check_result(None, "") is None)
    r5 = _check_result(5, "")
    check("_check_result 5 -> terminal",
          r5 is not None and r5.get("ok") is False and
          "retryable" not in r5)
    r6 = _check_result(6, "")
    check("_check_result non-5 -> retryable",
          r6 is not None and r6.get("retryable") is True)
    # transport-error masking goes through the secrets registry, not
    # the value under check - _get_token() always _remember_secret's
    # the token before vk_check, so register it the same way here
    _remember_secret(tok)
    rt = _check_result({"transport": f"reset by peer {tok}"}, "")
    check("_check_result transport -> retryable",
          rt is not None and rt.get("retryable") is True)
    check("_check_result transport scrubbed",
          rt is not None and tok not in rt.get("error", ""))
    check("_is_vk_url vk hosts",
          _is_vk_url("https://vk.ru/feed") and
          _is_vk_url("https://m.vk.com/x") and
          not _is_vk_url("https://vk.ru.evil.example/") and
          not _is_vk_url("https://example.com/") and
          not _is_vk_url("not a url"))
    # _authorized's shared-secret gate: stub `self` with a headers
    # dict, patch the module SECRET - the real code path runs.
    import types
    saved = SECRET
    try:
        SECRET = "selftest-shared-secret"
        good = types.SimpleNamespace(
            headers={"X-Shared-Token": "selftest-shared-secret"})
        bad = types.SimpleNamespace(
            headers={"X-Shared-Token": "wrong"})
        none_hdr = types.SimpleNamespace(headers={})
        check("_authorized valid secret",
              Handler._authorized(good) is True)
        check("_authorized wrong secret",
              Handler._authorized(bad) is False)
        check("_authorized missing header",
              Handler._authorized(none_hdr) is False)
        SECRET = ""
        check("_authorized fails closed on empty SECRET",
              Handler._authorized(good) is False)
    finally:
        SECRET = saved
    if failures:
        print(f"selftest: {len(failures)} failure(s): "
              + ", ".join(failures))
        return 1
    print("selftest: all checks passed")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8792)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--selftest", action="store_true",
                    help="run offline unit checks for the pure "
                         "helpers (_mask/_scrub/_check_result/"
                         "_is_vk_url/_authorized) and exit")
    ap.add_argument("--show-token", action="store_true",
                    help="print the raw access_token with --once "
                         "(default: masked)")
    args = ap.parse_args()
    if args.selftest:
        sys.exit(_selftest())
    if args.once:
        try:
            res = get_token()
        except Exception as e:  # noqa: BLE001 - mirrors the HTTP path
            res = {"ok": False, "error": str(e)}
        # same scrub as do_GET - --once output lands in terminal
        # scrollback and CI logs. Locked snapshot like the HTTP path
        # (here the run is single-threaded, but the shapes stay
        # identical so a future shared call site stays safe)
        if res.get("error"):
            res["error"] = _scrub(res["error"], SECRET,
                                  *_secrets_snapshot())[:300]
        if not args.show_token and res.get("access_token"):
            res["access_token"] = _mask(res["access_token"])
        print(json.dumps(res))
        # scripted callers (health checks, the documented cache-warm
        # run) read the exit code, not the JSON body - a failed
        # get_token() must exit nonzero or {"ok": false} still looks
        # like success to them
        sys.exit(0 if res.get("ok") else 1)
    # BoundedThreadingHTTPServer: a /vk-token reload+poll window must
    # not stall concurrent /health or other /vk-token callers, but the
    # thread count stays capped so a loopback connection flood cannot
    # exhaust the process
    _log(f"serving on 127.0.0.1:{args.port} cdp={CDP} "
         f"shared_secret={'set' if SECRET else 'MISSING - /vk-token fails closed'}")
    BoundedThreadingHTTPServer(("127.0.0.1", args.port),
                               Handler).serve_forever()


if __name__ == "__main__":
    main()
