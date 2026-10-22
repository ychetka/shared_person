#!/usr/bin/env python3
"""MCP stdio server: bridge to Gemini REST API with the strategy-partner system prompt.

Protocol: newline-delimited JSON-RPC 2.0 (MCP stdio transport).
Tools:
  ask_quant_partner(question, context?) - single question to the partner.
  ask_quant_partner_dialog(messages)    - dialog continuation:
      messages = [{"role":"user"|"model","text":"..."}]

ENV:
  GEMINI_API_KEY - Google AI Studio key (required)
  GEMINI_MODEL   - preferred model (default: gemini-3.5-flash)

system prompt: role files live in prompts/<role>.txt next to this script
(default role: prompts/strategist.txt, fallback: system_prompt.txt).
Optional client context is loaded from QUANT_CONTEXT_FILE or
../../client_context.md relative to this script (kept OUTSIDE the repo).
POST to generativelanguage.googleapis.com goes strictly over IPv4
(IPv6 routing to Google AI breaks POST sessions with 0 bytes - diagnosed).
"""
import json, os, socket, sys, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
API_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL_MAIN = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
MODELS = [MODEL_MAIN, "gemini-3.6-flash", "gemini-3.7-flash",
          "gemini-flash-lite-latest", "gemini-flash-latest"]
TIMEOUT = 240

def log(*a):
    print(*a, file=sys.stderr, flush=True)

# --- IPv4-only DNS (IPv6 POST to Google AI hangs) ---
_orig = socket.getaddrinfo
def _v4(host, port, *a, **k):
    return [x for x in _orig(host, port, *a, **k) if x[0] == socket.AF_INET]
socket.getaddrinfo = _v4

def _read(p):
    try:
        return open(p, encoding="utf-8").read().strip()
    except OSError:
        return ""

def system_prompt(role=None):
    p = ""
    if role:
        safe = "".join(c for c in role if c.isalnum() or c in "-_")
        p = _read(os.path.join(BASE, "prompts", f"{safe}.txt"))
    if not p:
        p = _read(os.path.join(BASE, "prompts", "strategist.txt"))
    if not p:
        p = _read(os.path.join(BASE, "system_prompt.txt"))
    ctx_file = os.environ.get(
        "QUANT_CONTEXT_FILE",
        os.path.join(BASE, "..", "..", "client_context.md"))
    ctx = _read(ctx_file)
    if ctx:
        p += "\n\n## Client context\n" + ctx
    return p

def gemini(contents, role=None):
    payload = {
        "contents": contents,
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 8192},
    }
    sp = system_prompt(role)
    if sp:
        payload["systemInstruction"] = {"parts": [{"text": sp}]}
    last_err = "no models"
    for model in MODELS:
        if not model:
            continue
        try:
            url = ("https://generativelanguage.googleapis.com/v1beta/models/"
                   f"{model}:generateContent?key={API_KEY}")
            req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
            out = json.loads(urllib.request.urlopen(req, timeout=TIMEOUT).read())
            parts = out["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts).strip()
            if text:
                log(f"gemini ok: {model}")
                return text
            last_err = f"{model}: empty response"
        except Exception as e:
            last_err = f"{model}: {e}"
            log(f"gemini fail: {last_err}")
    return f"ERROR: partner unreachable ({last_err})"

TOOLS = [
    {
        "name": "ask_quant_partner",
        "description": ("Ask the strategy partner (Gemini, role: Personal "
                        "Brand Strategist / Tech Media Architect). Single "
                        "question-answer, no memory between calls - pass all "
                        "needed context in question/context."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string",
                             "description": "Question or hypothesis to analyze"},
                "context": {"type": "string",
                            "description": "Optional: data/stats related to the question"},
                "role": {"type": "string",
                         "description": "Optional: role file name from prompts/<role>.txt (default: strategist)"},
            },
            "required": ["question"],
        },
    },
    {
        "name": "ask_quant_partner_dialog",
        "description": ("Continue a dialog with the strategy partner: pass message "
                        "history [{role:'user'|'model', text:'...'}] - for "
                        "multi-turn hypothesis discussion."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "messages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "role": {"type": "string", "enum": ["user", "model"]},
                            "text": {"type": "string"},
                        },
                        "required": ["role", "text"],
                    },
                },
                "role": {"type": "string",
                         "description": "Optional: role file name from prompts/<role>.txt (default: strategist)"},
            },
            "required": ["messages"],
        },
    },
]

def call_tool(name, args):
    role = args.get("role")
    if name == "ask_quant_partner":
        q = args["question"]
        ctx = args.get("context", "")
        text = gemini([{"role": "user", "parts": [{"text": q + ("\n\n" + ctx if ctx else "")}]}], role)
        return text
    if name == "ask_quant_partner_dialog":
        contents = [{"role": m["role"], "parts": [{"text": m["text"]}]}
                    for m in args["messages"]]
        return gemini(contents, role)
    return f"ERROR: unknown tool {name}"

def reply(rid, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid,
                                 "result": result}) + "\n")
    sys.stdout.flush()

def reply_err(rid, msg):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "error":
                                 {"code": -32603, "message": msg}}) + "\n")
    sys.stdout.flush()

def main():
    if not API_KEY:
        log("WARN: GEMINI_API_KEY is not set")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = msg.get("id")
        method = msg.get("method", "")
        if method == "initialize":
            reply(rid, {
                "protocolVersion": msg.get("params", {}).get(
                    "protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "quant-partner", "version": "1.0.0"},
            })
        elif method in ("notifications/initialized", "initialized"):
            pass
        elif method == "ping":
            reply(rid, {})
        elif method == "tools/list":
            reply(rid, {"tools": TOOLS})
        elif method == "tools/call":
            p = msg.get("params", {})
            try:
                text = call_tool(p.get("name", ""), p.get("arguments", {}) or {})
                reply(rid, {"content": [{"type": "text", "text": text}]})
            except Exception as e:
                reply_err(rid, str(e))
        elif rid is not None:
            reply_err(rid, f"unsupported method {method}")

if __name__ == "__main__":
    main()
