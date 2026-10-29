#!/usr/bin/env python3
"""CLI wrapper to call the quant-partner MCP server without an MCP client.

Usage:
  python3 ask.py "question"
  python3 ask.py --role strategist "question"   # prompts/<role>.txt
  python3 ask.py --dialog dialog.json   # [{"role":"user|model","text":"..."}]

Prints the partner's answer text to stdout.
"""

import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))


def call(requests):
    proc = subprocess.run(
        ["python3", os.path.join(BASE, "mcp_server.py")],
        input="\n".join(json.dumps(r, ensure_ascii=False) for r in requests),
        capture_output=True,
        text=True,
        timeout=600,
        env={**os.environ},
    )
    for line in proc.stdout.splitlines():
        msg = json.loads(line)
        if msg.get("id") == "call":
            return msg["result"]["content"][0]["text"]
    return f"ERROR: no call response; stderr: {proc.stderr[-500:]}"


def main():
    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit("GEMINI_API_KEY is not set")
    role = None
    args = sys.argv[1:]
    if args[:2] and args[0] == "--role":
        role = args[1]
        args = args[2:]
    if args and args[0] == "--dialog" and len(args) >= 2:
        messages = json.load(open(args[1], encoding="utf-8"))
        reqs = [
            {"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": "call",
                "method": "tools/call",
                "params": {
                    "name": "ask_quant_partner_dialog",
                    "arguments": {"messages": messages, "role": role},
                },
            },
        ]
    else:
        question = args[0] if args else sys.stdin.read()
        reqs = [
            {"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": "call",
                "method": "tools/call",
                "params": {
                    "name": "ask_quant_partner",
                    "arguments": {"question": question, "role": role},
                },
            },
        ]
    print(call(reqs))


if __name__ == "__main__":
    main()
