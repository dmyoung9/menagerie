"""Opt-in fresh OpenCode V2 plugin acceptance, isolated from the user's config.

Requires an installed opencode binary; runs no LLM requests or real deployments.
"""

import base64
import http.server
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from controlplane.plugin_install import manage

from .check_support import isolated_environment


def main():
    binary = shutil.which("opencode")
    if not binary:
        raise RuntimeError("OpenCode V2 is required")
    payload = {
        "data": [
            {
                "id": "acceptance-model",
                "menagerie": {
                    "catalog": {
                        "version": 2,
                        "catalog_id": "acceptance-model",
                        "model": {
                            "name": "Acceptance model",
                            "enabled": True,
                            "capabilities": {
                                "tools": True,
                                "input": ["text"],
                                "output": ["text"],
                            },
                            "limit": {"context": 32768, "output": 8192},
                            "variants": [],
                            "cost": [
                                {
                                    "input": 0,
                                    "output": 0,
                                    "cache": {"read": 0, "write": 0},
                                }
                            ],
                        },
                    }
                },
            }
        ]
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200 if self.path == "/v1/models" else 404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

        def log_message(self, *args):
            pass

    gateway = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=gateway.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="menagerie-opencode-") as directory:
            root = Path(directory)
            config = root / "config/opencode"
            manage("install", config, gateway.server_port)
            home = root / "home"
            home.mkdir()
            env = isolated_environment(root)
            env["OPENCODE_CONFIG_DIR"] = str(config)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            with (root / "server.log").open("w+") as log:
                process = subprocess.Popen(
                    [binary, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
                    cwd=home,
                    env=env,
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
                try:
                    opener = urllib.request.build_opener(
                        urllib.request.ProxyHandler({})
                    )
                    query = urllib.parse.urlencode({"location[directory]": str(home)})

                    def get(path):
                        log.flush()
                        text = (root / "server.log").read_text()
                        match = re.search(r"server password (\S+)", text)
                        headers = {}
                        if match:
                            headers["Authorization"] = (
                                "Basic "
                                + base64.b64encode(
                                    ("opencode:" + match[1]).encode()
                                ).decode()
                            )
                        request = urllib.request.Request(
                            f"http://127.0.0.1:{port}{path}?{query}", headers=headers
                        )
                        with opener.open(request, timeout=20) as response:
                            return json.load(response)

                    for _ in range(90):
                        if process.poll() is not None:
                            raise RuntimeError(
                                "Isolated OpenCode exited before acceptance"
                            )
                        try:
                            result = get("/api/model")
                            models = result.get("data", [])
                            found = next(
                                (
                                    m
                                    for m in models
                                    if m.get("providerID") == "menagerie"
                                    and m.get("id") == "acceptance-model"
                                ),
                                None,
                            )
                            if found:
                                assert found["limit"]["context"] == 32768
                                assert found["capabilities"]["tools"] is True
                                plugins = get("/api/plugin")
                                plugin = next(
                                    p
                                    for p in plugins["data"]
                                    if p["id"] == "local.menagerie-discovery"
                                )
                                assert plugin["state"]["status"] == "active"
                                print(
                                    json.dumps(
                                        {
                                            "result": "passed",
                                            "catalog_discovered": True,
                                            "plugin_active": True,
                                        },
                                        indent=2,
                                    )
                                )
                                return
                        except OSError:
                            pass
                        time.sleep(1)
                    raise RuntimeError(
                        "Plugin not observed in fresh OpenCode runtime; raw logs withheld"
                    )
                finally:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
    finally:
        gateway.shutdown()
        gateway.server_close()


if __name__ == "__main__":
    main()
