"""Download-and-launch entrypoint. No model lifecycle outside the daemon."""

import argparse
import json
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

import psutil

from .cli import Client
from .host import lock_file, state_path


def daemon_command():
    return (
        [sys.executable]
        if getattr(sys, "frozen", False)
        else [sys.executable, "-m", "controlplane.launcher"]
    )


def instance(root):
    """Match process identity AND the process-specific HTTP instance identity."""
    try:
        saved = json.loads((root / "instance.json").read_text(encoding="utf-8"))
        process = psutil.Process(saved["pid"])
        if abs(process.create_time() - saved["pid_started"]) >= 0.01:
            return None
        client = Client(saved["port"], timeout=2)
        status = client.request("/api/status")
        if (
            status.get("instance_id") == saved["instance_id"]
            and Path(status["state_path"]).resolve() == root
        ):
            return client
    except (OSError, ValueError, KeyError, psutil.Error):
        pass
    return None


def run(action="open", state=None, port=8017, gateway_port=8001, browser=True):
    root = state_path(state)
    root.mkdir(parents=True, exist_ok=True)
    # Serialize open/stop/upgrade actions, including their readiness wait.
    deadline = time.monotonic() + 45
    while True:
        try:
            lock = lock_file(root / "launcher.lock")
            break
        except RuntimeError:
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    "Menagerie is busy starting or stopping; retry shortly"
                ) from None
            time.sleep(0.1)
    try:
        client = instance(root)
        if action == "stop":
            if not client:
                # Refuse to declare stopped if a daemon owns the registry but
                # its endpoint cannot be verified (for example during startup).
                probe = lock_file(root / "daemon.lock")
                probe.close()
                return
            saved = json.loads((root / "instance.json").read_text(encoding="utf-8"))
            client.request("/api/daemon/shutdown", {})
            try:
                daemon = psutil.Process(saved["pid"])
                if abs(daemon.create_time() - saved["pid_started"]) < 0.01:
                    daemon.wait(timeout=max(1, deadline - time.monotonic()))
            except psutil.NoSuchProcess:
                pass
            while instance(root):
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        "Menagerie did not finish stopping; application files were not changed"
                    )
                time.sleep(0.2)
            probe = lock_file(root / "daemon.lock")
            probe.close()
            return
        if not client:
            # Do not launch a second daemon while an existing one is starting.
            probe = lock_file(root / "daemon.lock")
            probe.close()
            command = daemon_command()
            log_path = root / "daemon.log"
            if log_path.exists() and log_path.stat().st_size > 4 * 1024**2:
                log_path.replace(root / "daemon.previous.log")
            with log_path.open("a", encoding="utf-8") as log:
                child = subprocess.Popen(
                    command
                    + [
                        "serve",
                        "--state",
                        str(root),
                        "--port",
                        str(port),
                        "--gateway-port",
                        str(gateway_port),
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                    **(
                        {"creationflags": subprocess.CREATE_NO_WINDOW}
                        if os.name == "nt"
                        else {"start_new_session": True}
                    ),
                )
            while not (client := instance(root)):
                if child.poll() is not None:
                    raise RuntimeError(
                        "Menagerie could not start. Check dashboard/gateway port conflicts and daemon.log in the state directory."
                    )
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        "Menagerie startup timed out; inspect daemon.log before retrying"
                    )
                time.sleep(0.2)
        if browser:
            webbrowser.open(client.base)
        return client.base
    finally:
        lock.close()


def main():
    parser = argparse.ArgumentParser(description="Open or stop Menagerie")
    parser.add_argument(
        "action", nargs="?", choices=("open", "stop", "serve"), default="open"
    )
    parser.add_argument("--state")
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--gateway-port", type=int, default=8001)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if args.action == "serve":
        from .cli import main as cli

        sys.argv = [
            sys.argv[0],
            "serve",
            "--state",
            str(state_path(args.state)),
            "--port",
            str(args.port),
            "--gateway-port",
            str(args.gateway_port),
        ]
        cli()
        return
    try:
        run(args.action, args.state, args.port, args.gateway_port, not args.no_browser)
    except Exception as exc:
        if os.name == "nt" and not args.no_browser:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, str(exc), "Menagerie", 0x10)
        else:
            print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
