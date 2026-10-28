import httpx
import pytest

from controlplane.api import create_app


@pytest.mark.asyncio
async def test_lan_dashboard_does_not_expose_inference(tmp_path):
    app = create_app(tmp_path, dashboard_address="192.168.0.10")
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://192.168.0.10:8017"
        ) as client:
            status = await client.get("/api/status")
            assert status.status_code == 200
            assert (await client.get("/v1/models")).status_code == 403
            assert (await client.get("/models")).status_code == 403
            assert (
                await client.post("/v1/chat/completions", json={})
            ).status_code == 403
            assert (
                await client.get(
                    "/v1/models",
                    headers={"Host": "localhost", "X-Forwarded-For": "127.0.0.1"},
                )
            ).status_code == 403
            assert (await client.post("/api/backup", json={})).status_code == 403
            assert (
                await client.get("/api/status", headers={"Origin": "http://other.test"})
            ).status_code == 403
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:8001"
        ) as client:
            assert (await client.get("/v1/models")).status_code == 200
    finally:
        await app.state.manager.close()
