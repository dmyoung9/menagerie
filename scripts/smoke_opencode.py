"""Opt-in real inference check. Downloads CPU engine + small model into temp storage.

Run with an installed Menagerie interpreter: python -I scripts/smoke_opencode.py
Requires OpenCode V2 on PATH. Uses private state/config and a standalone client.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile

import httpx
import uvicorn

from controlplane.api import create_app
from controlplane.jobs import Jobs
from controlplane.managed_engines import catalog, install
from controlplane.plugin_install import manage
from controlplane import telemetry


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def main():
    opencode = shutil.which("opencode")
    if not opencode:
        raise RuntimeError("OpenCode V2 is required")
    with tempfile.TemporaryDirectory(prefix="menagerie-client-check-", dir=os.environ.get("TMPDIR")) as temporary:
        root = Path(temporary)
        port = free_port()
        app = create_app(root / "state", gateway_port=port)
        manager = app.state.manager
        manager.host = telemetry.sample()
        jobs = Jobs(manager)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
        task = None
        process = None
        try:
            manager.store.put("job", {"id": "verify", "state": "RUNNING"})
            releases = await catalog(manager.client, manager.store)
            recipe = next(r for e in releases["engines"] if e["id"] == "llama.cpp" for r in e["releases"] if r["backend"] == "cpu")
            runtime = await install(jobs, "verify", recipe["id"])
            repo = "Qwen/Qwen2.5-0.5B-Instruct-GGUF"
            files = await jobs.hf_files(repo, "main")
            filename = next(f["name"] for f in files["files"] if f["name"].lower().endswith("q4_k_m.gguf"))
            artifact = await jobs.download("verify", repo, files["revision"], filename)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
                token = (await client.get("/api/status")).json()["csrf_token"]
                response = await client.post("/api/deployments", headers={"X-Menagerie-Token": token}, json={
                    "name": "OpenCode smoke", "alias": "client-check", "port": free_port(), "residency": "on-demand",
                    "configuration": {"name": "Qwen", "artifact_id": artifact["id"], "runtime_id": runtime["id"],
                                      "config": {"ctx-size": 8192, "parallel": 1, "gpu-layers": "0", "threads": 4},
                                      "catalog": {"model": {"limit": {"context": 8192, "output": 32}}}}})
                response.raise_for_status()
            config = root / "config/opencode"
            config.mkdir(parents=True)
            (config / "opencode.json").write_text(json.dumps({"agents": {"verify": {
                "system": "Answer briefly. Do not use tools.", "steps": 2,
                "permissions": [{"action": "*", "resource": "*", "effect": "deny"}]}}}))
            manage("install", config, port)
            env = {k: v for k, v in os.environ.items() if k in {"PATH", "LANG", "LD_LIBRARY_PATH"}}
            env.update(HOME=str(root / "home"), XDG_CONFIG_HOME=str(root / "config"),
                       XDG_DATA_HOME=str(root / "data"), XDG_STATE_HOME=str(root / "client-state"),
                       XDG_CACHE_HOME=str(root / "cache"), OPENCODE_CONFIG_DIR=str(config))
            (root / "home").mkdir()
            task = asyncio.create_task(server.serve())
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError("Verification server exited")
                await asyncio.sleep(.05)
            print("Running isolated OpenCode request…", flush=True)
            process = await asyncio.create_subprocess_exec(opencode, "run", "--standalone", "--agent", "verify",
                "--model", "menagerie/client-check", "--title", "Menagerie inference verification", "--format", "json", "Reply with a short greeting.",
                cwd=root, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            output, _ = await asyncio.wait_for(process.communicate(), 180)
            text = output.decode(errors="replace")
            print(text, flush=True)
            events = [json.loads(line) for line in text.splitlines() if line.startswith("{")]
            if not any(e.get("type") == "text" and e.get("part", {}).get("text", "").strip() for e in events):
                raise RuntimeError("OpenCode did not display the generated response")
            with manager.store.connect() as connection:
                requests = [json.loads(row[0]) for row in connection.execute("SELECT data FROM requests")]
            if process.returncode or not any(r["error"] is None and (r.get("output_tokens") or 0) > 0 for r in requests):
                raise RuntimeError("OpenCode did not complete a gateway inference request")
            print(json.dumps({"result": "passed", "engine": recipe["version"], "model_revision": files["revision"],
                              "gateway_requests": len(requests), "output_tokens": [r.get("output_tokens") for r in requests]}))
        finally:
            if process and process.returncode is None:
                process.kill()
                await process.wait()
            server.should_exit = True
            if task:
                await task
            await manager.close()


if __name__ == "__main__":
    asyncio.run(main())
