"""Stage-4 desired/applied endpoints: read status, the explicit "apply when
idle" job, concurrent conflict, cancellation, and discard.

No process is started. The manager's ``validate``/``stop``/``activate`` are
replaced with controlled fakes so the queued-apply job can run to completion
without inference, and job *spawning* is captured (not run) so that after a
``request-apply`` the operation is deterministically ``QUEUED`` for the
concurrent-conflict assertion."""

import httpx

from controlplane import apply_ops as aops
from controlplane.api import create_app

DEPLOY_ID = "model-a"


def make_app(tmp_path):
    app = create_app(tmp_path / "api")
    store = app.state.store
    d = store.put(
        "deployment",
        {
            "id": DEPLOY_ID,
            "name": "Alpha",
            "alias": "alpha",
            "port": 8130,
            "profile_id": "profile-a",
            "profile_snapshot": {
                "id": "profile-a",
                "name": "Alpha",
                "artifact_id": "artifact-a",
                "runtime_id": "runtime-a",
                "config": {"ctx-size": 8192},
                "raw_args": [],
                "catalog": {},
            },
            "state": "STOPPED",
            "residency": "on-demand",
            "priority": 50,
            "gpu": None,
            "enabled": True,
            "allow_eviction": False,
            "idle_timeout": 300,
            "queue_timeout": 5,
            "reservation_active": 0,
        },
    )
    # Simulate the unit's first activation so an applied baseline exists: a
    # never-activated unit is never "pending", so we need one to see pending
    # semantics.
    aops.record_applied(store, app.state.manager.unit(DEPLOY_ID))
    return app, d


async def build_client(app):
    """Return an *open* ASGI client with an auth token; the caller closes it."""
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )
    client.headers["X-Menagerie-Token"] = (await client.get("/api/status")).json()[
        "csrf_token"
    ]
    return client


def set_config(app, ctx_size):
    """Change the deployment's stored config (the "user edited it" step)."""
    store = app.state.store
    d = store.get("deployment", DEPLOY_ID)
    store.put(
        "deployment",
        {
            **d,
            "profile_snapshot": {
                **d["profile_snapshot"],
                "config": {**d["profile_snapshot"]["config"], "ctx-size": ctx_size},
            },
        },
        historical=False,
    )


def wire_fakes(manager, store, monkeypatch):
    """Replace the manager's process-level methods with deterministic fakes."""
    spawned = []

    def fake_spawn(coro):
        # Capture instead of running: the op stays in whatever state the
        # endpoint left it (QUEUED after request-apply), which is exactly what
        # the concurrent-conflict assertion needs.
        spawned.append(coro)
        return coro

    monkeypatch.setattr(manager, "spawn", fake_spawn)

    def fake_validate(ids, authorized_stops=None):
        return {
            "errors": [],
            "warnings": [],
            "estimates": {},
            "plan_token": "tok-1",
            "impact": "Stops lose KV caches.",
        }

    monkeypatch.setattr(manager, "validate", fake_validate)

    async def fake_stop(ident, cancel_requests=False, progress=None):
        # No process to drain; the "hold new requests" deadline is irrelevant.
        return

    monkeypatch.setattr(manager, "stop", fake_stop)

    async def fake_activate(ids, override=False, authorized_stops=None, token=None):
        assert token == "tok-1", f"activate called with token {token!r}"
        for i in ids:
            store.put(
                "deployment",
                store.get("deployment", i) | {"state": "READY"},
                historical=False,
            )

    monkeypatch.setattr(manager, "activate", fake_activate)
    return spawned


async def test_read_endpoints_report_pending_scope_and_eligibility(
    tmp_path, monkeypatch
):
    app, d = make_app(tmp_path)
    manager = app.state.manager
    wire_fakes(manager, app.state.store, monkeypatch)
    client = await build_client(app)
    base = f"/api/deployments/{DEPLOY_ID}"
    try:
        # No *pending* change: the op (from the simulated activation) is a
        # resolved APPLIED one, desired == applied, unit not pending.
        r = await client.get(f"{base}/pending")
        assert r.status_code == 200
        body = r.json()
        assert body["pending"] is False
        assert body["applied_rev"] is not None
        assert body["desired_rev"] == body["applied_rev"]
        assert body["unit_id"] == DEPLOY_ID
        assert body["multi_model"] is False
        assert body["affected_ids"] == [DEPLOY_ID]
        assert body["affected"] == ["Alpha"]
        if body["op"] is not None:
            assert body["op"]["state"] == "applied"

        # Honest action scope for a standalone (single-member) unit.
        r = await client.get(f"{base}/action-scope", params={"action": "stop"})
        assert r.status_code == 200
        body = r.json()
        assert body["unit_id"] == DEPLOY_ID
        assert body["member_level"] is True
        assert body["is_whole_unit"] is False
        assert body["multi_model"] is False
        assert body["affects_count"] == 1
        # The label is the action's honest label ("unload") plus the member
        # name — never a member-level claim on a whole unit.
        label = body["scope_label"]
        assert isinstance(label, str) and "unload" in label and "Alpha" in label

        # A standalone unit is trivially eligible.
        r = await client.get(f"{base}/eligibility")
        assert r.status_code == 200
        body = r.json()
        assert body["eligible"] is True
        assert body["errors"] == []

        # Nothing else to evict (the unit being loaded is never a candidate).
        r = await client.get(f"{base}/eviction-candidates")
        assert r.status_code == 200
        body = r.json()
        assert body["candidates"] == []
        assert body["count"] == 0
    finally:
        await client.aclose()


