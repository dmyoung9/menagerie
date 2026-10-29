"""Native host behavior with real, synthetic subprocesses; no inference."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest

from controlplane import adapters, host, processes, telemetry

sample_host = telemetry.sample


def test_state_precedence(tmp_path, monkeypatch):
    monkeypatch.setenv("MENAGERIE_STATE", str(tmp_path / "override"))
    assert host.state_path() == tmp_path / "override"
    assert host.state_path(tmp_path / "explicit") == tmp_path / "explicit"
    monkeypatch.delenv("MENAGERIE_STATE")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    if os.name == "nt":
        assert host.state_path() == tmp_path / "Menagerie"
    else:
        assert host.state_path() == Path.home() / ".local/state/menagerie"


def test_telemetry_windows_path_and_unavailable_load_average(monkeypatch):
    def disk_usage(path):
        assert isinstance(path, str)
        return SimpleNamespace(free=10 * 1024**3, total=20 * 1024**3)

    monkeypatch.setattr(telemetry.psutil, "disk_usage", disk_usage)
    monkeypatch.setattr(
        telemetry.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(total=32768 * 1048576, available=24000 * 1048576),
    )
    monkeypatch.setattr(
        telemetry.psutil, "swap_memory", lambda: SimpleNamespace(used=0)
    )
    monkeypatch.setattr(
        telemetry.psutil,
        "Process",
        lambda: SimpleNamespace(cpu_affinity=lambda: [0, 1]),
    )
    monkeypatch.setattr(telemetry.psutil, "cpu_percent", lambda: 0)
    monkeypatch.delattr(telemetry.os, "getloadavg", raising=False)
    monkeypatch.setattr(telemetry, "executable", lambda name: "synthetic-nvidia-smi")
    monkeypatch.setattr(
        telemetry.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1, stderr="Synthetic telemetry unavailable"
        ),
    )
    result = sample_host()
    assert "load_average" not in result
    assert result["disk_free_gib"] == 10
    assert result["gpus"] == []
    assert result["gpu_process_attribution"] is False
    assert result["errors"] == ["Synthetic telemetry unavailable"]


def test_lock_excludes_other_process_and_recovers(tmp_path):
    path = tmp_path / "daemon.lock"
    script = "from pathlib import Path; from controlplane.host import lock_file; import sys; lock_file(Path(sys.argv[1]))"
    with host.lock_file(path):
        child = subprocess.run(
            [sys.executable, "-c", script, str(path)], capture_output=True, timeout=10
        )
        assert child.returncode != 0
        assert b"Another Menagerie process" in child.stderr
    with host.lock_file(path):
        pass


@pytest.mark.asyncio
async def test_argv_unicode_and_environment(tmp_path):
    script = tmp_path / "space \u00e9 fixture.py"
    script.write_text(
        "import json,sys; print(json.dumps(sys.argv[1:]))", encoding="utf-8"
    )
    arguments = ["path with spaces", "\u96ea", 'a"b', "trailing\\"]
    result = await adapters.command(
        [sys.executable, str(script), *arguments], adapters.environment({})
    )
    assert json.loads(result) == arguments
    if os.name == "nt":
        assert any(k.upper() == "SYSTEMROOT" for k in adapters.environment({}))


@pytest.mark.asyncio
async def test_missing_executable_has_actionable_error(tmp_path):
    with pytest.raises(ValueError, match="path, architecture and prerequisites"):
        await adapters.command([str(tmp_path / "missing-engine.exe")])


@pytest.mark.skipif(os.name != "nt", reason="Windows loader error reporting")
def test_windows_loader_failure_message():
    assert "required DLL missing" in processes.exit_reason(0xC0000135)
    assert "architecture" in processes.exit_reason(-1073741701)


@pytest.mark.asyncio
async def test_owned_tree_cleanup_and_stale_identity(tmp_path):
    script = tmp_path / "tree.py"
    script.write_text(
        "import subprocess,sys,time\n"
        "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(90)'])\n"
        "print(p.pid,flush=True)\ntime.sleep(90)\n",
        encoding="utf-8",
    )
    sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(90)"])
    worker = await processes.spawn(
        sys.executable, str(script), stdout=asyncio.subprocess.PIPE
    )
    identity = {
        "pid": worker.pid,
        "pid_started": psutil.Process(worker.pid).create_time(),
    }
    child = None
    try:
        child = int(await asyncio.wait_for(worker.stdout.readline(), 10))
        assert processes.owned(identity)
        assert not processes.owned(identity | {"pid_started": 0})
        await processes.terminate(identity | {"pid_started": 0}, grace=0)
        # A stale identity must not close the actual owner's Job Object either.
        assert worker.returncode is None
        await processes.terminate(identity, grace=0.1)
        await asyncio.wait_for(worker.wait(), 10)
        for _ in range(50):
            try:
                alive = (
                    psutil.Process(child).is_running()
                    and psutil.Process(child).status() != psutil.STATUS_ZOMBIE
                )
            except psutil.NoSuchProcess:
                alive = False
            if not alive:
                break
            await asyncio.sleep(0.1)
        assert not alive
        assert sentinel.poll() is None
    finally:
        await processes.terminate(identity, grace=0)
        sentinel.kill()
        sentinel.wait(timeout=10)
        if worker.returncode is None:
            worker.kill()
            await worker.wait()
        if child:
            try:
                psutil.Process(child).kill()
            except psutil.NoSuchProcess:
                pass


@pytest.mark.asyncio
async def test_probe_timeout_cleans_up(tmp_path):
    marker = tmp_path / "child.pid"
    script = tmp_path / "probe.py"
    script.write_text(
        "import subprocess,sys,time\n"
        "from pathlib import Path\n"
        "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(90)'])\n"
        "Path(sys.argv[1]).write_text(str(p.pid))\ntime.sleep(90)\n",
        encoding="utf-8",
    )
    with pytest.raises(asyncio.TimeoutError):
        await adapters.command([sys.executable, str(script), str(marker)], timeout=2)
    assert marker.exists()
    pid = int(marker.read_text())
    for _ in range(50):
        try:
            alive = psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            alive = False
        if not alive:
            break
        await asyncio.sleep(0.1)
    assert not alive


@pytest.mark.asyncio
async def test_cancel_during_process_creation_recovers_handle(monkeypatch):
    original = asyncio.create_subprocess_exec
    created = asyncio.Event()
    finish = asyncio.Event()
    children = []

    async def delayed(*args, **kwargs):
        child = await original(*args, **kwargs)
        children.append(child)
        created.set()
        await finish.wait()
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed)
    task = asyncio.create_task(
        processes.spawn(sys.executable, "-c", "import time; time.sleep(90)")
    )
    await asyncio.wait_for(created.wait(), 10)
    task.cancel()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 10)
    assert children[0].returncode is not None
    assert children[0].pid not in processes._jobs


@pytest.mark.skipif(os.name != "nt", reason="Windows kill-on-close Job Object contract")
def test_daemon_crash_closes_worker_job():
    script = (
        "import asyncio,sys\nfrom controlplane.processes import spawn\n"
        "async def main():\n"
        " p=await spawn(sys.executable,'-c','import time; time.sleep(90)')\n"
        " print(p.pid,flush=True)\n await asyncio.sleep(90)\n"
        "asyncio.run(main())\n"
    )
    daemon = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE)
    worker = None
    try:
        worker = int(daemon.stdout.readline())
        assert psutil.pid_exists(worker)
        daemon.kill()
        daemon.wait(timeout=10)
        for _ in range(100):
            if not psutil.pid_exists(worker):
                break
            import time

            time.sleep(0.1)
        assert not psutil.pid_exists(worker)
    finally:
        if daemon.poll() is None:
            daemon.kill()
            daemon.wait(timeout=10)
        if worker and psutil.pid_exists(worker):
            psutil.Process(worker).kill()
