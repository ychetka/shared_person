#!/usr/bin/env python3
"""server.py - rubric-lint HTTP service (issue #80).

python3 stdlib only - no pip deps. Threaded http.server like the
service's local callers need: the eval tick posts one cell at a time
but a slow request must never wedge /health.

Endpoints:
  GET  /health -> {"ok": true}
  POST /score  {text, lang: 'ru'|'en'}
           -> {score 0-100 (higher = worse/AI-ish, pangram polarity),
               findings: [{rule, severity: 1|2, span: [start,end],
                           text, suggestion}],
               metrics: {stdev_words, band_share,
                         nominalization_density, marker_density, ...},
               lang, version}
  POST /diff   {original, rewritten, protected_terms: []}
           -> {mismatches: [{type: number|date|entity|protected|url|
                            code, original, rewritten}]}

Every response body is json.dumps(sort_keys=True) - deterministic,
byte-identical for identical input.

Run:  RUBRIC_PORT=8790 python3 server.py
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import rubric_lint

PORT = int(os.environ.get("RUBRIC_PORT") or 8790)
MAX_BODY = 2 * 1024 * 1024  # eval cells are ~2KB; 2MB is generous


def _dumps(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True).encode(
        "utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "rubric-lint/" + rubric_lint.VERSION

    def log_message(self, fmt, *args):  # keep stderr quiet; n8n logs
        pass

    def _send(self, code, obj):
        body = _dumps(obj)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bad(self, code, msg):
        self._send(code, {"error": msg, "ok": False})

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            self._send(200, {"ok": True, "version": rubric_lint.VERSION})
            return
        self._bad(404, "unknown path")

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path not in ("/score", "/diff"):
            self._bad(404, "unknown path")
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            self._bad(400, "bad content length")
            return
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._bad(400, "body is not JSON")
            return
        if not isinstance(payload, dict):
            self._bad(400, "body is not a JSON object")
            return
        try:
            if path == "/score":
                if not isinstance(payload.get("text"), str):
                    self._bad(400, "score requires {text, lang}")
                    return
                self._send(200, rubric_lint.score_text(
                    payload["text"], payload.get("lang", "en")))
            else:
                if not isinstance(payload.get("original"), str) or \
                        not isinstance(payload.get("rewritten"), str):
                    self._bad(
                        400, "diff requires {original, rewritten,"
                             " protected_terms[]}")
                    return
                self._send(200, rubric_lint.diff_texts(
                    payload["original"], payload["rewritten"],
                    payload.get("protected_terms", [])))
        except Exception as e:  # noqa: BLE001 - a lint crash must not kill the socket
            self._bad(500, "internal: " + str(e)[:200])


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    threading.current_thread().name = "rubric-lint"
    print(f"rubric-lint {rubric_lint.VERSION} listening on :{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
