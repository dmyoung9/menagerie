#!/usr/bin/env python3
"""Subprocess fixture for lifecycle/streaming tests; never loads weights or CUDA."""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if "--version" in sys.argv:
    print("fixture-runtime 1.0")
    raise SystemExit()
parser = argparse.ArgumentParser()
parser.add_argument("--model")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=0)
parser.add_argument("--alias")
parser.add_argument("--no-ui", action="store_true")
parser.add_argument("--metrics", action="store_true")
parser.add_argument("--fail", action="store_true")
args = parser.parse_args()
if args.fail:
    raise SystemExit(42)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, data, status=200):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            self.send({"status": "ok"})
        elif self.path == "/v1/models":
            self.send({"data": [{"id": args.alias}]})
        else:
            self.send({"error": "missing"}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if not body.get("stream"):
            return self.send(
                {
                    "choices": [{"message": {"content": "fixture response"}}],
                    "usage": {"completion_tokens": 2},
                }
            )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for _ in range(3):
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"word"}}]}\n\n')
            self.wfile.flush()
            time.sleep(0.03)
        self.wfile.write(
            b'data: {"usage":{"completion_tokens":3},"choices":[]}\n\ndata: [DONE]\n\n'
        )


ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
