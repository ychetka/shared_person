#!/usr/bin/env python3
"""MCP stdio server: hands-agent - real OS input + computer vision.

Tools (all coordinates are SCREEN pixels):
  screenshot()                        -> saves PNG, returns path
  click(x, y)                         -> human-like click at coords
  move(x, y)                          -> bezier mouse move
  type_text(text)                     -> jitter typing
  key(keys)                           -> e.g. "ctrl+t", "Return"
  scroll(amount, direction)           -> mouse wheel
  find(template_path, confidence?)    -> template match -> (x,y) | null
  locate(description, hint?)          -> vision-model locate -> (x,y) | null
  run_recipe(name, params_json)       -> run recipes/<name>.yaml steps
  task_status(task_id?)               -> queue status
  set_clipboard(text)                 -> load X CLIPBOARD for ctrl+v paste
  open_tab_bg(url, settle_s?)         -> OS-level background-load tab open
  tab_url(url_substr)                 -> read-only /json tab url+title

CDP is READ-OBSERVE ONLY in this contour (issue #127): the former
dom_find/click_dom/js_click/dom_text tools ran on Runtime.evaluate
and are removed - every page actuation is real OS input. Element
targeting is screenshot-driven: `find` (template) or `locate`
(vision model) -> `click` at the returned coords.

Queue: n8n drops JSON tasks into ./queue/inbox/*.json, a poller thread
consumes them into ./queue/{done,failed}/. Task = {"recipe": str, "params": {...}}
Result channel (habr-driver-spec 2.4): on completion the poller also
writes queue/<done|failed>/<task_id>.result.json carrying the recipe's
returned fields ({ok, url?, error?, log?}) - n8n polls that file for
external_ids and failure classification.

ENV: DISPLAY, XAUTHORITY (auto-default to :1 + ~/.Xauthority).
GEMINI_API_KEY (optional) - enables 'locate' via vision model.
"""

import json
import os
import sys
import threading
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp
import hands
import tab_ctl
import vision

BASE = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(BASE, "queue", "inbox")
DONE = os.path.join(BASE, "queue", "done")
FAILED = os.path.join(BASE, "queue", "failed")
for d in (INBOX, DONE, FAILED):
    os.makedirs(d, exist_ok=True)

