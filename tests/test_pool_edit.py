"""Contract tests for the pool-edit contract (Stage 1).

Pin the three pool-ownership rules the model-first dashboard must honor:
``eligible_for_pool`` (deterministic, hard-error native-pool matching),
``action_scope`` (a pool action is always whole-pool, never per-model), and
``eviction_candidates`` (policy-gated, consent-required idle candidates).
All resources are synthetic; nothing is started, stopped, or inferred.
"""

import pytest
from test_controlplane import port, seed

from controlplane import deployment_sets, pool_edit
from controlplane.api import create_app


@pytest.fixture
async def pool(tmp_path):
    app = create_app(tmp_path / "state")
    store = app.state.store
    await seed(store, tmp_path)
    # synthetic runtimes to exercise the runtime/build + protocol dimensions
    for rid, ek, router in (
        ("other", "native", True),
        ("docker", "docker", False),
        ("norouter", "native", False),
    ):
        store.put(
            "runtime",
            {
                "id": rid,
                "name": rid,
                "engine": "llama.cpp",
                "execution_kind": ek,
                "executable": "/bin/" + rid if ek == "native" else "@sha256:0" * 64,
                "trust": True,
                "capabilities": {"formats": ["gguf"], "mechanisms": {"router": router}},
            },
        )
    store.put(
        "artifact",
        {
            "id": "saf",
            "name": "saf",
            "format": "safetensors",
            "local_path": str(tmp_path / "x"),
            "size_bytes": 1,
        },
    )
    u = store.put(
        "deployment_set",
        {
            "id": "pool",
            "name": "Pool",
            "engine_pool": True,
            "max_loaded": 2,
            "member_ids": ["a", "b"],
            "residency": "on-demand",
            "idle_timeout": 300,
            "priority": 50,
            "enabled": True,
            "queue_timeout": 5,
            "allow_eviction": True,
        },
    )
    for ident in ("a", "b"):
        d = store.get("deployment", ident)
        store.put("deployment", d | {k: u[k] for k in deployment_sets.POLICY_KEYS})
    # a standalone (single-member, not in a pool) unit for member-level scope
    prof = {
        "id": "z",
        "name": "Z",
        "artifact_id": "weights",
        "runtime_id": "runtime",
        "config": {},
        "raw_args": [],
        "catalog": {},
    }
    store.put("profile", prof)
    store.put(
        "deployment",
        {
            "id": "z",
            "name": "Z",
            "alias": "z",
            "port": port(),
            "profile_id": "z",
            "profile_snapshot": prof,
            "state": "STOPPED",
            "residency": "on-demand",
            "priority": 50,
            "idle_timeout": 300,
            "allow_eviction": True,
            "enabled": True,
            "gpu": 0,
            "queue_timeout": 5,
        },
    )
    return app, store


def unit(store, ident):
    return deployment_sets.unit_for(store, ident)


def proposed(store, **kw):
    a = store.get("deployment", "a")
    member = {
        "id": "proposed",
        "name": "Proposed",
        "alias": "c",
        "gpu": a["gpu"],
        "residency": "on-demand",
        "priority": 50,
        "profile_id": "c",
        "profile_snapshot": {**a["profile_snapshot"], "id": "c", "name": "Proposed"},
    }
    for key in ("runtime_id", "artifact_id"):
        if key in kw:
            member["profile_snapshot"][key] = kw.pop(key)
    if "config" in kw:
        member["profile_snapshot"]["config"] = dict(kw.pop("config"))
    if "raw_args" in kw:
        member["profile_snapshot"]["raw_args"] = list(kw.pop("raw_args"))
    member.update(kw)
    return member


# --- eligible_for_pool -------------------------------------------------------


async def test_eligible_member_fits_default_pool(pool):
    _, store = pool
    assert (
        pool_edit.eligible_for_pool(proposed(store), unit(store, "pool"), store) == []
    )


async def test_different_runtime_is_a_hard_error(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, runtime_id="other"), unit(store, "pool"), store
    )
    assert any("different runtime installation" in e for e in errors)


async def test_container_runtime_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, runtime_id="docker"), unit(store, "pool"), store
    )
    assert any("not a container" in e for e in errors)


