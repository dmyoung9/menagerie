"""Manual unload drains admissions; interruption always requires explicit consent."""

import asyncio

import httpx
import pytest
from test_controlplane import baseline, seed

from controlplane.api import create_app
from controlplane.manager import Conflict


async def prepared(tmp_path):
    app = create_app(tmp_path / "state")
    await seed(app.state.store, tmp_path)
    manager = app.state.manager
    manager.host = baseline()
    await manager.activate(["a"])
    return app, manager, await manager.acquire("a")


async def test_graceful_unload_pauses_admission_reports_waiting_and_finishes(tmp_path):
    app, manager, request = await prepared(tmp_path)
    waiting = asyncio.Event()

    def progress(text):
        if "Waiting" in text:
            waiting.set()

    stop = asyncio.create_task(manager.stop("a", progress=progress))
    try:
        await asyncio.wait_for(waiting.wait(), 5)
        assert manager.owned(request)
        with pytest.raises(Conflict, match="unloading"):
            await manager.acquire("a")
        with pytest.raises(Conflict, match="unloading"):
            await manager.activate(["a"])
        with pytest.raises(Conflict, match="already waiting"):
            await manager.stop("a")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            status = (await client.get("/api/status")).json()
            assert next(d for d in status["serving_deployments"] if d["id"] == "a")[
                "draining"
            ]
        manager.release(request)
        await asyncio.wait_for(stop, 5)
        assert app.state.store.get("deployment", "a")["state"] == "STOPPED"
        assert not manager.draining
        assert not manager.owned(request)
    finally:
        if not stop.done():
            stop.cancel()
            await asyncio.gather(stop, return_exceptions=True)
        await manager.close()


async def test_explicit_cancellation_escalates_a_waiting_unload_without_faking_release(
    tmp_path,
):
    app, manager, request = await prepared(tmp_path)
    waiting = asyncio.Event()
    stop = asyncio.create_task(manager.stop("a", progress=lambda _: waiting.set()))
    try:
        await asyncio.wait_for(waiting.wait(), 5)
        await manager.stop("a", cancel_requests=True)
        assert not manager.owned(request)
        assert app.state.store.get("deployment", "a")["state"] == "STOPPED"
        assert manager.inflight["a"] == 1  # Only the gateway completion releases this.
        manager.release(request)
        await asyncio.wait_for(stop, 5)
        assert not manager.draining
    finally:
        if not stop.done():
            stop.cancel()
            await asyncio.gather(stop, return_exceptions=True)
        await manager.close()


async def test_abandoned_unload_resumes_admission_without_killing_requests(tmp_path):
    _, manager, request = await prepared(tmp_path)
    waiting = asyncio.Event()
    stop = asyncio.create_task(manager.stop("a", progress=lambda _: waiting.set()))
    try:
        await asyncio.wait_for(waiting.wait(), 5)
        stop.cancel()
        await asyncio.gather(stop, return_exceptions=True)
        assert not manager.draining
        assert manager.owned(request)
        second = await manager.acquire("a")
        manager.release(second)
        manager.release(request)
    finally:
        await manager.close()


async def test_cancel_flag_requires_boolean_and_bad_input_does_not_queue_work(tmp_path):
    app = create_app(tmp_path / "state")
    await seed(app.state.store, tmp_path)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            token = (await client.get("/api/status")).json()["csrf_token"]
            for path in ("deployments", "serving-deployments"):
                response = await client.post(
                    f"/api/{path}/a/stop",
                    json={"cancel_requests": "yes"},
                    headers={"X-Menagerie-Token": token},
                )
                assert response.status_code == 400
            assert app.state.store.list("job") == []
    finally:
        await app.state.manager.close()