TASKS = {}  # id -> {recipe, params, status, result}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def gemini_locate(description, hint=""):
    """Vision-model fallback: ask Gemini to find element coords on screenshot."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return {"error": "GEMINI_API_KEY not set; use find() with a template"}
    shot = vision.screenshot()
    import base64

    b64 = base64.b64encode(open(shot, "rb").read()).decode()
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            "You are a screen element locator. The screenshot is "
                            f'1400x1050. Return ONLY JSON {{"x":int,"y":int}} - the '
                            f"center of: {description}. Hint: {hint}. If not visible, "
                            'return {"x":-1,"y":-1}.'
                        ),
                    },
                    {"inlineData": {"mimeType": "image/png", "data": b64}},
                ],
            }
        ],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 64},
    }
    for model in ("gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"):
        try:
            url = (
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model}:generateContent?key={key}"
            )
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
            )
            out = json.loads(urllib.request.urlopen(req, timeout=60).read())
            text = out["candidates"][0]["content"]["parts"][0]["text"].strip()
            j = json.loads(text[text.index("{") : text.rindex("}") + 1])
            if j.get("x", -1) >= 0:
                return {"x": j["x"], "y": j["y"], "model": model}
        except Exception as e:  # noqa: BLE001 - try every fallback model regardless of failure type
            log("locate fail", model, e)
    return {"x": -1, "y": -1}


def run_recipe(name, params):
    """Execute recipes/<name>.yaml. Mini-DSL:
    steps: [{action: find|locate|click|type|key|scroll|wait|shot|move|
             emit|fail|set_clipboard|open_tab_bg|tab_url, ...}]
    The former dom_find/click_dom/js_click/dom_text actions are
    fail-closed stubs: they ran on Runtime.evaluate, which the CDP
    read-only directive bans outright, so the step aborts the recipe
    with a named error instead of touching the page.
    Template strings support {param} substitution. A step carrying
    `marks: publish` is the post-publish classification boundary: the
    result records its index as publish_step next to last_step (index
    of the last completed step), so the driver can tell a pre-click
    failure from a post-click one without parsing log text."""
    path = os.path.join(BASE, "recipes", f"{name}.yaml")
    if not os.path.exists(path):
        return {"error": f"recipe {name} not found"}
    try:
        import yaml

        recipe = yaml.safe_load(open(path, encoding="utf-8"))
    except ImportError:
        return {"error": "python3-yaml not installed"}
    ctx = dict(params)
    log_line = []
    emitted = {}  # `emit` steps publish ctx values into the task result
    steps = recipe.get("steps", [])
    # index of the step marked `marks: publish` - the click boundary
    # the driver classifies against (None when the recipe marks none)
    publish_idx = next(
        (i for i, s in enumerate(steps) if isinstance(s, dict) and s.get("marks") == "publish"),
        None,
    )
    last_done = -1  # index of the last step that completed (skipped != done)
    # result fields the emit step can never overwrite
    _RESERVED = ("ok", "log", "error", "last_step", "publish_step")

    def _result(err=None):
        # one result shape for success AND failure: emitted values
        # (abort_reason, url, media_attached, ...) accumulated so far
        # must survive into a failed result - the worker writes them
        # to failed/<task_id>.result.json verbatim and the driver
        # classifies on them
        r = {"log": log_line, "last_step": last_done}
        if err is None:
            r["ok"] = True
        else:
            r["error"] = err
        if publish_idx is not None:
            r["publish_step"] = publish_idx
        for k, v in emitted.items():
            if k not in _RESERVED:
                r[k] = v
        return r

    class _Safe(dict):
        def __missing__(self, k):
            return ""

    for i, st in enumerate(steps):
        # conditional step: `if: "{param}"` - skipped when the formatted
        # value is empty/false (missing params format to "")
        cond = st.get("if")
        if cond is not None:
            # leading '!' negates: `if: "!{sug_hit}"` runs the step
            # when the formatted value is empty/false (e.g. a locate
            # miss that must fail closed)
            neg = str(cond).lstrip().startswith("!")
            raw_cond = str(cond).lstrip()[1:] if neg else str(cond)
            cv = str(raw_cond).format_map(_Safe(ctx)).strip().lower()
            if neg:
                cv = "" if cv not in ("", "0", "false", "no") else "1"
            if cv in ("", "0", "false", "no"):
                log_line.append(f"step{i} skipped (if -> {cv!r})")
                continue
        st = {
            k: (v.format(**ctx) if isinstance(v, str) and k != "if" else v)
            for k, v in st.items()
            if k != "if"
        }
        act = st.get("action")
        try:
            if act == "find":
                hit = vision.find_on_screen(
                    os.path.join(BASE, st["template"]), st.get("confidence", 0.85)
                )
                if not hit:
                    return _result(f"step{i}: template {st['template']} not found")
                ctx[st.get("into", "pos")] = hit
            elif act == "locate":
                # screenshot-driven element resolution: the vision
                # model answers coords for a described element on the
                # current screen. `optional: true` turns a miss into
                # (-1,-1) ctx coords instead of a failed step (negative
                # probes are legitimate results).
                r = gemini_locate(st["target"], st.get("hint", ""))
                into = st.get("into", "pos")
                if r.get("x", -1) < 0:
                    if not st.get("optional"):
                        return _result(f"step{i}: locate failed: {r}")
                    log_line.append(f"step{i} locate miss (optional): {st['target']}")
                ctx[into] = (r["x"], r["y"])
                # hit flag for `if:`-gated follow-ups (e.g. click the
                # located suggestion only when it was actually found):
                # ctx['<into>_hit'] is "1" on hit, "" on miss
                ctx[into + "_hit"] = "1" if r.get("x", -1) >= 0 else ""
            elif act in ("click", "move"):
                fn = hands.click if act == "click" else hands.move
                if "x" in st:
                    fn(st["x"], st["y"])
                else:
                    x, y = ctx[st.get("pos", "pos")]
                    fn(x + st.get("dx", 0), y + st.get("dy", 0))
            elif act == "type":
                hands.type_text(st["text"])
            elif act == "key":
                hands.key(*st["keys"].split("+"))
            elif act == "scroll":
                hands.scroll(st.get("amount", 3), st.get("direction", "down"))
            elif act == "wait":
                time.sleep(st.get("seconds", 1))
            elif act in ("dom_find", "click_dom", "js_click", "dom_text"):
                # FAIL-CLOSED STUBS (issue #127): these actions ran on
                # Runtime.evaluate, banned by the CDP read-only
                # directive. The recipe stops on a named reason rather
                # than silently touching the page; migrate to
                # locate+click (actuation) or tab_url (location
                # read-back).
                return _result(
                    f"step{i}: action '{act}' removed - CDP evaluate is banned "
                    "by the read-only directive; use locate+click or tab_url"
                )
            elif act == "open_tab_bg":
                # OS-level background-load tab open (tab_ctl.py): the
                # heavy-SPA-safe path - load occluded, settle, activate
                r = tab_ctl.open_tab_bg(
                    st["url"], settle_s=st.get("settle", 45), activate=st.get("activate", True)
                )
                if r.get("error"):
                    return _result(f"step{i}: {r['error']}")
            elif act == "tab_url":
                # read-only /json/list location read-back (no evaluate):
                # lands {url} of the tab matching st['url'] in ctx.
                # `optional: true` turns a miss into empty ctx instead
                # of a failed step.
                r = cdp.tab_info(st["url"])
                if r is None:
                    if not st.get("optional"):
                        return _result(f"step{i}: tab_url no match: {st['url']}")
                    r = {}
                into = st.get("into", "page")
                ctx[into] = r.get("url") or ""
                ctx[into + "_title"] = r.get("title") or ""
                log_line.append(f"step{i} tab_url '{st['url']}' -> {ctx[into][:80]}")
            elif act == "set_clipboard":
                # long-body insert path: loads the X clipboard via
                # PyGObject; the recipe then `key ctrl+v`s a real paste
                hands.set_clipboard(st["text"])
            elif act == "emit":
                # publish a ctx value (or a literal) into the task
                # result, e.g. `{action: emit, key: url, value:
                # "{page}"}` after a location-read tab_url - this is
                # what lands in done/<task_id>.result.json. Non-string
                # YAML literals (true, 1, 2.5, [..]) pass through
                # typed - only strings get {param} formatting
                emitted[str(st["key"])] = (
                    ctx.get(st["from"]) if "from" in st else st.get("value", "")
                )
            elif act == "fail":
                # explicit recipe abort, typically `if:`-gated behind a
                # blocked-surface probe whose emit already recorded
                # abort_reason - the run stops NOW on a named reason
                # instead of stumbling into a later step's generic
                # 'element not found' (which would bury the real cause)
                return _result(f"step{i}: {st.get('reason', 'explicit fail')}")
            elif act == "shot":
                p = vision.screenshot(
                    os.path.join(BASE, "queue", "done", st.get("name", f"step{i}.png"))
                )
                log_line.append(f"step{i} shot -> {p}")
            else:
                return _result(f"step{i}: unknown action {act}")
            log_line.append(f"step{i} {act} ok")
            last_done = i
        except Exception as e:  # noqa: BLE001 - a failed step must surface as recipe result, not crash the loop
            return _result(f"step{i} {act}: {e}")
    return _result()


def queue_worker():
    while True:
        for fn in sorted(os.listdir(INBOX)):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(INBOX, fn)
            res = None
            try:
                task = json.load(open(p))
                tid = fn[:-5]
                TASKS[tid] = {"status": "running", "task": task}
                res = run_recipe(task["recipe"], task.get("params", {}))
                TASKS[tid].update(status="done" if res.get("ok") else "failed", result=res)
                dst = DONE if res.get("ok") else FAILED
            except Exception as e:  # noqa: BLE001 - queue boundary: mark the task failed, keep the worker alive
                tid = fn[:-5]
                res = {"error": str(e)}
                TASKS[tid] = {"status": "failed", "result": res}
                dst = FAILED
            # result channel (habr-driver-spec 2.4): n8n polls
            # queue/{done,failed}/<task_id>.result.json for the recipe's
            # emitted fields - url on success, error+log for post-click
            # classification on failure. Write it before the task file
            # lands so a result never sits without its task - or, more
            # importantly, a moved task file is never mistaken for a
            # result-less finish while the result is still mid-write.
            try:
                payload = dict(res or {})
                payload["ok"] = bool(payload.get("ok"))
                rp = os.path.join(dst, tid + ".result.json")
                tmp = rp + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False)
                os.replace(tmp, rp)
            except Exception as e:  # noqa: BLE001 - a lost result must not wedge the worker; the task file still lands
                log("result write failed", tid, e)
            os.replace(p, os.path.join(dst, fn))
        time.sleep(2)


TOOLS = [
    {
        "name": "screenshot",
        "description": "Full-screen PNG, returns path",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "click",
        "description": "Human-like click at screen coords",
        "inputSchema": {
            "type": "object",
            "required": ["x", "y"],
            "properties": {
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "button": {"type": "integer", "default": 1},
            },
        },
    },
    {
        "name": "move",
        "description": "Bezier mouse move",
        "inputSchema": {
            "type": "object",
            "required": ["x", "y"],
            "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
        },
    },
    {
        "name": "type_text",
        "description": "Type text with jitter",
        "inputSchema": {
            "type": "object",
            "required": ["text"],
            "properties": {"text": {"type": "string"}},
        },
    },
    {
        "name": "key",
        "description": "Key combo e.g. ctrl+t, Return",
        "inputSchema": {
            "type": "object",
            "required": ["keys"],
            "properties": {"keys": {"type": "string"}},
        },
    },
    {
        "name": "scroll",
        "description": "Mouse wheel scroll",
        "inputSchema": {
            "type": "object",
            "properties": {
                "amount": {"type": "integer", "default": 3},
                "direction": {"type": "string", "enum": ["up", "down"], "default": "down"},
            },
        },
    },
    {
        "name": "find",
        "description": "Template match on screen -> {x,y}",
        "inputSchema": {
            "type": "object",
            "required": ["template"],
            "properties": {
                "template": {"type": "string"},
                "confidence": {"type": "number", "default": 0.85},
            },
        },
    },
    {
        "name": "locate",
        "description": "Vision-model locate element -> {x,y}",
        "inputSchema": {
            "type": "object",
            "required": ["description"],
            "properties": {"description": {"type": "string"}, "hint": {"type": "string"}},
        },
    },
    {
        "name": "run_recipe",
        "description": "Run recipes/<name>.yaml with params",
        "inputSchema": {
            "type": "object",
            "required": ["name"],
            "properties": {"name": {"type": "string"}, "params": {"type": "object"}},
        },
    },
    {
        "name": "open_tab_bg",
        "description": (
            "Open a URL in a new tab via OS input, return focus to the "
            "previous tab while it loads (heavy-SPA-safe background "
            "init), settle, then activate it. No CDP."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": {"type": "string"},
                "settle_s": {"type": "integer", "default": 45},
            },
        },
    },
    {
        "name": "tab_url",
        "description": (
            "Read-only tab location read-back from the CDP /json "
            "listing (no evaluate): -> {url,title} of the tab whose "
            "URL contains url_substr"
        ),
        "inputSchema": {
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": {"type": "string", "description": "substring of tab URL"},
            },
        },
    },
    {
        "name": "set_clipboard",
        "description": (
            "Load text into the X clipboard (PyGObject Gtk) so a later 'key ctrl+v' pastes it"
        ),
        "inputSchema": {
            "type": "object",
            "required": ["text"],
            "properties": {"text": {"type": "string"}},
        },
    },
    {
        "name": "task_status",
        "description": "Queue task status",
        "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string"}}},
    },
]


def call_tool(name, args):
    if name == "screenshot":
        return {"path": vision.screenshot()}
    if name == "click":
        hands.click(args["x"], args["y"], args.get("button", 1))
        return {"ok": True}
    if name == "move":
        hands.move(args["x"], args["y"])
        return {"ok": True}
    if name == "type_text":
        hands.type_text(args["text"])
        return {"ok": True}
    if name == "key":
        hands.key(*args["keys"].split("+"))
        return {"ok": True}
    if name == "scroll":
        hands.scroll(args.get("amount", 3), args.get("direction", "down"))
        return {"ok": True}
    if name == "find":
        hit = vision.find_on_screen(args["template"], args.get("confidence", 0.85))
        return {"x": hit[0], "y": hit[1]} if hit else {"x": -1, "y": -1}
    if name == "locate":
        return gemini_locate(args["description"], args.get("hint", ""))
    if name == "open_tab_bg":
        return tab_ctl.open_tab_bg(args["url"], settle_s=args.get("settle_s", 45))
    if name == "tab_url":
        return cdp.tab_info(args["url"]) or {"error": "no match"}
    if name == "set_clipboard":
        hands.set_clipboard(args["text"])
        return {"ok": True}
    if name == "run_recipe":
        tid = str(uuid.uuid4())[:8]
        res = run_recipe(args["name"], args.get("params", {}))
        res["task_id"] = tid
        return res
    if name == "task_status":
        tid = args.get("task_id")
        return TASKS.get(tid) if tid else {"tasks": TASKS}
    return {"error": f"unknown tool {name}"}


def reply(rid, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}) + "\n")
    sys.stdout.flush()


def reply_err(rid, msg):
    sys.stdout.write(
        json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": msg}}) + "\n"
    )
    sys.stdout.flush()


def main():
    threading.Thread(target=queue_worker, daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid, method = msg.get("id"), msg.get("method", "")
        if method == "initialize":
            reply(
                rid,
                {
                    "protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "hands-agent", "version": "1.0.0"},
                },
            )
        elif method in ("notifications/initialized", "initialized"):
            pass
        elif method == "ping":
            reply(rid, {})
        elif method == "tools/list":
            reply(rid, {"tools": TOOLS})
        elif method == "tools/call":
            p = msg.get("params", {})
            try:
                reply(
                    rid,
                    {
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(
                                    call_tool(p.get("name", ""), p.get("arguments", {}) or {})
                                ),
                            }
                        ]
                    },
                )
            except Exception as e:  # noqa: BLE001 - JSON-RPC boundary: any tool failure answers an error reply
                reply_err(rid, str(e))
        elif rid is not None:
            reply_err(rid, f"unsupported method {method}")


if __name__ == "__main__":
    main()