async def test_non_router_runtime_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, runtime_id="norouter"), unit(store, "pool"), store
    )
    assert any("does not advertise model routing" in e for e in errors)


async def test_unknown_runtime_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, runtime_id="missing"), unit(store, "pool"), store
    )
    assert any("Unknown runtime installation" in e for e in errors)


async def test_device_mismatch_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, gpu=1), unit(store, "pool"), store
    )
    assert any("device visibility must match" in e for e in errors)


async def test_unsupported_format_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, artifact_id="saf"), unit(store, "pool"), store
    )
    assert any("not supported by the runtime" in e for e in errors)


async def test_raw_args_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, raw_args=["--foo"]), unit(store, "pool"), store
    )
    assert any("raw arguments" in e for e in errors)


async def test_shared_router_setting_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, config={"models-max": 2}), unit(store, "pool"), store
    )
    assert any("Shared router settings" in e for e in errors)


async def test_conflicting_residency_rejected(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(store, residency="pinned"), unit(store, "pool"), store
    )
    assert any("on-demand" in e and "residency" in e for e in errors)


async def test_multiple_incompatibilities_all_reported(pool):
    _, store = pool
    errors = pool_edit.eligible_for_pool(
        proposed(
            store,
            runtime_id="missing",
            raw_args=["--x"],
            config={"models-max": 1},
            residency="pinned",
        ),
        unit(store, "pool"),
        store,
    )
    assert len(errors) >= 4
    assert any("Unknown runtime" in e for e in errors)
    assert any("raw arguments" in e for e in errors)
    assert any("Shared router settings" in e for e in errors)
    assert any("on-demand" in e for e in errors)


# --- action_scope ------------------------------------------------------------


async def test_pool_action_is_whole_unit_not_per_model(pool):
    _, store = pool
    scope = pool_edit.action_scope("stop", "pool", store)
    assert scope["multi_model"] is True
    assert scope["is_whole_unit"] is True
    assert scope["member_level"] is False
    assert scope["member_ids"] == ["a", "b"]
    assert scope["affects_count"] == 2
    # A per-member request still has whole-pool scope.
    scope = pool_edit.action_scope("stop", "pool", store, member_id="a")
    assert scope["is_whole_unit"] is True
    assert scope["member_ids"] == ["a", "b"]
    assert "all 2 models" in scope["scope_label"]
    assert "model 'a'" not in scope["scope_label"]  # never a per-model unload


async def test_standalone_action_is_member_level(pool):
    _, store = pool
    scope = pool_edit.action_scope("stop", "z", store, member_id="z")
    assert scope["multi_model"] is False
    assert scope["is_whole_unit"] is False
    assert scope["member_level"] is True
    assert scope["member_ids"] == ["z"]
    assert scope["affects_count"] == 1


async def test_member_not_in_unit_rejected(pool):
    _, store = pool
    with pytest.raises(ValueError, match="not part of"):
        pool_edit.action_scope("stop", "pool", store, member_id="z")  # z is standalone


async def test_unknown_unit_rejected(pool):
    _, store = pool
    with pytest.raises(ValueError, match="Unknown unit"):
        pool_edit.action_scope("stop", "nope", store)


# --- eviction_candidates ------------------------------------------------------


@pytest.fixture
async def eviction(tmp_path):
    app = create_app(tmp_path / "state")
    store = app.state.store
    await seed(store, tmp_path)

    def standalone(ident, **kw):
        prof = {
            "id": "p" + ident,
            "name": ident,
            "artifact_id": "weights",
            "runtime_id": "runtime",
            "config": {},
            "raw_args": [],
            "catalog": {},
        }
        store.put("profile", prof)
        store.put(
            "deployment",
            {
                "id": ident,
                "name": ident,
                "alias": ident,
                "port": port(),
                "profile_id": "p" + ident,
                "profile_snapshot": prof,
                "state": kw.pop("state", "READY"),
                "residency": kw.pop("residency", "on-demand"),
                "priority": kw.pop("priority", 50),
                "idle_timeout": kw.pop("idle_timeout", 300),
                "allow_eviction": kw.pop("allow_eviction", True),
                "enabled": True,
                "gpu": 0,
                "queue_timeout": 5,
            },
        )

    standalone("new", priority=80)  # the work being started
    standalone("cand", priority=30)  # the eligible candidate
    standalone("pinned", residency="pinned")  # pinned => never evicted
    standalone("busy", priority=30)  # busy => excluded
    standalone("fresh", priority=30)  # not idle => excluded
    standalone("noconsent", priority=30, allow_eviction=False)
    standalone("higher", priority=80)  # >= incoming bar => excluded
    standalone("unloaded", priority=30, state="STOPPED")  # not loaded
    return app, store


