"""Opt-in managed vLLM GPU smoke; downloads several GB into temporary storage."""
import asyncio
import json
import os
from pathlib import Path
import socket
import tempfile

import httpx

from controlplane.api import create_app
from controlplane.jobs import Jobs
from controlplane.managed_engines import catalog, install
from controlplane import telemetry


async def main():
    baseline = telemetry.sample()
    gpu = next((g for g in baseline.get("gpus", []) if g["index"] == 0), None)
    if not gpu or gpu["free_mib"] < gpu["total_mib"] * .35 + 2048:
        raise RuntimeError("Insufficient GPU capacity for a 35% allocation plus 2 GiB desktop reserve")
    with tempfile.TemporaryDirectory(prefix="menagerie-vllm-check-", dir=os.environ.get("TMPDIR")) as temporary:
        app = create_app(Path(temporary) / "state")
        manager = app.state.manager
        jobs = Jobs(manager)
        try:
            await manager.start()
            manager.store.put("job", {"id": "verify", "state": "RUNNING"})
            releases = await catalog(manager.client, manager.store)
            recipe = next(r for e in releases["engines"] if e["id"] == "vllm" for r in e["releases"])
            print(f"Installing isolated vLLM {recipe['version']}…", flush=True)
            runtime = await install(jobs, "verify", recipe["id"])
            repo = "Qwen/Qwen2.5-0.5B-Instruct"
            files = await jobs.hf_files(repo, "main")
            artifact = await jobs.download("verify", repo, files["revision"], "__safetensors__")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver", timeout=360) as client:
                token = (await client.get("/api/status")).json()["csrf_token"]
                response = await client.post("/api/deployments", headers={"X-Menagerie-Token": token}, json={
                    "name": "vLLM verification", "alias": "vllm-check", "port": port, "residency": "on-demand",
                    "configuration": {"name": "Qwen", "artifact_id": artifact["id"], "runtime_id": runtime["id"],
                                      "config": {"max-model-len": 2048, "gpu-memory-utilization": .35}}})
                if response.status_code != 200:
                    raise RuntimeError(f"Deployment rejected: {response.text}")
                ident = response.json()["id"]
                await manager.activate([ident])
                response = await client.post("/v1/chat/completions", json={"model": "vllm-check", "messages": [{"role": "user", "content": "Say hello."}], "max_tokens": 16})
                response.raise_for_status()
                assert response.json()["choices"][0]["message"]["content"]
                print(json.dumps({"result": "passed", "version": recipe["version"], "model_revision": files["revision"], "usage": response.json()["usage"]}), flush=True)
                await manager.stop(ident)
        except BaseException:
            for path in (Path(temporary) / "state").rglob("runtime.log"):
                print(path.read_text(errors="replace")[-6000:], flush=True)
            raise
        finally:
            await manager.close()
    print("Final GPU state:", telemetry.sample().get("gpus"), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
