#!/usr/bin/env python3
"""CDP client: read-only DOM targeting for click precision.

Reads element positions via Chrome DevTools Protocol (getBoundingClientRect)
and converts page coords to screen coords for real OS clicks.
Everything except js_click only READS the DOM - no events injected into
the page, so sites see nothing; the physical click comes from xdotool
(trusted input). js_click is the escape hatch for React surfaces that
ignore OS/synthetic clicks entirely: it calls el.click() inside
Runtime.evaluate.

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


def _chrome_offset(ws_url):
    """Browser chrome height: page-y -> screen-y offset."""
    return eval_js(
        ws_url,
        "JSON.stringify({"
        "sx:window.screenX, sy:window.screenY, "
        "oy:window.outerHeight-window.innerHeight, "
        "ox:window.outerWidth-window.innerWidth, "
        "dpr:window.devicePixelRatio"
        "})",
    )


# Shared DOM candidate-scan template (PR #87 review): every DOM
# targeting helper below is this scan plus a tail. Candidates = the
# __SELECTOR__ set, scored on visible innerText / aria-label /
# placeholder - EXACT match outranks substring, the SMALLEST
# on-screen area wins, so a broad container holding the text never
# beats the element itself. The scan ends at `hit` (winning
# {el,x,y,a,ex,tag,t} or null); the injected __TAIL__ decides what to
# do with it (rect coords / el.click() / text+href read).
_SEL_CLICK = (
    "button,a,[role=button],input,textarea,[contenteditable=true],[role=textbox],div[tabindex]"
)
# wider text-bearing set for read probes - 'words scanned'/'Overview'
# style markers live in plain divs/spans, not interactive elements
_SEL_TEXT = "a,button,[role=button],h1,h2,h3,h4,span,li,div"

_CAND_SCAN = """(() => {
  const q = __QUERY__.toLowerCase();
  const els = Array.from(document.querySelectorAll('__SELECTOR__'));
  const cand = (e) => {
    const it = (e.innerText||'').trim().toLowerCase();
    const al = (e.getAttribute('aria-label')||'').trim().toLowerCase();
    const ph = (e.placeholder||'').trim().toLowerCase();
    const exact = (it === q || al === q || ph === q);
    const sub = !exact && ((it + ' ' + al + ' ' + ph).includes(q));
    if (!exact && !sub) return null;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    if (r.bottom < 0 || r.top > innerHeight) return null;
    return {
      el: e, x: r.x + r.width/2, y: r.y + r.height/2,
      a: r.width*r.height, ex: exact, tag: e.tagName,
      t: (e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,300)
    };
  };
  let best = null, bestEx = null;
  for (const e of els) {
    const c = cand(e);
    if (!c) continue;
    if (c.ex) { if (!bestEx || c.a < bestEx.a) bestEx = c; }
    else if (!best || c.a < best.a) best = c;
  }
  const hit = bestEx || best;
__TAIL__
})()"""


def _scan_expr(selector, tail, query):
    """Fill the shared candidate-scan template. __QUERY__ is replaced
    LAST so an injected query string can never collide with the
    selector/tail placeholders."""
    return (
        _CAND_SCAN.replace("__SELECTOR__", selector)
        .replace("__TAIL__", tail)
        .replace("__QUERY__", json.dumps(query))
    )


def dom_rect(url_substr, query):
    """Find element by visible text/aria-label/placeholder (not CSS needed).
    query = substring of element's text or aria-label.
    Returns {x,y} in SCREEN coords (center of element) or None."""
    t = find_page(url_substr)
    if not t:
        return None
    ws = t["webSocketDebuggerUrl"]
    off = json.loads(_chrome_offset(ws))
    raw = eval_js(
        ws,
        _scan_expr(
            _SEL_CLICK,
            "  return hit ? JSON.stringify({x: hit.x, y: hit.y, "
            "tag: hit.tag, t: hit.t.slice(0,60)}) : 'null';",
            query,
        ),
    )
    if not raw or raw == "null":
        return None
    el = json.loads(raw)
    if not isinstance(el, dict):
        return None
    dpr = off.get("dpr", 1) or 1
    return {
        "x": round(el["x"] * dpr + off["sx"] + off["ox"]),
        "y": round(el["y"] * dpr + off["sy"] + off["oy"]),
        "found": el["t"],
        "tag": el["tag"],
    }


def click_dom(url_substr, query):
    """Locate by DOM text -> real OS click at screen coords."""
    import hands

    pos = dom_rect(url_substr, query)
    if not pos:
        return {"error": f"element not found: {query}"}
    hands.click(pos["x"], pos["y"])
    return {"ok": True, "clicked": pos}


def js_click(url_substr, query):
    """Same element resolution as dom_rect (innerText/aria-label/
    placeholder exact > contains, smallest area wins), but the click is
    el.click() inside Runtime.evaluate - NO OS input at all. For React
    surfaces whose handlers ignore trusted-looking synthetic clicks
    (issue #86: Pangram's 'Check for AI' only submits on el.click()).
    Returns {ok, clicked:{found,tag}} or {error} like click_dom."""
    t = find_page(url_substr)
    if not t:
        return {"error": f"no tab matching: {url_substr}"}
    ws = t["webSocketDebuggerUrl"]
    expr = _scan_expr(
        _SEL_CLICK,
        "  if (!hit) return 'null';\n"
        "  hit.el.click();\n"
        "  return JSON.stringify({tag: hit.tag, t: hit.t.slice(0,60)});",
        query,
    )
    raw = eval_js(ws, expr)
    if not raw or raw == "null":
        return {"error": f"element not found: {query}"}
    el = json.loads(raw)
    if not isinstance(el, dict):
        return {"error": f"element not found: {query}"}
    return {"ok": True, "clicked": {"found": el["t"], "tag": el["tag"]}}


def dom_text(url_substr, query=""):
    """Read text out of a tab via eval_js (read-only - nothing is
    injected or clicked). Two modes, both returning a dict or None:

    - query empty: page/location read-back for the tab whose URL
      contains url_substr -> {url, title}. This is the post-publish
      URL read-back the habr result channel needs.
    - query set: the shared candidate scan (_CAND_SCAN) over a wider
      text-bearing selector (_SEL_TEXT - headings/spans/divs, not just
      clickable elements), returning CONTENT instead of coords:
      {text, href, tag} - href resolved through the element's closest
      anchor, which is how the orphan probe recovers the article URL
      from a title match on the publications page.
    """
    t = find_page(url_substr)
    if not t:
        return None
    ws = t["webSocketDebuggerUrl"]
    if not query:
        raw = eval_js(ws, "JSON.stringify({url: location.href, title: document.title})")
        try:
            return json.loads(raw) if raw else None
        except (TypeError, ValueError):
            return None
    expr = _scan_expr(
        _SEL_TEXT,
        "  if (!hit) return 'null';\n"
        "  const a = hit.el.tagName === 'A' ? hit.el : hit.el.closest('a');\n"
        "  return JSON.stringify({text: hit.t, "
        "href: a && a.href ? String(a.href) : '', tag: hit.tag});",
        query,
    )
    raw = eval_js(ws, expr)
    if not raw or raw == "null":
        return None
    try:
        el = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return el if isinstance(el, dict) else None