def _units(store, *ids):
    return [deployment_sets.unit_for(store, i) for i in ids]


async def test_eviction_policy_gates_to_one_candidate(eviction):
    _, store = eviction
    now = 1000.0
    last_use = {
        "cand": 0.0,
        "pinned": 0.0,
        "busy": 0.0,
        "fresh": 950.0,
        "noconsent": 0.0,
        "higher": 0.0,
        "unloaded": 0.0,
        "new": 0.0,
    }
    result = pool_edit.eviction_candidates(
        _units(
            store,
            "cand",
            "pinned",
            "busy",
            "fresh",
            "noconsent",
            "higher",
            "unloaded",
            "new",
        ),
        selected_ids=["new"],
        inflight={"busy": 1},
        last_use=last_use,
        now=now,
    )
    assert [c["unit_id"] for c in result] == ["cand"]
    c = result[0]
    assert c["requires_consent"] is True
    assert c["evictable_members"] == ["cand"]
    assert c["priority"] == 30
    assert c["residency"] == "on-demand"


async def test_selected_work_never_evicted(eviction):
    _, store = eviction
    now = 1000.0
    last_use = {"new": 0.0, "cand": 0.0}
    # "new" is itself a good candidate (priority 80, allowed, idle) but is the
    # work being started, so it must never appear as an eviction target.
    result = pool_edit.eviction_candidates(
        _units(store, "new", "cand"),
        selected_ids=["new"],
        last_use=last_use,
        now=now,
    )
    assert "new" not in [c["unit_id"] for c in result]
    assert [c["unit_id"] for c in result] == ["cand"]


async def test_eviction_orders_most_idle_first(tmp_path):
    app = create_app(tmp_path / "state")
    store = app.state.store
    await seed(store, tmp_path)

    def standalone(ident, priority=30):
        prof = {
            "id": "p" + ident,
            "name": ident,
            "artifact_id": "weights",
            "runtime_id": "runtime",
            "config": {},
            "raw_args": [],
            "catalog": {},
        }
        store.put("profile", prof)
        store.put(
            "deployment",
            {
                "id": ident,
                "name": ident,
                "alias": ident,
                "port": port(),
                "profile_id": "p" + ident,
                "profile_snapshot": prof,
                "state": "READY",
                "residency": "on-demand",
                "priority": priority,
                "idle_timeout": 300,
                "allow_eviction": True,
                "enabled": True,
                "gpu": 0,
                "queue_timeout": 5,
            },
        )

    standalone("oldest")
    standalone("recent")
    now = 2000.0
    last_use = {"oldest": 100.0, "recent": 900.0}  # oldest idle 1900s, recent 1100s
    result = pool_edit.eviction_candidates(
        _units(store, "oldest", "recent"),
        selected_ids=["none-exists"],
        last_use=last_use,
        now=now,
    )
    assert [c["unit_id"] for c in result] == ["oldest", "recent"]
    assert result[0]["idle_seconds"] >= result[1]["idle_seconds"]


async def test_priority_gate_never_evicts_higher_priority_work(eviction):
    _, store = eviction
    now = 1000.0
    last_use = {"cand": 0.0, "higher": 0.0}
    # Incoming bar = priority of "new" (80); "higher" (80) is not strictly below.
    result = pool_edit.eviction_candidates(
        _units(store, "new", "cand", "higher"),
        selected_ids=["new"],
        last_use=last_use,
        now=now,
    )
    assert [c["unit_id"] for c in result] == ["cand"]
