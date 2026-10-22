#!/usr/bin/env python3
"""CDP client: read-only DOM targeting for click precision.

Reads element positions via Chrome DevTools Protocol (getBoundingClientRect)
and converts page coords to screen coords for real OS clicks.
The DOM is only READ - no events injected into the page, so sites see
nothing; the physical click comes from xdotool (trusted input).

Requires: websocket-client (python3-websocket).
"""
import json, os, time, urllib.request
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
    r = _call(ws_url, "Runtime.evaluate",
              {"expression": expr, "returnByValue": True, "awaitPromise": True})
    res = r.get("result", {})
    if res.get("exceptionDetails"):
        raise RuntimeError(str(res["exceptionDetails"].get("exception", {}).get("description", "js error"))[:200])
    return res.get("result", {}).get("value")


def _chrome_offset(ws_url):
    """Browser chrome height: page-y -> screen-y offset."""
    return eval_js(ws_url, "JSON.stringify({sx:window.screenX, sy:window.screenY, oy:window.outerHeight-window.innerHeight, ox:window.outerWidth-window.innerWidth, dpr:window.devicePixelRatio})")


def dom_rect(url_substr, query):
    """Find element by visible text/aria-label/placeholder (not CSS needed).
    query = substring of element's text or aria-label.
    Returns {x,y} in SCREEN coords (center of element) or None."""
    t = find_page(url_substr)
    if not t:
        return None
    ws = t["webSocketDebuggerUrl"]
    off = json.loads(_chrome_offset(ws))
    expr = """(() => {
      const q = %s.toLowerCase();
      const els = Array.from(document.querySelectorAll('button,a,[role=button],input,textarea,[contenteditable=true],[role=textbox],div[tabindex]'));
      let best = null;
      for (const e of els) {
        const txt = ((e.innerText||'') + ' ' + (e.getAttribute('aria-label')||'') + ' ' + (e.placeholder||'')).toLowerCase();
        if (!txt.includes(q)) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.bottom < 0 || r.top > innerHeight) continue;
        const area = r.width * r.height;
        if (!best || area < best.a) best = {x: r.x + r.width/2, y: r.y + r.height/2, a: area, tag: e.tagName, t: (e.innerText||e.getAttribute('aria-label')||'').slice(0,60)};
      }
      return best ? JSON.stringify(best) : 'null';
    })()""" % json.dumps(query)
    raw = eval_js(ws, expr)
    if not raw:
        return None
    el = json.loads(raw)
    dpr = off.get("dpr", 1) or 1
    return {"x": round(el["x"] * dpr + off["sx"] + off["ox"]),
            "y": round(el["y"] * dpr + off["sy"] + off["oy"]),
            "found": el["t"], "tag": el["tag"]}


def click_dom(url_substr, query):
    """Locate by DOM text -> real OS click at screen coords."""
    import hands
    pos = dom_rect(url_substr, query)
    if not pos:
        return {"error": f"element not found: {query}"}
    hands.click(pos["x"], pos["y"])
    return {"ok": True, "clicked": pos}
