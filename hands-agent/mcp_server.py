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

Queue: n8n drops JSON tasks into ./queue/inbox/*.json, a poller thread
consumes them into ./queue/{done,failed}/. Task = {"recipe": str, "params": {...}}

ENV: DISPLAY, XAUTHORITY (auto-default to :1 + ~/.Xauthority).
GEMINI_API_KEY (optional) - enables 'locate' via vision model.
"""
import json, os, queue, socket, sys, threading, time, urllib.request, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hands, vision

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
        "contents": [{"role": "user", "parts": [
            {"text": ("You are a screen element locator. The screenshot is "
                      f"1400x1050. Return ONLY JSON {{\"x\":int,\"y\":int}} - the "
                      f"center of: {description}. Hint: {hint}. If not visible, "
                      "return {\"x\":-1,\"y\":-1}."),
            },
            {"inlineData": {"mimeType": "image/png", "data": b64}}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 64},
    }
    for model in ("gemini-3.5-flash", "gemini-flash-lite-latest", "gemini-3.1-flash-lite"):
        try:
            url = ("https://generativelanguage.googleapis.com/v1beta/models/"
                   f"{model}:generateContent?key={key}")
            req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
            out = json.loads(urllib.request.urlopen(req, timeout=60).read())
            text = out["candidates"][0]["content"]["parts"][0]["text"].strip()
            j = json.loads(text[text.index("{"):text.rindex("}") + 1])
            if j.get("x", -1) >= 0:
                return {"x": j["x"], "y": j["y"], "model": model}
        except Exception as e:
            log("locate fail", model, e)
    return {"x": -1, "y": -1}

def run_recipe(name, params):
    """Execute recipes/<name>.yaml. Mini-DSL:
    steps: [{action: find|locate|click|type|key|scroll|wait|shot|move, ...}]
    Template strings support {param} substitution."""
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
    for i, st in enumerate(recipe.get("steps", [])):
        st = {k: (v.format(**ctx) if isinstance(v, str) else v)
              for k, v in st.items()}
        act = st.get("action")
        try:
            if act == "find":
                hit = vision.find_on_screen(
                    os.path.join(BASE, st["template"]), st.get("confidence", 0.85))
                if not hit:
                    return {"error": f"step{i}: template {st['template']} not found", "log": log_line}
                ctx[st.get("into", "pos")] = hit
            elif act == "locate":
                r = gemini_locate(st["target"], st.get("hint", ""))
                if r.get("x", -1) < 0:
                    return {"error": f"step{i}: locate failed: {r}", "log": log_line}
                ctx[st.get("into", "pos")] = (r["x"], r["y"])
            elif act in ("click", "move"):
                fn = hands.click if act == "click" else hands.move
                fn(st["x"], st["y"]) if "x" in st else fn(*ctx[st.get("pos", "pos")])
            elif act == "type":
                hands.type_text(st["text"])
            elif act == "key":
                hands.key(*st["keys"].split("+"))
            elif act == "scroll":
                hands.scroll(st.get("amount", 3), st.get("direction", "down"))
            elif act == "wait":
                time.sleep(st.get("seconds", 1))
            elif act == "shot":
                p = vision.screenshot(os.path.join(BASE, "queue", "done",
                                                   st.get("name", f"step{i}.png")))
                log_line.append(f"step{i} shot -> {p}")
            else:
                return {"error": f"step{i}: unknown action {act}", "log": log_line}
            log_line.append(f"step{i} {act} ok")
        except Exception as e:
            return {"error": f"step{i} {act}: {e}", "log": log_line}
    return {"ok": True, "log": log_line}

def queue_worker():
    while True:
        for fn in sorted(os.listdir(INBOX)):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(INBOX, fn)
            try:
                task = json.load(open(p))
                tid = fn[:-5]
                TASKS[tid] = {"status": "running", "task": task}
                res = run_recipe(task["recipe"], task.get("params", {}))
                TASKS[tid].update(status="done" if res.get("ok") else "failed",
                                  result=res)
                dst = DONE if res.get("ok") else FAILED
            except Exception as e:
                tid = fn[:-5]
                TASKS[tid] = {"status": "failed", "result": {"error": str(e)}}
                dst = FAILED
            os.replace(p, os.path.join(dst, fn))
        time.sleep(2)

TOOLS = [
    {"name": "screenshot", "description": "Full-screen PNG, returns path",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "click", "description": "Human-like click at screen coords",
     "inputSchema": {"type": "object", "required": ["x", "y"],
        "properties": {"x": {"type": "integer"}, "y": {"type": "integer"},
                       "button": {"type": "integer", "default": 1}}}},
    {"name": "move", "description": "Bezier mouse move",
     "inputSchema": {"type": "object", "required": ["x", "y"],
        "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}}}},
    {"name": "type_text", "description": "Type text with jitter",
     "inputSchema": {"type": "object", "required": ["text"],
        "properties": {"text": {"type": "string"}}}},
    {"name": "key", "description": "Key combo e.g. ctrl+t, Return",
     "inputSchema": {"type": "object", "required": ["keys"],
        "properties": {"keys": {"type": "string"}}}},
    {"name": "scroll", "description": "Mouse wheel scroll",
     "inputSchema": {"type": "object", "properties": {
        "amount": {"type": "integer", "default": 3},
        "direction": {"type": "string", "enum": ["up", "down"], "default": "down"}}}},
    {"name": "find", "description": "Template match on screen -> {x,y}",
     "inputSchema": {"type": "object", "required": ["template"],
        "properties": {"template": {"type": "string"},
                       "confidence": {"type": "number", "default": 0.85}}}},
    {"name": "locate", "description": "Vision-model locate element -> {x,y}",
     "inputSchema": {"type": "object", "required": ["description"],
        "properties": {"description": {"type": "string"},
                       "hint": {"type": "string"}}}},
    {"name": "run_recipe", "description": "Run recipes/<name>.yaml with params",
     "inputSchema": {"type": "object", "required": ["name"],
        "properties": {"name": {"type": "string"},
                       "params": {"type": "object"}}}},
    {"name": "task_status", "description": "Queue task status",
     "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string"}}}},
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
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid,
        "error": {"code": -32603, "message": msg}}) + "\n")
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
            reply(rid, {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "hands-agent", "version": "1.0.0"}})
        elif method in ("notifications/initialized", "initialized"):
            pass
        elif method == "ping":
            reply(rid, {})
        elif method == "tools/list":
            reply(rid, {"tools": TOOLS})
        elif method == "tools/call":
            p = msg.get("params", {})
            try:
                reply(rid, {"content": [{"type": "text", "text":
                    json.dumps(call_tool(p.get("name", ""), p.get("arguments", {}) or {}))}]})
            except Exception as e:
                reply_err(rid, str(e))
        elif rid is not None:
            reply_err(rid, f"unsupported method {method}")

if __name__ == "__main__":
    main()