async def test_save_apply_cycle_and_concurrent_conflict(tmp_path, monkeypatch):
    app, d = make_app(tmp_path)
    manager = app.state.manager
    spawned = wire_fakes(manager, app.state.store, monkeypatch)
    client = await build_client(app)
    base = f"/api/deployments/{DEPLOY_ID}"
    try:
        set_config(app, 16384)

        # Save moves desired only; the op is pending but the unit is not yet
        # in-flight.
        r = await client.post(f"{base}/save-desired", json={})
        assert r.status_code == 200
        assert r.json()["op"]["state"] == "pending"
        assert r.json()["op"]["token"] is None
        assert r.json()["op"]["scope_fingerprint"] is None

        r = await client.get(f"{base}/pending")
        body = r.json()
        assert body["pending"] is True
        assert body["op"]["state"] == "pending"
        assert body["applied_rev"] is not None
        assert body["desired_rev"] != body["applied_rev"]
        assert body["scope_fingerprint"] == aops.scope_fingerprint(
            manager.unit(DEPLOY_ID)
        )

        # Review + queue. The job is captured (not running), so the op is
        # deterministically QUEUED.
        fp = aops.scope_fingerprint(manager.unit(DEPLOY_ID))
        r = await client.post(
            f"{base}/request-apply",
            json={"token": "tok-1", "scope_fingerprint": fp},
        )
        assert r.status_code == 200
        assert r.json()["op"]["state"] == "queued"
        assert r.json()["op"]["token"] == "tok-1"
        assert r.json()["op"]["scope_fingerprint"] == fp
        job_id = r.json()["job_id"]

        # A concurrent save while the apply is in flight is a hard conflict,
        # not a silent overwrite.
        r = await client.post(f"{base}/save-desired", json={})
        assert r.status_code == 409
        assert "already being applied" in r.json()["error"].lower()

        # Release the captured job and let the apply run to completion.
        await spawned[0]
        job = app.state.store.get("job", job_id)
        assert job["state"] == "SUCCEEDED"
        assert job.get("error") is None

        r = await client.get(f"{base}/pending")
        body = r.json()
        assert body["pending"] is False
        # A resolved *applied* op carries no in-flight consent: the reviewed
        # token and scope fingerprint gated the in-flight phase and are gone
        # once the change is recorded as what is running.
        assert body["op"]["state"] == "applied"
        assert body["op"]["token"] is None
        assert body["applied_rev"] == body["desired_rev"]
        # The applied change is now what the unit executes.
        dnow = app.state.store.get("deployment", DEPLOY_ID)
        assert dnow["state"] == "READY"
        assert dnow["profile_snapshot"]["config"] == {"ctx-size": 16384}
    finally:
        await client.aclose()


async def test_stale_scope_fingerprint_is_rejected_at_review(tmp_path, monkeypatch):
    app, d = make_app(tmp_path)
    manager = app.state.manager
    wire_fakes(manager, app.state.store, monkeypatch)
    client = await build_client(app)
    base = f"/api/deployments/{DEPLOY_ID}"
    try:
        set_config(app, 16384)
        s = await client.post(f"{base}/save-desired", json={})
        assert s.status_code == 200

        # A stale (wrong) scope fingerprint must be refused at review time.
        r = await client.post(
            f"{base}/request-apply",
            json={"token": "tok-user", "scope_fingerprint": "not-a-fingerprint"},
        )
        assert r.status_code == 409
        assert "pool changed since the review" in r.json()["error"].lower()
    finally:
        await client.aclose()


async def test_cancel_keeps_change_pending_and_discard_restores(tmp_path, monkeypatch):
    app, d = make_app(tmp_path)
    manager = app.state.manager
    spawned = wire_fakes(manager, app.state.store, monkeypatch)
    client = await build_client(app)
    base = f"/api/deployments/{DEPLOY_ID}"
    try:
        set_config(app, 16384)
        s = await client.post(f"{base}/save-desired", json={})
        assert s.status_code == 200
        fp = aops.scope_fingerprint(manager.unit(DEPLOY_ID))
        r = await client.post(
            f"{base}/request-apply", json={"token": "tok-1", "scope_fingerprint": fp}
        )
        assert r.status_code == 200
        job_id = r.json()["job_id"]

        # Cancel before the restart begins; the saved change remains pending.
        r = await client.post(f"{base}/cancel", json={})
        assert r.status_code == 200
        assert r.json()["op"]["state"] == "cancelled"
        assert (await client.get(f"{base}/pending")).json()["pending"] is True

        # Discard restores the last applied configuration and clears the op.
        r = await client.post(f"{base}/discard", json={})
        assert r.json()["restored"] is not None
        assert r.json()["scope_fingerprint"] == fp
        restored = app.state.store.get("deployment", DEPLOY_ID)
        # config must be back to the original applied value (ctx-size 8192).
        assert restored["profile_snapshot"]["config"] == {"ctx-size": 8192}
        body = (await client.get(f"{base}/pending")).json()
        assert body["pending"] is False
        assert body["op"] is None

        # The cancelled op cannot be applied: running the captured job must
        # refuse (not a queued op) and the job must end FAILED, not SUCCEEDED.
        await spawned[0]
        assert app.state.store.get("job", job_id)["state"] == "FAILED"
    finally:
        await client.aclose()
