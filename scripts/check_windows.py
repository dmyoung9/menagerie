"""Native installed-installer checks. Explicit local artifacts, fake worker only."""

import argparse
import hashlib
import json
import os
import re
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import psutil

from scripts.check_support import isolated_environment


def require_disposable_account():
    import winreg

    key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{B420E046-AF92-4534-B165-059AD27C3E42}_is1"
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                existing = winreg.OpenKey(hive, key, 0, winreg.KEY_READ | view)
            except FileNotFoundError:
                continue
            else:
                existing.Close()
                raise RuntimeError(
                    "An existing Menagerie installation is registered. Use a fresh disposable Windows account; this check will not replace it."
                )


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def check(installer, worker, baseline=None):
    if os.name != "nt":
        raise RuntimeError("This check requires native Windows")
    require_disposable_account()
    with tempfile.TemporaryDirectory(
        prefix="menagerie-windows-", ignore_cleanup_errors=True
    ) as temporary:
        root = Path(temporary)
        app = root / "Programs space \u00e9/Menagerie"
        state = root / "state \u96ea"
        env = isolated_environment(root / "environment")
        # The application must not find Python/Node/Git/uv through PATH.
        env["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
        env["MENAGERIE_STATE"] = str(state)
        port, gateway = free_port(), free_port()
        while gateway == port:
            gateway = free_port()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def execute(argv, success=True):
            started = time.time()
            offsets = {
                log: log.stat().st_size if log.exists() else 0
                for log in (state / "daemon.log", state / "launcher.log")
            }
            result = subprocess.run(
                [str(a) for a in argv],
                cwd=root,
                env=env,
                capture_output=True,
                timeout=120,
            )
            if str(argv[0]).lower().endswith("setup.exe") or Path(
                argv[0]
            ).name.lower().startswith("unins"):
                # Inno's final self-removal helper can briefly outlive the
                # original uninstaller. Wait only for helpers in our temp root.
                for process in psutil.process_iter(["exe", "create_time"]):
                    try:
                        executable = process.info["exe"]
                        if (
                            executable
                            and process.info["create_time"] >= started
                            and Path(executable).is_relative_to(Path(env["TEMP"]))
                        ):
                            process.wait(timeout=30)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            if success:
                if result.returncode:
                    categories = []
                    for log, offset in offsets.items():
                        if log.is_file():
                            text = log.read_bytes()[offset:][-8192:].decode(
                                "utf-8", errors="replace"
                            )
                            for line in text.splitlines():
                                if line.startswith("Menagerie:") or re.match(
                                    r"^[A-Za-z]+Error:", line
                                ):
                                    categories.append(
                                        re.sub(
                                            r"[A-Za-z]:[\\/][^\r\n]+",
                                            "[path withheld]",
                                            line,
                                        )[:300]
                                    )
                    raise AssertionError(
                        f"Installed command failed ({result.returncode}); categories: {categories[-5:]}; raw diagnostics withheld"
                    )
            return result

        def install(path):
            execute(
                [
                    path,
                    "/VERYSILENT",
                    "/SUPPRESSMSGBOXES",
                    "/NORESTART",
                    "/SP-",
                    f"/DIR={app}",
                ]
            )
            assert (app / "Menagerie.exe").is_file()
            assert (app / "menagerie-cli.exe").is_file()

        def launch(action="open"):
            return [
                app / "Menagerie.exe",
                action,
                "--no-browser",
                "--port",
                str(port),
                "--gateway-port",
                str(gateway),
            ]

        def request(path, body=None, target=None):
            headers = {"Content-Type": "application/json"}
            if body is not None:
                headers["X-Menagerie-Token"] = request("/api/status")["csrf_token"]
            req = urllib.request.Request(
                f"http://127.0.0.1:{target or port}{path}",
                data=json.dumps(body).encode() if body is not None else None,
                headers=headers,
            )
            with opener.open(req, timeout=30) as response:
                raw = response.read()
                return (
                    json.loads(raw)
                    if response.headers.get_content_type() == "application/json"
                    else raw
                )

        def wait_dead(pid):
            for _ in range(100):
                if not psutil.pid_exists(pid):
                    return
                time.sleep(0.1)
            raise AssertionError("Owned fake worker survived shutdown")

        installed = False
        try:
            install(baseline or installer)
            old_build = (app / "build.json").read_bytes()
            installed = True
            assert (
                b"Menagerie" in execute([app / "menagerie-cli.exe", "--version"]).stdout
            )
            # A bound unrelated listener must not be reused or killed.
            with socket.socket() as occupied:
                occupied.bind(("127.0.0.1", gateway))
                occupied.listen()
                assert execute(launch(), success=False).returncode != 0
            execute(launch())
            first = request("/api/status")["instance_id"]
            duplicates = [
                subprocess.Popen([str(a) for a in launch()], cwd=root, env=env)
                for _ in range(2)
            ]
            assert all(p.wait(timeout=60) == 0 for p in duplicates)
            assert request("/api/status")["instance_id"] == first
            html = request("/").decode()
            asset = re.search(r'src="(/assets/[^\"]+\.js)"', html)
            assert asset and len(request(asset[1])) > 100
            assert request("/v1/models", target=gateway)["data"] == []
            model = root / "models space \u00e9/fixture.gguf"
            model.parent.mkdir()
            model.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 0))
            job = request("/api/models/local", {"path": str(model)})
            for _ in range(100):
                completed = next(
                    j for j in request("/api/registry/jobs") if j["id"] == job["id"]
                )
                if completed["state"] == "SUCCEEDED":
                    break
                assert completed["state"] != "FAILED", "Synthetic model import failed"
                time.sleep(0.1)
            else:
                raise AssertionError("Synthetic model import timed out")
            artifact = completed["result"]
            # Runtime registration probes the real frozen fake worker executable.
            runtime = request(
                "/api/runtimes",
                {
                    "name": "Synthetic native worker",
                    "engine": "llama.cpp",
                    "execution_kind": "native",
                    "executable": str(worker),
                    "trust": True,
                },
            )
            profile = request(
                "/api/profiles",
                {
                    "name": "Synthetic fixture",
                    "artifact_id": artifact["id"],
                    "runtime_id": runtime["id"],
                    "config": {},
                    "raw_args": ["--spawn-child"],
                },
            )
            deployment = request(
                "/api/deployments",
                {
                    "name": "Synthetic fixture",
                    "alias": "fixture",
                    "profile_id": profile["id"],
                    "port": free_port(),
                    "residency": "on-demand",
                    "reservation_mib": 0,
                    "allow_uncertain": True,
                },
            )
            ident = deployment["id"]
            validation = request(f"/api/serving-deployments/{ident}/validate", {})
            request(
                f"/api/serving-deployments/{ident}/start",
                {"plan_token": validation["plan_token"], "override": True},
            )
            for _ in range(100):
                rows = request("/api/status")["deployments"]
                row = next(d for d in rows if d["id"] == ident)
                if row["state"] == "READY":
                    break
                assert row["state"] not in {"FAILED", "ERROR"}, (
                    "Fake runtime launch failed"
                )
                time.sleep(0.2)
            else:
                raise AssertionError("Fake runtime readiness timed out")
            parent = row["pid"]
            child = int(model.with_suffix(".child.pid").read_text())
            reply = request(
                "/v1/chat/completions",
                {
                    "model": "fixture",
                    "messages": [{"role": "user", "content": "synthetic"}],
                },
                gateway,
            )
            assert reply["choices"][0]["message"]["content"] == "fixture response"
            streamed = request(
                "/v1/chat/completions",
                {
                    "model": "fixture",
                    "messages": [{"role": "user", "content": "synthetic"}],
                    "stream": True,
                },
                gateway,
            )
            assert b"[DONE]" in streamed
            cancel = urllib.request.Request(
                f"http://127.0.0.1:{gateway}/v1/chat/completions",
                data=json.dumps(
                    {
                        "model": "fixture",
                        "messages": [
                            {"role": "user", "content": "synthetic cancellation"}
                        ],
                        "stream": True,
                    }
                ).encode(),
                headers={"Content-Type": "application/json"},
            )
            with opener.open(cancel, timeout=30) as response:
                assert response.readline().startswith(b"data:")
            for _ in range(100):
                if not any(request("/health")["inflight"].values()):
                    break
                time.sleep(0.1)
            else:
                raise AssertionError(
                    "Disconnected fake stream retained an in-flight request"
                )
            # Authenticated, loopback shutdown runs Manager.close and kills descendants.
            execute(launch("stop"))
            wait_dead(parent)
            wait_dead(child)
            assert model.exists()
            before = hashlib.sha256(model.read_bytes()).hexdigest()
            execute(launch())
            assert request("/api/status")["instance_id"] != first
            assert any(d["id"] == ident for d in request("/api/status")["deployments"])
            # Upgrade while running, then reopen with the same saved registry.
            install(installer)
            if baseline:
                assert (app / "build.json").read_bytes() != old_build, (
                    "Upgrade did not replace the baseline payload"
                )
            execute(launch())
            assert any(d["id"] == ident for d in request("/api/status")["deployments"])
            assert any(m["local_path"] == str(model) for m in request("/api/models"))
            execute(
                [app / "unins000.exe", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"]
            )
            installed = False
            assert (state / "registry.sqlite3").is_file()
            assert hashlib.sha256(model.read_bytes()).hexdigest() == before
            install(installer)
            installed = True
            execute(launch())
            assert any(d["id"] == ident for d in request("/api/status")["deployments"])
            assert any(m["local_path"] == str(model) for m in request("/api/models"))
            execute(launch("stop"))
            print(
                "PASS: native installer, isolated launch/duplicate/conflict, bundled dashboard, fake inference/streaming, process tree shutdown, restart/upgrade/uninstall/reinstall preservation"
            )
        finally:
            if installed and (app / "Menagerie.exe").exists():
                execute(launch("stop"), success=False)
                execute(
                    [
                        app / "unins000.exe",
                        "/VERYSILENT",
                        "/SUPPRESSMSGBOXES",
                        "/NORESTART",
                    ],
                    success=False,
                )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--worker", type=Path, required=True)
    args = parser.parse_args()
    check(
        args.installer.resolve(),
        args.worker.resolve(),
        args.baseline.resolve() if args.baseline else None,
    )
