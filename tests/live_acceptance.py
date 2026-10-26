"""Explicit live acceptance runner. Not collected by pytest; changes only the named pair.

Run with --tune-pair to stop/revise/restart each paired deployment independently.
The old imported profiles remain intact. Never run against an unrelated host.
"""
import argparse
import asyncio
import json
import time
from pathlib import Path
import httpx

BASE = "http://127.0.0.1:8017"
PAIR = ["shelf-bonsai-qwen38-trial", "shelf-bonsai9b-qwen38-trial"]
FIELDS = ["id", "name", "profile_id", "alias", "port", "residency", "priority", "idle_timeout", "reservation_mib", "allow_eviction", "allow_uncertain", "enabled", "gpu", "queue_timeout"]


async def main(tune=False):
    async with httpx.AsyncClient(base_url=BASE, trust_env=False, timeout=360) as c:
        c.headers["X-Menagerie-Token"] = (await c.get("/api/status")).json()["csrf_token"]
        async def post(path, body):
            r = await c.post(path, json=body)
            r.raise_for_status()
            return r.json()
        async def wait(job):
            async with c.stream("GET", "/api/events/stream") as response:
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    event = json.loads(line[6:])
                    if event.get("kind") == "job" and event["data"]["id"] == job["id"]:
                        if event["data"]["state"] != "SUCCEEDED":
                            jobs = (await c.get("/api/registry/jobs")).json()
                            raise RuntimeError(next(j for j in jobs if j["id"] == job["id"]))
                        return
        if tune:
            for ident in PAIR:
                deployments = (await c.get("/api/deployments")).json()
                d = next(d for d in deployments if d["id"] == ident)
                other = next(d for d in deployments if d["id"] in PAIR and d["id"] != ident)
                other_pid = other["pid"]
                await wait(await post(f"/api/deployments/{ident}/stop", {}))
                p = d["profile_snapshot"]
                p = {k: p[k] for k in ("id", "name", "artifact_id", "runtime_id", "config", "raw_args", "catalog")}
                p["name"] = p["name"].replace("8K", "32K")
                p["config"]["ctx-size"] = 32768
                p["catalog"]["model"]["name"] = p["name"]
                p["catalog"]["model"]["limit"]["output"] = 8192
                await post("/api/profiles", p)
                updated = {k: d[k] for k in FIELDS}
                updated["name"] = p["name"]
                await post("/api/deployments", updated)
                plan = await post(f"/api/deployments/{ident}/validate", {})
                assert not plan["errors"], plan
                await wait(await post(f"/api/deployments/{ident}/start", {"override": True, "plan_token": plan["plan_token"]}))
                other_now = next(d for d in (await c.get("/api/deployments")).json() if d["id"] == other["id"])
                assert other_now["pid"] == other_pid and other_now["state"] == "READY"
                print("Independent revision restart passed:", ident, flush=True)
        async def infer(alias):
            body = {"model": alias, "messages": [{"role": "user", "content": "Reply with the single word READY."}], "chat_template_kwargs": {"enable_thinking": False}, "max_tokens": 32}
            start = time.monotonic()
            r = await c.post("/v1/chat/completions", json=body)
            r.raise_for_status()
            result = r.json()
            assert "READY" in result["choices"][0]["message"]["content"]
            return {"alias": alias, "latency": time.monotonic()-start, "usage": result.get("usage"), "deployment": r.headers.get("x-menagerie-deployment")}
        results = await asyncio.gather(*(infer(i.removeprefix("shelf-")) for i in PAIR))
        status = (await c.get("/api/status")).json()
        assert all(g["free_mib"] >= 2048 for g in status["host"]["gpus"])
        report = {"timestamp": time.time(), "concurrent_requests": results, "hardware": status["host"], "verification_scope": "Configured context accepted, models allocated and short concurrent requests completed. Not a near-limit retrieval or quality evaluation."}
        output = Path.home() / ".local/state/menagerie/live-acceptance.json"
        output.write_text(json.dumps(report, indent=2))
        print(json.dumps({"concurrent_requests": results, "gpus": status["host"]["gpus"], "report": str(output)}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tune-pair", action="store_true")
    args = parser.parse_args()
    asyncio.run(main(args.tune_pair))
