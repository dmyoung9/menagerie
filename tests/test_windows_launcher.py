"""Launcher and shutdown checks run natively on Windows and Linux."""

import json
import socket
import sys
from pathlib import Path

import httpx
import pytest

from controlplane import launcher
from controlplane.api import create_app
from controlplane.host import lock_file


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def bootstrap(tmp_path, monkeypatch):
    script = tmp_path / "fixture entry.py"
    script.write_text(
        "import sys,time\n"
        f"sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})\n"
        "from controlplane import telemetry\n"
        "telemetry.sample = lambda: {'ts': time.time(), 'cpu_count': 8, 'ram_total_mib': 32768, 'ram_available_mib': 24000, 'gpus': [], 'processes': [], 'errors': []}\n"
        "from controlplane.launcher import main\nmain()\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        launcher, "daemon_command", lambda: [sys.executable, str(script)]
    )


def test_launcher_restart_duplicate_and_state_preservation(tmp_path, bootstrap):
    state = tmp_path / "state space \u00e9 \u96ea"
    port, gateway = free_port(), free_port()
    while gateway == port:
        gateway = free_port()
    try:
        assert launcher.run(
            state=state, port=port, gateway_port=gateway, browser=False
        ).endswith(str(port))
        first = json.loads((state / "instance.json").read_text())["instance_id"]
        assert launcher.run(state=state, browser=False).endswith(str(port))
        assert json.loads((state / "instance.json").read_text())["instance_id"] == first
        sentinel = state / "preserved.txt"
        sentinel.write_text("synthetic saved state")
        launcher.run("stop", state=state, browser=False)
        assert launcher.instance(state) is None
        assert not (state / "instance.json").exists()
        launcher.run(state=state, port=port, gateway_port=gateway, browser=False)
        assert json.loads((state / "instance.json").read_text())["instance_id"] != first
        assert sentinel.read_text() == "synthetic saved state"
    finally:
        launcher.run("stop", state=state, browser=False)


def test_port_conflict_is_actionable(tmp_path, bootstrap):
    state = tmp_path / "state"
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        with pytest.raises(RuntimeError, match="port conflicts"):
            launcher.run(
                state=state,
                port=free_port(),
                gateway_port=occupied.getsockname()[1],
                browser=False,
            )
        assert launcher.instance(state) is None
        assert occupied.fileno() != -1


def test_stop_refuses_unverifiable_owner(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    with lock_file(state / "daemon.lock"):
        with pytest.raises(RuntimeError, match="Another Menagerie"):
            launcher.run("stop", state=state, browser=False)


@pytest.mark.asyncio
async def test_shutdown_requires_token_origin_and_loopback(tmp_path):
    app = create_app(tmp_path / "state", dashboard_address="192.0.2.10")
    stopped = []
    app.state.request_shutdown = lambda: stopped.append(True)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        token = (await client.get("/api/status")).json()["csrf_token"]
        assert (await client.post("/api/daemon/shutdown", json={})).status_code == 403
        headers = {"X-Menagerie-Token": token, "Origin": "http://untrusted.test"}
        assert (
            await client.post("/api/daemon/shutdown", headers=headers, json={})
        ).status_code == 403
        headers.pop("Origin")
        assert (
            await client.post("/api/daemon/shutdown", headers=headers, json={})
        ).status_code == 200
        assert stopped == [True]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://192.0.2.10"
    ) as client:
        assert (
            await client.post("/api/daemon/shutdown", headers=headers, json={})
        ).status_code == 403
    await app.state.manager.client.aclose()
