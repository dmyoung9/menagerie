"""Opt-in real inference check. Never collected by pytest or run by CI.

Uses explicit aliases; on-demand requests may load models under saved policies.
Does not revise configuration or restart deployments.
"""
import argparse
import asyncio
import json
import time
import httpx


async def run(args):
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{args.gateway_port}", trust_env=False, timeout=360) as client:
        async def infer(alias):
            started = time.monotonic()
            response = await client.post("/v1/chat/completions", json={"model": alias, "messages": [{"role": "user", "content": "Reply with the single word READY."}], "max_tokens": 128})
            response.raise_for_status()
            message = response.json()["choices"][0]["message"]
            if "READY" not in (message.get("content") or ""):
                raise RuntimeError(f"{alias}: expected READY in response")
            return {"alias": alias, "latency_s": time.monotonic() - started, "usage": response.json().get("usage")}
        print(json.dumps({"requests": await asyncio.gather(*(infer(alias) for alias in args.alias)),
                          "scope": "Short concurrent inference only; not context-limit, tools, streaming, cancellation, or quality acceptance."}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--alias", action="append", required=True, help="API alias; repeat for concurrent requests")
    parser.add_argument("--gateway-port", type=int, default=8001)
    args = parser.parse_args()
    asyncio.run(run(args))
