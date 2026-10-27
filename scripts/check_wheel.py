"""Run with an installed wheel's Python; no checkout imports or live runtimes."""
import json
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


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
        command = [sys.executable, "-m", "controlplane.cli"]
        def cli(*args):
            result = subprocess.run(command + list(args), cwd=root, text=True, capture_output=True, timeout=30)
            assert result.returncode == 0, result.stderr or result.stdout
            return result.stdout
        assert "Menagerie" in cli("--version")
        installed = json.loads(cli("plugin", "install", "--config-dir", str(root / "opencode")))
        assert (Path(installed["path"]) / "discovery.ts").is_file()
        assert json.loads(cli("plugin", "status", "--config-dir", str(root / "opencode")))["installed"]
        cli("plugin", "remove", "--config-dir", str(root / "opencode"))
        with (root / "daemon.log").open("w+") as log:
            daemon = subprocess.Popen(command + ["serve", "--state", str(root / "state"), "--port", str(port), "--gateway-port", str(gateway)], cwd=root, stdout=log, stderr=log)
            try:
                def get(path, target=port):
                    with opener.open(f"http://127.0.0.1:{target}{path}", timeout=2) as response:
                        return response.read()
                for attempt in range(100):
                    if daemon.poll() is not None:
                        log.seek(0)
                        raise AssertionError(log.read())
                    try:
                        assert json.loads(get("/health"))["ok"]
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise AssertionError("Daemon did not become healthy")
                html = get("/").decode()
                asset = re.search(r'src="(/assets/[^\"]+\.js)"', html)
                assert asset and len(get(asset[1])) > 100
                assert get("/logo.png").startswith(b"\x89PNG")
                assert get("/logo-mono.png").startswith(b"\x89PNG")
                assert json.loads(get("/v1/models", gateway))["data"] == []
                assert "menagerie" in json.loads((root / "state/opencode-managed.json").read_text())["providers"]
                assert "csrf_token" not in json.loads(cli("status", "--port", str(port)))
                assert json.loads(cli("doctor", "--port", str(port), "--state", str(root / "state")))["ok"]
                assert Path(json.loads(cli("backup", "--port", str(port)))["path"]).is_file()
                print("Installed wheel: CLI, bundled dashboard/logos, health, gateway catalog, export, doctor, backup passed")
            finally:
                daemon.terminate()
                try:
                    daemon.wait(timeout=40)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()
            log.seek(0)
            assert daemon.returncode in (0, -signal.SIGTERM), f"Unclean shutdown: {daemon.returncode}"
            assert "Application shutdown complete" in log.read(), "Daemon did not finish lifecycle cleanup"


if __name__ == "__main__":
    main()
