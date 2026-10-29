"""Run with an installed wheel's Python; no checkout imports or live runtimes."""

import json
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

if __package__:
    from .check_support import isolated_environment
else:
    from check_support import isolated_environment


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    port, gateway = free_port(), free_port()
    while gateway == port:
        gateway = free_port()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with tempfile.TemporaryDirectory(prefix="menagerie-artifact-") as directory:
        root = Path(directory)
        env = isolated_environment(root / "environment")
        command = [sys.executable, "-m", "controlplane.cli"]

        def cli(*args):
            result = subprocess.run(
                command + list(args),
                cwd=root,
                text=True,
                capture_output=True,
                timeout=30,
                env=env,
            )
            assert result.returncode == 0, (
                "Installed CLI check failed; raw output withheld"
            )
            return result.stdout

        assert "Menagerie" in cli("--version")
        installed = json.loads(
            cli("plugin", "install", "--config-dir", str(root / "opencode"))
        )
        assert (Path(installed["path"]) / "discovery.ts").is_file()
        assert json.loads(
            cli("plugin", "status", "--config-dir", str(root / "opencode"))
        )["installed"]
        cli("plugin", "remove", "--config-dir", str(root / "opencode"))
        with (root / "daemon.log").open("w+") as log:
            daemon = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "import time; from controlplane import cli, telemetry; "
                    "telemetry.sample = lambda: {'ts': time.time(), 'cpu_count': 8, "
                    "'ram_total_mib': 32768, 'ram_available_mib': 24000, "
                    "'gpus': [], 'processes': [], 'errors': []}; cli.main()",
                ]
                + [
                    "serve",
                    "--state",
                    str(root / "state"),
                    "--port",
                    str(port),
                    "--gateway-port",
                    str(gateway),
                ],
                cwd=root,
                stdout=log,
                stderr=log,
                env=env,
            )
            try:

                def get(path, target=port):
                    with opener.open(
                        f"http://127.0.0.1:{target}{path}", timeout=2
                    ) as response:
                        return response.read()

                for attempt in range(100):
                    if daemon.poll() is not None:
                        raise AssertionError(
                            "Isolated daemon exited; raw logs withheld"
                        )
                    try:
                        assert json.loads(get("/health"))["ok"]
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise AssertionError("Daemon did not become healthy")
                html = get("/").decode()
                asset = re.search(r'src="(/assets/[^\"]+\.js)"', html)
                assert asset and len(get(asset[1])) > 100
                assert get("/logo.png").startswith(b"\x89PNG")
                assert get("/logo-mono.png").startswith(b"\x89PNG")
                assert json.loads(get("/v1/models", gateway))["data"] == []
                assert (
                    "menagerie"
                    in json.loads((root / "state/opencode-managed.json").read_text())[
                        "providers"
                    ]
                )
                assert "csrf_token" not in json.loads(
                    cli("status", "--port", str(port))
                )
                assert json.loads(
                    cli("doctor", "--port", str(port), "--state", str(root / "state"))
                )["ok"]
                assert Path(
                    json.loads(cli("backup", "--port", str(port)))["path"]
                ).is_file()
                print(
                    "Installed wheel: CLI, bundled dashboard/logos, health, gateway catalog, export, doctor, backup passed"
                )
            finally:
                daemon.terminate()
                try:
                    daemon.wait(timeout=40)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()
            log.seek(0)
            assert daemon.returncode in (0, -signal.SIGTERM), (
                f"Unclean shutdown: {daemon.returncode}"
            )
            assert "Application shutdown complete" in log.read(), (
                "Daemon did not finish lifecycle cleanup"
            )


if __name__ == "__main__":
    main()
