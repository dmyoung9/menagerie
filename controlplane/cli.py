"""Menagerie command line. The daemon owns all model lifecycle operations."""

import argparse
import contextlib
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from pathlib import Path

from .host import executable, state_path
from .version import VERSION


class Client:
    def __init__(self, port=8017, timeout=10):
        self.base = f"http://127.0.0.1:{port}"
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.token = None

    def request(self, path, body=None):
        headers = {"Content-Type": "application/json"}
        if body is not None:
            if not self.token:
                self.request("/api/status")
            headers["X-Menagerie-Token"] = self.token
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            result = json.load(response)
        if isinstance(result, dict):
            self.token = result.pop("csrf_token", None) or self.token
        return result


def doctor(args, client):
    root = state_path(args.state)
    ancestor = root
    while not ancestor.exists():
        ancestor = ancestor.parent
    assets = Path(__file__).resolve().parent / "static/index.html"
    source_assets = Path(__file__).resolve().parent.parent / "frontend/dist/index.html"
    report = {
        "python": sys.version.split()[0],
        "state_path": str(root),
        "state_exists": root.exists(),
        "state_writable": os.access(root if root.exists() else ancestor, os.W_OK),
        "disk_free_bytes": shutil.disk_usage(ancestor).free,
        "dashboard_assets": assets.is_file() or source_assets.is_file(),
        "nvidia_smi_available": executable("nvidia-smi") is not None,
        "endpoint": client.base,
    }
    try:
        status = client.request("/api/status")
        report.update(
            daemon_reachable=True,
            version=status["version"],
            telemetry_age_s=time.time() - status["host"].get("ts", 0),
            telemetry_stale=status["host"].get("stale"),
            telemetry_errors=status["host"].get("errors", []),
            collector=status.get("collector"),
            pressure=status["host"].get("pressure"),
            deployments=[
                {"alias": d["alias"], "state": d["state"]}
                for d in status["deployments"]
            ],
        )
    except (OSError, ValueError) as exc:
        report.update(
            daemon_reachable=False,
            error=str(exc),
            hint="Open Menagerie again or run menagerie serve; inspect the daemon log if startup fails.",
        )
    # Local checks describe this installation; the endpoint may belong to another.
    report["ok"] = (
        report["daemon_reachable"]
        and report["dashboard_assets"]
        and report["state_writable"]
    )
    return report, 0 if report["ok"] else 1


def parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--port",
        type=int,
        default=argparse.SUPPRESS,
        help="Local control API port (default: 8017)",
    )
    common.add_argument(
        "--state",
        default=argparse.SUPPRESS,
        help="Private state directory (or MENAGERIE_STATE)",
    )
    common.add_argument(
        "--timeout",
        type=float,
        default=argparse.SUPPRESS,
        help="HTTP timeout in seconds (default: 10)",
    )
    common.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
        help="Machine-readable JSON, including errors",
    )
    p = argparse.ArgumentParser(description=__doc__, parents=[deepcopy(common)])
    p.set_defaults(port=8017, state=None, timeout=10, json=False)
    p.add_argument("--version", action="version", version=f"Menagerie {VERSION}")
    commands = p.add_subparsers(dest="action")
    serve = commands.add_parser(
        "serve", parents=[common], help="Run the daemon in the foreground"
    )
    serve.add_argument("--gateway-port", type=int, default=8001)
    serve.add_argument(
        "--dashboard-address",
        default=os.environ.get("MENAGERIE_DASHBOARD_ADDRESS"),
        help="Additional trusted private IPv4 dashboard listener; no inference on LAN",
    )
    for name in (
        "status",
        "doctor",
        "models",
        "deployments",
        "backup",
        "export-opencode",
    ):
        commands.add_parser(name, parents=[common])
    for name in ("start", "stop"):
        command = commands.add_parser(
            name, parents=[common], help=f"Queue a deployment {name}; returns a job ID"
        )
        command.add_argument("id", help="Deployment ID (not API alias)")
        if name == "start":
            command.add_argument(
                "--approve",
                action="store_true",
                help="Approve the reviewed launch plan",
            )
    service = commands.add_parser(
        "service",
        parents=[common],
        help="Manage the optional systemd user unit; never enables or starts it implicitly",
    )
    service.add_argument("operation", choices=["install", "status", "remove"])
    service.add_argument(
        "--interpreter",
        help="Stable interpreter for the unit (default: this environment's Python)",
    )
    service.add_argument("--gateway-port", type=int, default=8001)
    plugin = commands.add_parser(
        "plugin",
        parents=[common],
        help="Install/remove the bundled OpenCode V2 discovery plugin without editing user JSONC",
    )
    plugin.add_argument("operation", choices=["install", "status", "remove"])
    plugin.add_argument(
        "--config-dir",
        help="OpenCode config directory (default: OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME/opencode)",
    )
    plugin.add_argument("--gateway-port", type=int, default=8001)
    cleanup = commands.add_parser(
        "remove-data",
        parents=[common],
        help="Irreversibly remove selected application data; stop the daemon first",
    )
    cleanup.add_argument(
        "--remove",
        action="append",
        choices=("engines", "models", "cache", "logs", "settings"),
        required=True,
    )
    cleanup.add_argument(
        "--confirm",
        action="store_true",
        help="Confirm irreversible deletion of the selected categories",
    )
    cleanup.add_argument(
        "--report", type=Path, help="Write a private cleanup result/error report"
    )
    return p


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    if (
        not 1 <= args.port <= 65535
        or not math.isfinite(args.timeout)
        or args.timeout <= 0
    ):
        p.error("port must be 1..65535 and timeout must be positive")
    code = 0
    try:
        if args.action == "remove-data":
            from .uninstall import remove_data

            result = remove_data(args.state, args.remove, confirm=args.confirm)
            if args.report:
                args.report.write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result, indent=2))
            return 0
        if args.action == "serve":
            import asyncio

            from .__main__ import serve

            asyncio.run(serve(args))
            return 0
        if args.action == "plugin":
            from .plugin_install import manage

            result = manage(args.operation, args.config_dir, args.gateway_port)
        elif args.action == "service":
            from .service import manage

            result = manage(
                args.operation,
                state_path(args.state),
                args.port,
                args.gateway_port,
                args.interpreter,
            )
            code = result.get("exit_code", 0)
        else:
            client = Client(args.port, args.timeout)
            if args.action == "doctor":
                result, code = doctor(args, client)
            elif args.action in (None, "status", "models", "deployments"):
                result = client.request("/api/" + (args.action or "status"))
            elif args.action == "backup":
                result = client.request("/api/backup", {})
            elif args.action == "export-opencode":
                result = client.request("/api/integration/opencode/export", {})
            else:
                path = "/api/serving-deployments/" + urllib.parse.quote(
                    args.id, safe=""
                )
                if args.action == "start":
                    plan = client.request(path + "/validate", {})
                    if not args.approve or plan.get("errors"):
                        result, code = (
                            {
                                "plan": plan,
                                "queued": False,
                                "hint": "Review the plan, then use start ID --approve.",
                            },
                            1,
                        )
                    else:
                        result = client.request(
                            path + "/start", {"plan_token": plan["plan_token"]}
                        )
                else:
                    result = client.request(path + "/stop", {})
        print(json.dumps(result, indent=2))
        return code
    except (OSError, ValueError, RuntimeError) as exc:
        if isinstance(exc, urllib.error.HTTPError):
            detail = exc.read(65536).decode(errors="replace")
            message = f"HTTP {exc.code}: {detail}"
        else:
            message = str(exc)
        if args.action == "remove-data" and args.report:
            with contextlib.suppress(OSError):
                args.report.write_text(message, encoding="utf-8")
        if args.json:
            print(json.dumps({"error": message}), file=sys.stderr)
        else:
            print(f"Menagerie: {message}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
