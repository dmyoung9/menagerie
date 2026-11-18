import asyncio
import json
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from . import (
    adapters,
    deployment_sets,
    host,
    lifecycle,
    model_setup,
    pool_edit,
    runtime_protocol,
    templates,
)
from . import apply_ops as aops
from . import queued_apply as qa
from .catalog import apply_reasoning, export_config, normalize
from .jobs import Jobs
from .manager import ACTIVE, Conflict, Manager, redact
from .schema import (
    PROFILE_FIELDS,
    CapabilityPreview,
    Deployment,
    DeploymentSet,
    ResourcePreview,
    Runtime,
    Settings,
    profile_view,
)
from .slug import resolve_alias, slug
from .store import Store, encode, identity, uid
from .version import VERSION

ROOT = Path(__file__).resolve().parent.parent


def host_view(manager, sample_seconds):
    # Augment the raw host snapshot with client-facing staleness. `stale`
    # is true when sampling stopped (missing/old ts) or when the collector
    # is alive but failing (registry work blocked), so a locked store shows
    # as stale rather than presenting a fresh-but-partial snapshot as live.
    ts = manager.host.get("ts")
    if not ts:
        return manager.host | {"age_seconds": None, "stale": True}
    age = max(0.0, time.time() - float(ts))
    return manager.host | {
        "age_seconds": round(age, 1),
        "stale": (
            manager.collector["consecutive_errors"] > 0
            or age > max(10, 2 * float(sample_seconds))
        ),
    }


def create_app(state=None, dashboard_address=None, gateway_port=8001):
    store = Store(host.state_path(state))
    manager = Manager(store)
    gateway_url = f"http://127.0.0.1:{gateway_port}/v1"
    jobs = Jobs(manager)
    csrf = secrets.token_urlsafe(32)
    runtime_schema_tasks = {}

    @asynccontextmanager
    async def lifespan(app):
        os.umask(0o077)
        await manager.start()
        for job in store.list("job"):
            if job["state"] in {"RUNNING", "QUEUED"}:
                store.put(
                    "job",
                    job
                    | {
                        "state": "FAILED",
                        "error": "Daemon interrupted this job; retry explicitly",
                    },
                    historical=False,
                )
        metadata = getattr(app.state, "instance_metadata", None)
        instance_file = store.root / "instance.json"
        try:
            if metadata:
                temporary = instance_file.with_suffix(".tmp")
                temporary.write_text(json.dumps(metadata), encoding="utf-8")
                temporary.replace(instance_file)
            yield
        finally:
            for task in runtime_schema_tasks.values():
                task.cancel()
            await asyncio.gather(*runtime_schema_tasks.values(), return_exceptions=True)
            await manager.close()
            if metadata:
                instance_file.unlink(missing_ok=True)

    app = FastAPI(title="Menagerie Control Plane", version=VERSION, lifespan=lifespan)
    app.state.manager, app.state.store = manager, store

    def deployment_rows():
        settings = manager.settings()
        totals = store.request_totals()
        result = []
        for unit in deployment_sets.units(store):
            for d in unit["members"]:
                published = lifecycle.visible(
                    d
                    | {
                        "state": deployment_sets.state(unit),
                        "enabled": d["enabled"] and unit["enabled"],
                    },
                    settings,
                )
                result.append(
                    model_setup.projection(store, d)
                    | {
                        "unit_id": unit["id"],
                        "unit_name": unit["name"],
                        "engine_pool": bool(unit.get("engine_pool")),
                        "inflight": manager.inflight.get(d["id"], 0),
                        "historical_requests": totals.get(d["id"], 0),
                        "member_availability": not unit["multi_model"]
                        or bool(unit.get("engine_pool")),
                        "draining": bool(manager.draining.get(unit["id"])),
                        "lifecycle": lifecycle.describe(d, settings)
                        | {"serving": published},
                    }
                )
        return result

    def serving_rows():
        totals = store.request_totals()
        return [
            deployment_sets.describe(u, manager.settings(), manager.inflight, totals)
            | {"draining": bool(manager.draining.get(u["id"]))}
            for u in deployment_sets.units(store)
        ]

    def save_set(data, expected=None, c=None):
        if data.get("id") and model_setup.desired(store, data["id"]):
            raise Conflict(
                "Apply or discard pending model changes before editing the shared runtime"
            )
        # Caller owns the admission lock and the registry transaction.
        previous = next(
            (u for u in store.list("deployment_set", c) if u["id"] == data.get("id")),
            None,
        )
        if previous:
            data = previous | data
        if not data.get("engine_pool"):
            raise ValueError("Only native router pools are supported")
        ident = data.setdefault("id", uid())
        data.setdefault("gpu", None)
        if data.get("engine_pool"):
            if (
                not data.get("runtime_id")
                or data.get("port") is None
                or data.get("port") in {8001, 8017}
            ):
                raise ValueError(
                    "A runtime pool requires a runtime installation and a single "
                    "serving port (ports 8001 and 8017 are reserved for Menagerie)"
                )
        if any(d["id"] == ident for d in store.list("deployment", c)):
            raise Conflict("Deployment ID is already used by a model member")
        affected = set(data["member_ids"]) | set(
            previous["member_ids"] if previous else []
        )
        members = [store.get("deployment", i, c) for i in affected]
        from . import runtime_pool

        errors = runtime_pool.validate(
            data
            | {"members": [store.get("deployment", i, c) for i in data["member_ids"]]},
            store,
        )
        if errors:
            raise ValueError("; ".join(errors))
        if any(
            d["state"] in ACTIVE or manager.inflight.get(d["id"], 0) for d in members
        ):
            raise Conflict(
                "Unload all affected models before changing deployment membership or policy"
            )
        for other in store.list("deployment_set", c):
            if other["id"] != ident and set(other["member_ids"]) & set(
                data["member_ids"]
            ):
                raise Conflict("A model can belong to only one deployment")
        saved = store.put("deployment_set", data, expected, c=c)
        for i in data["member_ids"]:
            d = store.get("deployment", i, c)
            mirrored = d | {
                k: saved[k]
                for k in deployment_sets.POLICY_KEYS
                if k != "enabled" or not saved.get("engine_pool")
            }
            # Only write a member that actually changed: adding or editing a
            # sibling must not churn every member's revision.
            if mirrored != d:
                store.put("deployment", mirrored, c=c)
        store.event(
            "deployment_configuration",
            {"name": saved["name"], "members": saved["member_ids"]},
            ident,
            c,
        )
        return saved

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({"error": str(exc)}, status_code=404)

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse(
            {"error": str(exc)}, status_code=409 if isinstance(exc, Conflict) else 400
        )

    @app.middleware("http")
    async def boundary(request, call_next):
        host = request.url.hostname
        allowed_hosts = {
            "127.0.0.1",
            "localhost",
            "openchamber-preview.localhost",
            "testserver",
        }
        if dashboard_address:
            allowed_hosts.add(dashboard_address)
        if host not in allowed_hosts:
            return JSONResponse({"error": "Configured dashboard host required"}, 403)
        # Trust the accepted socket, never Host/Forwarded headers, for isolation.
        local_address = (request.scope.get("server") or (None, None))[0]
        if dashboard_address and local_address == dashboard_address:
            path = request.url.path
            if path == "/models" or path == "/v1" or path.startswith("/v1/"):
                return JSONResponse(
                    {"error": "Inference API is available on loopback only"}, 403
                )
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse({"error": "Same-origin requests required"}, 403)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.url.path.startswith("/api/"):
                if not secrets.compare_digest(
                    request.headers.get("x-menagerie-token", ""), csrf
                ):
                    return JSONResponse(
                        {"error": "Current dashboard token required"}, 403
                    )
            try:
                length = int(request.headers.get("content-length", "0"))
            except ValueError:
                return JSONResponse({"error": "Invalid content length"}, 400)
            if length > 16 * 1024 * 1024:
                return JSONResponse({"error": "Request body exceeds 16 MiB"}, 413)
            if request.headers.get("transfer-encoding"):
                return JSONResponse(
                    {
                        "error": "Content-Length required; chunked request bodies are not accepted"
                    },
                    411,
                )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.post("/api/resources/preview")
    async def resource_preview(body: ResourcePreview):
        from .resources import preview

        return preview(manager, [d.model_dump() for d in body.members])

    @app.get("/api/status")
    async def status():
        # A store lock must not take the health endpoint down: fall back to
        # defaults so /api/status keeps answering and can still report
        # collector degradation.
        try:
            settings = manager.settings()
        except Exception:
            settings = Settings().model_dump()
        return {
            "version": VERSION,
            "instance_id": getattr(app.state, "instance_metadata", {}).get(
                "instance_id"
            ),
            "csrf_token": csrf,
            "host": host_view(manager, settings.get("sample_seconds", 2)),
            "collector": manager.collector,
            "deployments": [
                d | {"inflight": manager.inflight.get(d["id"], 0)}
                for d in deployment_rows()
            ],
            "serving_deployments": serving_rows(),
            "queue": manager.waiting,
            "settings": settings,
            "gateway": "/v1",
            "gateway_url": gateway_url,
            "state_path": str(store.root),
        }

    @app.post("/api/daemon/shutdown")
    async def shutdown(request: Request):
        # A private-LAN dashboard must not stop the local desktop application.
        local = (request.scope.get("server") or (None, None))[0]
        if local not in {"127.0.0.1", "testserver"}:
            raise HTTPException(403, "Daemon shutdown is loopback-only")
        callback = getattr(app.state, "request_shutdown", None)
        if callback is None:
            raise HTTPException(409, "This server does not support launcher shutdown")
        manager.stopping = True

        async def after_response():
            # Let Windows flush the response before Uvicorn closes listeners.
            await asyncio.sleep(0.1)
            callback()

        return JSONResponse(
            {"stopping": True}, background=BackgroundTask(after_response)
        )

    @app.get("/health")
    async def health():
        return {
            "ok": True,
            "service": "menagerie",
            "active": [
                d["id"] for d in store.list("deployment") if d["state"] == "READY"
            ],
            "inflight": manager.inflight,
        }

    def _template_public(asset):
        """Stable, content-free wire shape for a stored template asset.

        ``revision`` is the store's row revision, so the publisher's commit is
        ``source_revision`` (as on artifacts). Fields added after rows were
        first stored are normalized to null so clients keep a strict contract."""
        row = {
            key: asset.get(key)
            for key in (
                "id",
                "kind",
                "artifact_id",
                "name",
                "repo",
                "source_revision",
                "file_path",
                "relative_path",
                "sha256",
                "size_bytes",
                "error",
            )
        }
        if asset.get("status") is not None:
            row["status"] = asset["status"]
        return row

    def _model_rows():
        """Artifacts with their content-stripped template assets.

        The dashboard reads models from the registry, while API clients use
        /api/models; both must carry the templates the pickers select from."""
        return [
            row
            | {
                "templates": [
                    _template_public(asset)
                    for asset in templates.list_template_assets(store, row.get("id"))
                ]
            }
            for row in store.list("artifact")
        ]

    kinds = {
        "models": "artifact",
        "runtimes": "runtime",
        "deployments": "deployment",
        "jobs": "job",
        "deployment_sets": "deployment_set",
        # Per-file repository acquisition (Stage 3). Distinct from "models"
        # (deployable artifacts): acquiring bytes registers inventory, not a
        # deployable model.
        "downloaded_files": "downloaded_file",
    }

    @app.get("/api/registry/{kind}")
    async def registry(kind: str):
        if kind not in kinds:
            raise HTTPException(404)
        if kind == "deployments":
            return deployment_rows()
        if kind == "runtimes":
            return [
                r
                | {
                    "capabilities": r.get("capabilities", {})
                    | {"schema": adapters.option_schema(r)}
                }
                for r in store.list("runtime")
            ]
        if kind == "models":
            from .capabilities import inspect

            return [
                r | {"discovered_capabilities": inspect(r.get("metadata", {}))}
                for r in _model_rows()
            ]
        return store.list(kinds[kind])

    @app.get("/api/models")
    async def models():
        return _model_rows()

    @app.post("/api/capabilities/preview")
    async def capability_preview(body: CapabilityPreview):
        from .capabilities import effective

        profile = dict(body.configuration)
        artifact = store.get("artifact", profile["artifact_id"])
        runtime = store.get("runtime", profile["runtime_id"])
        selection = templates.effective_selection(
            {"template_override": body.template_override}, artifact, store
        )
        asset = selection.get("asset")
        observed = None
        if body.deployment_id:
            deployment = store.get("deployment", body.deployment_id)
            saved = deployment.get("profile_snapshot", {})
            execution_keys = ("artifact_id", "runtime_id", "config", "raw_args")
            if (
                all(saved.get(key) == profile.get(key) for key in execution_keys)
                and deployment.get("template_override") == body.template_override
            ):
                observed = runtime_protocol.observation(store, deployment)
        return effective(
            artifact,
            runtime,
            profile,
            template=asset["content"] if asset else None,
            template_source="user"
            if asset and asset.get("kind") == "custom"
            else "tokenizer",
            observation=observed,
        )

    @app.get("/api/models/{ident}/templates")
    async def model_templates(ident: str):
        return [
            _template_public(t) for t in templates.list_template_assets(store, ident)
        ]

    @app.get("/api/templates/{ident}")
    async def template_detail(ident: str):
        asset = store.get("template", ident)
        return asset

    @app.post("/api/templates")
    async def create_template(request: Request):
        body = await request.json()
        artifact_id = body.get("artifact_id")
        content = body.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Custom template content is required")
        if len(content.encode("utf-8")) > templates.TEMPLATE_MAX_SIZE:
            raise ValueError("Template exceeds the 4 MiB limit")
        base = None
        if body.get("base_asset_id"):
            base = store.get("template", body["base_asset_id"])
            if base.get("kind") != "embedded":
                raise ValueError(
                    "A custom template must be copied from an existing template"
                )
        asset = {
            "id": uid(),
            "kind": "custom",
            "artifact_id": artifact_id,
            "name": (base["name"] + " (custom)") if base else "custom",
            "repo": base.get("repo") if base else None,
            "revision": base.get("revision") if base else None,
            "file_path": str(templates.write_custom_template(store, content)),
            "relative_path": "custom.jinja",
            "sha256": templates.sha256_text(content),
            "size_bytes": len(content.encode("utf-8")),
            "content": content,
            "status": "available",
            "error": None,
        }
        return store.put("template", asset)

    @app.put("/api/templates/{ident}")
    async def update_template(ident: str, request: Request):
        asset = store.get("template", ident)
        if asset.get("kind") != "custom":
            raise Conflict("Only custom templates can be edited")
        body = await request.json()
        content = body.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Template content is required")
        if len(content.encode("utf-8")) > templates.TEMPLATE_MAX_SIZE:
            raise ValueError("Template exceeds the 4 MiB limit")
        updated = {
            **asset,
            "content": content,
            "sha256": templates.sha256_text(content),
            "size_bytes": len(content.encode("utf-8")),
            "file_path": str(templates.write_custom_template(store, content)),
            "status": "available",
            "error": None,
        }
        return store.put("template", updated)

    @app.post("/api/templates/{ident}/delete")
    async def delete_template(ident: str):
        asset = store.get("template", ident)
        if asset.get("kind") != "custom":
            raise Conflict("Published and embedded templates cannot be deleted")
        path = Path(asset["file_path"]) if asset.get("file_path") else None
        removed = False
        if path:
            try:
                path.unlink()
                removed = True
            except OSError:
                pass
        with store.transaction() as c:
            c.execute("DELETE FROM objects WHERE kind='template' AND id=?", (ident,))
            store.event(
                "delete",
                {"kind": "template", "id": ident, "disk_files_removed": removed},
                c=c,
            )
        return {"deleted": ident, "disk_files_removed": removed}

    @app.post("/api/models/{ident}/refresh-templates")
    async def refresh_templates_endpoint(ident: str):
        return jobs.submit(
            "Refresh chat templates",
            lambda j: jobs.refresh_templates(ident),
            model_id=ident,
        )

    @app.post("/api/models/{ident}/template-default")
    async def set_template_default(ident: str, request: Request):
        body = await request.json()
        source = body.get("source")
        asset_id = body.get("asset_id")
        if source not in templates.TEMPLATE_SOURCES:
            raise ValueError(
                "Model template default source must be automatic, embedded, "
                "published, or custom"
            )
        async with manager.lock:
            with store.transaction() as c:
                artifact = store.get("artifact", ident, c)
                if source == "automatic":
                    selection = {"source": "automatic", "asset_id": None}
                else:
                    if not isinstance(asset_id, str) or not asset_id:
                        raise ValueError("A named template requires its asset id")
                    asset = next(
                        (
                            t
                            for t in store.list("template", c)
                            if t.get("id") == asset_id
                        ),
                        None,
                    )
                    if asset is None:
                        raise ValueError(
                            "Model template default references a missing template"
                        )
                    if asset.get("artifact_id") not in (None, ident):
                        raise ValueError(
                            "Model template default must belong to this model"
                        )
                    selection = {"source": source, "asset_id": asset_id}
                artifact["template_default"] = selection
                saved = store.put("artifact", artifact, c=c)
        return {
            **saved,
            "templates": [
                _template_public(t)
                for t in templates.list_template_assets(store, ident)
            ],
        }

    @app.get("/api/engines/catalog")
    async def engine_catalog():
        from .engine_catalog import sources

        return sources()

    @app.get("/api/engines/releases")
    async def engine_releases():
        from .managed_engines import catalog

        return await catalog(manager.client, store)

    @app.post("/api/engines/install")
    async def engine_install(request: Request):
        from .managed_engines import install

        body = await request.json()
        recipe = store.get("engine_recipe", body["recipe_id"])
        return jobs.submit(
            f"Install {recipe.get('source_name') or recipe['engine']} {recipe['version']}",
            lambda ident: install(jobs, ident, recipe["id"]),
        )

    @app.get("/api/models/{ident}/engine-recommendation")
    async def engine_recommendation(ident: str):
        from .engine_catalog import recommend

        return recommend(store.get("artifact", ident))

    @app.get("/api/deployments")
    async def deployments():
        return deployment_rows()

    @app.get("/api/deployments/alias/suggest")
    async def suggest_alias(
        name: str = Query(..., min_length=1), exclude: str | None = None
    ):
        """Deterministic API-identifier preview for a display name.

        Reads the current deployment aliases server-side so the returned
        value is the one that would be stored. The slug is a pure function
        of the name: same name and registry always yield the same identifier.
        """
        rows = store.list("deployment") + [
            r["data"]
            for snap in store.list("desired")
            for r in snap["rows"]
            if r["kind"] == "deployment"
        ]
        taken = {d["alias"] for d in rows if d["id"] != exclude}
        alias = resolve_alias(name, taken)
        return {
            "alias": alias,
            "base": slug(name),
            "mode": "generated",
        }

    @app.get("/api/serving-deployments")
    async def serving_deployments():
        return serving_rows()

    @app.post("/api/deployment-sets")
    async def save_deployment_set(body: DeploymentSet, expected: int | None = None):
        async with manager.lock:
            with store.transaction() as c:
                data = body.model_dump(exclude_none=True)
                drafts = data.pop("members", None)
                data.setdefault("gpu", None)
                previous_pool = (
                    store.get("deployment_set", data["id"], c)
                    if data.get("id")
                    else None
                )
                if previous_pool and any(
                    m["state"] in ACTIVE
                    for m in manager.unit(previous_pool["id"])["members"]
                ):
                    if expected != previous_pool["revision"]:
                        raise Conflict(
                            "Revision changed; review changes before applying"
                        )
                    if model_setup.desired(store, previous_pool["id"]):
                        raise Conflict(
                            "Apply or discard the proposed configuration before editing pool settings"
                        )
                    member_ids = (
                        [m.get("id") for m in drafts]
                        if drafts is not None
                        else data["member_ids"]
                    )
                    if member_ids != previous_pool["member_ids"]:
                        raise Conflict("Unload the pool before changing membership")
                    if not data.get("engine_pool"):
                        raise ValueError("Only native router pools are supported")
                    proposed = previous_pool | data | {"member_ids": member_ids}
                    proposed.setdefault("gpu", None)
                    members = (
                        drafts
                        if drafts is not None
                        else [store.get("deployment", i, c) for i in member_ids]
                    )
                    rows = [{"kind": "deployment_set", "data": proposed}]
                    for member in members:
                        member = member | {
                            k: proposed[k]
                            for k in deployment_sets.POLICY_KEYS
                            if k != "enabled"
                        }
                        prepared = save_member(
                            member,
                            c=c,
                            owner_id=proposed["id"],
                            prepare=True,
                            pool_settings=proposed,
                        )
                        rows.append({"kind": "deployment", "data": prepared})
                    snap = {"id": proposed["id"], "rows": rows}
                    model_setup.validate_snapshot(store, snap)
                    store.put("desired", snap, c=c)
                    aops.save_op(
                        store,
                        qa.create_op(
                            proposed["id"],
                            model_setup.fingerprint(snap),
                            aops.current_applied_rev(store, proposed["id"]) or "",
                            time.time(),
                        ),
                        c=c,
                    )
                    return proposed | {"changes_pending": True}
                removed = set()
                if drafts is not None:
                    if data["member_ids"]:
                        raise ValueError("Provide model configurations, not member IDs")
                    previous = (
                        store.get("deployment_set", data["id"], c)
                        if data.get("id")
                        else None
                    )
                    owned = set(previous["member_ids"] if previous else [])
                    ids = [m["id"] for m in drafts if m.get("id")]
                    if len(ids) != len(set(ids)) or any(i not in owned for i in ids):
                        raise Conflict(
                            "Existing members must belong to this deployment; copy their configuration to reuse a model"
                        )
                    affected = [store.get("deployment", i, c) for i in owned]
                    if any(
                        d["state"] in ACTIVE or manager.inflight.get(d["id"], 0)
                        for d in affected
                    ):
                        raise Conflict(
                            "Unload the deployment before editing its models"
                        )
                    data["member_ids"] = []
                    for draft in drafts:
                        draft.update(
                            {
                                k: data[k]
                                for k in deployment_sets.POLICY_KEYS
                                if k != "enabled"
                            }
                        )
                        member = save_member(
                            draft,
                            c=c,
                            owner_id=data.get("id"),
                            pool_settings=data if data.get("engine_pool") else None,
                        )
                        data["member_ids"].append(member["id"])
                    removed = owned - set(data["member_ids"])
                saved = save_set(data, expected, c)
                for ident in removed:
                    # Members are never orphaned into standalone deployments:
                    # removing one from the pool drops its deployment record.
                    # Model files stay on disk.
                    member = store.get("deployment", ident, c)
                    store.delete("deployment", ident, c)
                    store.event(
                        "deployment_removed",
                        {"name": member["name"], "pool": saved["name"]},
                        ident,
                        c,
                    )
                return saved

    @app.post("/api/serving-deployments/{ident}/validate")
    async def validate_serving(ident: str):
        return manager.plan([ident])

    @app.post("/api/serving-deployments/{ident}/start")
    async def start_serving(ident: str, request: Request):
        body = await request.json()
        if not body.get("plan_token"):
            raise Conflict("Review the launch plan first")
        unit = manager.unit(ident)
        return jobs.submit(
            "Load " + unit["name"],
            lambda job: manager.activate(
                [ident], body.get("override", False), token=body["plan_token"]
            ),
            deployment_id=ident,
            operation="load",
        )

    @app.post("/api/serving-deployments/{ident}/stop")
    async def stop_serving(ident: str, request: Request):
        cancel = (await request.json()).get("cancel_requests", False)
        if not isinstance(cancel, bool):
            raise ValueError("cancel_requests must be true or false")
        unit = manager.unit(ident)
        return jobs.submit(
            "Unload " + unit["name"],
            lambda job: manager.stop(
                ident,
                cancel_requests=cancel,
                progress=lambda text: jobs.progress(job, text),
            ),
            deployment_id=ident,
            operation="unload",
        )

    @app.post("/api/serving-deployments/{ident}/enabled")
    async def enable_serving(ident: str, request: Request):
        enabled = (await request.json()).get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be true or false")
        async with manager.lock:
            unit = manager.unit(ident)
            if any(d["state"] in ACTIVE for d in unit["members"]) or manager.unit_busy(
                unit
            ):
                raise Conflict(
                    "Unload the deployment before changing client availability"
                )
            with store.transaction() as c:
                if unit["multi_model"]:
                    stored = store.get("deployment_set", unit["id"], c)
                    store.put("deployment_set", stored | {"enabled": enabled}, c=c)
                for i in unit["member_ids"]:
                    store.put(
                        "deployment",
                        store.get("deployment", i, c) | {"enabled": enabled},
                        c=c,
                    )
                store.event(
                    "deployment",
                    {"enabled": enabled, "name": unit["name"]},
                    unit["id"],
                    c,
                )
            return deployment_sets.describe(
                manager.unit(ident), manager.settings(), manager.inflight
            )

    @app.post("/api/deployment-sets/{ident}/members/{member_id}/remove")
    async def remove_member(ident: str, member_id: str, expected: int):
        async with manager.lock:
            unit = manager.unit(ident)
            if unit["id"] != ident or unit["revision"] != expected:
                raise Conflict("Deployment changed; refresh before removing a model")
            if member_id not in unit["member_ids"]:
                raise Conflict("Model is not a member of this pool")
            if model_setup.desired(store, unit["id"]):
                raise Conflict(
                    "Apply or discard the pending pool changes before removing a model"
                )
            if manager.unit_busy(unit) or any(
                d["state"] in ACTIVE for d in unit["members"]
            ):
                raise Conflict("Unload the pool before removing a model")
            with store.transaction() as c:
                member = store.get("deployment", member_id, c)
                stored = store.get("deployment_set", unit["id"], c)
                store.put(
                    "deployment_set",
                    stored
                    | {
                        "member_ids": [
                            i for i in stored["member_ids"] if i != member_id
                        ]
                    },
                    expected=unit["revision"],
                    c=c,
                )
                # The member's deployment record is dropped only; its model files
                # and the pool's runtime installation stay put.
                store.delete("deployment", member_id, c)
                store.event(
                    "deployment_removed",
                    {"name": member["name"], "pool": unit["name"]},
                    member_id,
                    c,
                )
            return deployment_sets.describe(
                manager.unit(ident), manager.settings(), manager.inflight
            )

    @app.post("/api/deployment-sets/{ident}/delete")
    async def delete_pool(ident: str, expected: int):
        async with manager.lock:
            unit = manager.unit(ident)
            if unit["id"] != ident or unit["revision"] != expected:
                raise Conflict("Deployment changed; refresh before deleting the pool")
            if model_setup.desired(store, unit["id"]):
                raise Conflict(
                    "Apply or discard the pending pool changes before deleting it"
                )
            if manager.unit_busy(unit) or any(
                d["state"] in ACTIVE for d in unit["members"]
            ):
                raise Conflict("Unload the pool before deleting it")
            with store.transaction() as c:
                members = [store.get("deployment", i, c) for i in unit["member_ids"]]
                # Model files and the runtime installation are the owner's
                # property, not the pool's; deleting a pool drops only the
                # deployment records and the pool itself.
                for member in members:
                    store.delete("deployment", member["id"], c)
                store.delete("deployment_set", ident, c)
                store.event(
                    "pool_deleted",
                    {
                        "name": unit["name"],
                        "members": [m["name"] for m in members],
                    },
                    ident,
                    c,
                )
            return {"deleted": unit["name"], "members": [m["name"] for m in members]}

    @app.post("/api/models/local")
    async def add_local_model(request: Request):
        body = await request.json()

        async def work(ident):
            jobs.progress(ident, "Reading metadata and hashing weights")
            artifact = await asyncio.to_thread(
                adapters.inspect_artifact, body["path"], True
            )
            artifact.update(
                id="artifact-"
                + (artifact["sha256"] or identity(artifact["local_path"]))[:20],
                source="local",
            )
            templates.ensure_defaults(artifact)
            templates.create_template_assets(
                store, artifact["id"], templates.collect_template_drafts(artifact, {})
            )
            existing = next(
                (
                    a
                    for a in store.list("artifact")
                    if a.get("sha256")
                    and a["sha256"] == artifact["sha256"]
                    or a["local_path"] == artifact["local_path"]
                ),
                None,
            )
            return existing or store.put("artifact", artifact)

        return jobs.submit("Add local model", work)

    @app.post("/api/runtimes")
    async def runtime(body: Runtime):
        data = body.model_dump(exclude_none=True)
        if data["execution_kind"] == "native":
            data["executable"] = str(Path(data["executable"]).expanduser().resolve())
        if data.get("id") and any(
            d["state"] in ACTIVE and d["profile_snapshot"]["runtime_id"] == data["id"]
            for d in store.list("deployment")
        ):
            raise Conflict("Cannot change a runtime used by an active deployment")
        data["capabilities"] = await adapters.probe(data)
        if data.get("id"):
            try:
                previous = store.get("runtime", data["id"])
            except KeyError:
                previous = None
            keys = ("engine", "execution_kind", "executable", "env", "command_template")
            if previous and (
                any(previous.get(k) != data.get(k) for k in keys)
                or previous["capabilities"].get("sha256")
                != data["capabilities"].get("sha256")
            ):
                raise Conflict(
                    "Runtime installations are version-specific. Clone/register a new installation instead of changing its executable or launch identity."
                )
            if previous and previous.get("managed"):
                data["managed"] = previous["managed"]
        return store.put("runtime", data)

    @app.get("/api/runtimes/{ident}/capabilities")
    async def capabilities(ident: str):
        runtime = store.get("runtime", ident)
        fingerprint = adapters.executable_fingerprint(runtime)
        key = (ident, runtime["revision"], fingerprint)
        for previous in list(runtime_schema_tasks):
            if previous[0] == ident and previous != key:
                task = runtime_schema_tasks.pop(previous)
                task.cancel()
        if key not in runtime_schema_tasks:
            runtime_schema_tasks[key] = asyncio.create_task(
                adapters.configuration_schema(runtime)
            )
        try:
            schema = await asyncio.shield(runtime_schema_tasks[key])
        except Exception:
            runtime_schema_tasks.pop(key, None)
            raise
        return runtime["capabilities"] | {
            "schema": schema,
            "features": runtime_protocol.features(
                runtime, runtime["capabilities"].get("flags", [])
            ),
        }

    @app.post("/api/deployments")
    async def deployment(body: Deployment, expected: int | None = None):
        async with manager.lock:
            with store.transaction() as c:
                data = body.model_dump(exclude_none=True)
                if "template_override" in body.model_fields_set:
                    data["template_override"] = body.template_override
                pool_id = data.pop("pool_id", None)
                data.pop("pool", None)
                creating = not data.get("id")
                if creating:
                    # A model is always a pool member: the pool owns the shared
                    # runtime, device and serving port. There are no standalone
                    # deployments, so a new member must name its pool.
                    if not pool_id:
                        raise Conflict(
                            "Models belong to a runtime pool; target one with pool_id"
                        )
                    pool = store.get("deployment_set", pool_id, c)
                    if not pool.get("engine_pool"):
                        raise Conflict("Models can only join a runtime pool")
                    data.update(
                        runtime_id=pool["runtime_id"],
                        gpu=pool.get("gpu"),
                        port=None,
                    )
                saved = save_member(data, expected, c, owner_id=pool_id)
                if creating and pool_id:
                    pool = store.get("deployment_set", pool_id, c)
                    save_set(
                        pool | {"member_ids": [*pool["member_ids"], saved["id"]]},
                        pool["revision"],
                        c=c,
                    )
                    return store.get("deployment", saved["id"], c)
                owner = deployment_sets.unit_for(store, saved["id"])
                if owner and owner["multi_model"]:
                    store.put(
                        "deployment_set",
                        store.get("deployment_set", owner["id"], c),
                        c=c,
                    )
                return saved

    def save_member(
        data, expected=None, c=None, owner_id=None, prepare=False, pool_settings=None
    ):
        data.setdefault("gpu", None)
        all_d = store.list("deployment", c)
        desired_members = [
            r["data"]
            for snap in store.list("desired", c)
            for r in snap["rows"]
            if r["kind"] == "deployment"
        ]
        previous = next((d for d in all_d if d["id"] == data.get("id")), None)
        owner = deployment_sets.unit_for(store, data["id"]) if data.get("id") else None
        if (
            not prepare
            and owner
            and model_setup.desired(store, model_setup.unit_id(store, data["id"]))
        ):
            raise Conflict(
                "Apply or discard pending changes before using advanced editing"
            )
        if owner and owner["multi_model"]:
            if not prepare and any(m["state"] in ACTIVE for m in owner["members"]):
                raise Conflict("Unload the whole deployment before editing a model")
            if owner["id"] != owner_id and any(
                data[k] != owner[k] for k in deployment_sets.POLICY_KEYS
            ):
                raise Conflict(
                    "Edit the deployment's shared policy instead of an individual model"
                )
        if (
            not prepare
            and previous
            and (previous["state"] in ACTIVE or manager.inflight.get(previous["id"], 0))
        ):
            raise Conflict("Stop this deployment before changing its configuration")
        if previous is not None:
            # The body wins and the registry fills the gaps, so an edit never
            # drops fields it did not touch.
            data = previous | data
        settings = pool_settings or (
            owner if owner and owner.get("engine_pool") else None
        )
        if settings:
            # The pool owns the member's engine, device and serving port.
            data = {
                **data,
                "runtime_id": settings["runtime_id"],
                "gpu": settings.get("gpu"),
                "port": None,
            }
        # Identifier mode: in "generated" the API ID follows the display name and
        # is regenerated outright (no compatibility alias) when the name changes;
        # in "custom" the ID is user-controlled and stable across renames.
        if (
            data.get("identifier_mode") == "generated"
            and previous is not None
            and (previous.get("name") != data.get("name"))
        ):
            taken = {
                d["alias"]
                for d in all_d + desired_members
                if d.get("id") != data.get("id")
            }
            generated = resolve_alias(data["name"], taken)
            if prepare and data["alias"] != generated:
                raise Conflict(
                    "The generated API model ID changed; review the name and identifier again"
                )
            data["alias"] = generated
        if data.get("port") in {8001, 8017}:
            raise ValueError("Ports 8001 and 8017 are reserved for Menagerie")
        if any(
            d["id"] != data.get("id")
            and (
                d["alias"] == data["alias"]
                or (
                    data["port"] is not None
                    and d["port"] is not None
                    and d["port"] == data["port"]
                )
            )
            for d in all_d + desired_members
        ):
            raise Conflict("Alias and port must be unique")
        # The deployment is its own profile: five fields, no shared entity.
        if not data.get("artifact_id") or not data.get("runtime_id"):
            raise ValueError("Deployment requires artifact_id and runtime_id")
        artifact = store.get("artifact", data["artifact_id"], c)
        runtime = store.get("runtime", data["runtime_id"], c)
        errors = adapters.validate_profile(profile_view(data), artifact, runtime)
        if errors:
            raise ValueError("; ".join(errors))
        data["catalog"] = normalize(
            profile_view(data) | {"name": data["name"]}, data["alias"]
        )
        snapshot = profile_view(data)
        override = data.get("template_override")
        if override:
            if not isinstance(override, dict) or not override.get("source"):
                raise ValueError("Template override must name a source")
            if override.get("source") not in ("embedded", "published", "custom"):
                raise ValueError(
                    "Template override must be embedded, published, or custom"
                )
            asset = next(
                (
                    t
                    for t in store.list("template", c)
                    if t.get("id") == override.get("asset_id")
                ),
                None,
            )
            if asset is None:
                raise ValueError("Template override references a missing template")
            snapshot_artifact = snapshot.get("artifact_id")
            if snapshot_artifact and asset.get("artifact_id") not in (
                None,
                snapshot_artifact,
            ):
                raise ValueError(
                    "Template override must belong to the deployment's model"
                )
        data.update(state="STOPPED", profile_snapshot=snapshot, reservation_active=0)
        if prepare:
            data.setdefault("id", uid())
            data["revision"] = previous["revision"] if previous else 0
            return data
        return store.put("deployment", data, expected, c=c)

    @app.post("/api/model-setups")
    async def model_setup_save(body: Deployment, expected: int | None = None):
        async with manager.lock:
            data = body.model_dump(exclude_none=True)
            if "template_override" in body.model_fields_set:
                data["template_override"] = body.template_override
            pool_id = data.pop("pool_id", None)
            pool_spec = data.pop("pool", None)
            previous = store.get("deployment", data["id"]) if data.get("id") else None
            if previous and (expected is None or previous["revision"] != expected):
                raise Conflict("Revision changed; review changes before saving")
            if previous is not None and (pool_id is not None or pool_spec is not None):
                raise ValueError("Pool targeting is only for new members")
            owner = (
                manager.unit(model_setup.unit_id(store, previous["id"]))
                if previous
                else None
            )
            if owner:
                op = aops.find_op(store, owner["id"])
                if op and op.state in qa.ApplyState.IN_FLIGHT:
                    raise Conflict(
                        "A change is already being applied; cancel it before editing"
                    )
                if not aops.load_applied(store, owner["id"]):
                    aops.record_applied(store, owner)
            with store.transaction() as c:
                # Resolve the member's pool: a member edit inherits the set it
                # already belongs to; a new member targets an explicit pool,
                # or an inline spec that creates the pool atomically with it;
                # nothing else makes a member pooled.
                pool_id_for_member = None
                if previous is not None:
                    pool_id_for_member = owner["id"] if owner["multi_model"] else None
                elif pool_spec is not None:
                    pool_id_for_member = save_set(
                        {
                            "id": uid(),
                            "name": pool_spec["name"],
                            "engine_pool": True,
                            "runtime_id": pool_spec["runtime_id"],
                            "gpu": pool_spec.get("gpu"),
                            "port": pool_spec["port"],
                            "max_loaded": pool_spec.get("max_loaded", 4),
                            "member_ids": [],
                            "enabled": True,
                            "residency": pool_spec.get("residency", "on-demand"),
                            "priority": pool_spec.get("priority", 50),
                            "idle_timeout": pool_spec.get("idle_timeout", 300),
                            "allow_eviction": pool_spec.get("allow_eviction", False),
                            "queue_timeout": pool_spec.get("queue_timeout", 300),
                        },
                        c=c,
                    )["id"]
                elif pool_id is not None:
                    pool_id_for_member = pool_id
                else:
                    raise Conflict(
                        "Models belong to a runtime pool; choose one with pool_id or pool"
                    )
                if pool_id_for_member is not None and not data.get("id"):
                    pool = store.get("deployment_set", pool_id_for_member, c)
                    if not pool.get("engine_pool"):
                        raise Conflict("Models can only be added to a runtime pool")
                    data["runtime_id"] = pool["runtime_id"]
                    data["gpu"] = pool["gpu"]
                    data["port"] = None
                prepared = save_member(
                    data, c=c, owner_id=pool_id_for_member, prepare=True
                )
                pool = (
                    store.get("deployment_set", pool_id_for_member, c)
                    if pool_id_for_member
                    else None
                )
                pool_unit = (
                    deployment_sets.unit_for(store, pool_id_for_member)
                    if pool_id_for_member
                    else None
                )
                if pool is not None and previous is None:
                    if pool.get("engine_pool") and pool_edit.eligible_for_pool(
                        prepared, pool, store
                    ):
                        raise Conflict(
                            "This setup is incompatible with its pool; choose compatible engine, device and settings"
                        )
                    if any(
                        prepared[k] != pool[k]
                        for k in deployment_sets.POLICY_KEYS
                        if k != "enabled"
                    ):
                        raise Conflict(
                            "Shared policy belongs to the pool; edit it from the pool"
                        )
                key = pool["id"] if pool else prepared["id"]
                pending_snapshot = model_setup.desired(store, key)
                needs_apply = bool(
                    pending_snapshot
                    or pool_unit is not None
                    and any(m["state"] in ACTIVE for m in pool_unit["members"])
                )
                if needs_apply:
                    if previous is None:
                        raise Conflict("Unload the pool before adding a model")
                    op = aops.find_op(store, key)
                    if op and op.state in qa.ApplyState.IN_FLIGHT:
                        raise Conflict(
                            "A change is already being applied; cancel it before editing"
                        )
                    snap = pending_snapshot or model_setup.snapshot(store, pool_unit)
                    snap["rows"] = [
                        r
                        for r in snap["rows"]
                        if not (
                            r["kind"] == "deployment"
                            and r["data"]["id"] == prepared["id"]
                        )
                    ]
                    snap["rows"].append({"kind": "deployment", "data": prepared})
                    model_setup.validate_snapshot(store, snap)
                    saved = store.put("deployment", previous, expected=expected, c=c)
                    store.put("desired", snap, c=c)
                    op = qa.create_op(
                        key,
                        model_setup.fingerprint(snap),
                        aops.current_applied_rev(store, key) or "",
                        time.time(),
                    )
                    aops.save_op(store, op, c=c)
                else:
                    saved = store.put("deployment", prepared, expected=expected, c=c)
                    if pool:
                        if saved["id"] not in pool["member_ids"]:
                            pool["member_ids"].append(saved["id"])
                        store.put("deployment_set", pool, c=c)
            return model_setup.projection(store, saved)

    @app.post("/api/deployments/{ident}/validate")
    async def validate(ident: str):
        return manager.plan([ident])

    @app.post("/api/deployments/{ident}/start")
    async def start(ident: str, request: Request):
        body = await request.json()
        return jobs.submit(
            "Start deployment",
            lambda job: manager.activate(
                [ident], body.get("override", False), token=body.get("plan_token")
            ),
        )

    @app.post("/api/deployments/{ident}/load-model")
    async def load_model(ident: str, body: dict):
        if not body.get("plan_token"):
            raise Conflict("Review the launch plan before loading")
        return jobs.submit(
            "Load model",
            lambda job: manager.load_model(ident, body["plan_token"]),
            deployment_id=ident,
        )

    @app.post("/api/deployments/{ident}/stop")
    async def stop(ident: str, request: Request):
        cancel = (await request.json()).get("cancel_requests", False)
        if not isinstance(cancel, bool):
            raise ValueError("cancel_requests must be true or false")
        return jobs.submit(
            "Stop deployment",
            lambda job: manager.stop(
                ident,
                cancel_requests=cancel,
                progress=lambda text: jobs.progress(job, text),
            ),
        )

    @app.post("/api/deployments/{ident}/enabled")
    async def set_deployed(ident: str, request: Request):
        body = await request.json()
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be true or false")
        async with manager.lock:
            d = store.get("deployment", ident)
            unit = manager.unit(ident)
            if model_setup.desired(store, model_setup.unit_id(store, ident)):
                raise Conflict(
                    "Apply or discard pending changes before changing availability"
                )
            if unit["multi_model"] and not unit.get("engine_pool"):
                raise Conflict("Change client availability on the whole deployment")
            if d["enabled"] != enabled:
                store.put("deployment", d | {"enabled": enabled}, historical=False)
                store.event(
                    "deployment", {"alias": d["alias"], "enabled": enabled}, ident
                )
            return store.get("deployment", ident)

    # ---- Stage 4: desired/applied split + explicit queued-apply ----

    @app.get("/api/deployments/{ident}/pending")
    async def pending_status(ident: str):
        """Report a saved proposal separately from the authoritative configuration."""
        key = model_setup.unit_id(store, ident)
        desired = model_setup.desired(store, key)
        unit = (
            deployment_sets.unit_for(model_setup.PreviewStore(store, desired), key)
            if desired
            else manager.unit(ident)
        )
        status = aops.pending(store, unit)
        return {
            "unit_id": unit["id"],
            "unit_name": unit.get("name"),
            "multi_model": bool(unit.get("multi_model")),
            "op": aops.op_public(status["op"]) if status["op"] is not None else None,
            "desired_rev": model_setup.fingerprint(desired)
            if desired
            else status["desired_rev"],
            "applied_rev": status["applied_rev"],
            "pending": bool(desired),
            "scope_fingerprint": aops.scope_fingerprint(unit),
            "affected_ids": list(unit.get("member_ids", [])),
            "affected": [m.get("name") for m in unit.get("members", [])],
            "loaded": any(m["state"] in ACTIVE for m in manager.unit(key)["members"]),
            "inflight": sum(
                manager.inflight.get(i, 0) for i in manager.unit(key)["member_ids"]
            ),
        }

    @app.get("/api/deployments/{ident}/action-scope")
    async def action_scope_view(ident: str, action: str, member_id: str | None = None):
        """The honest scope of an action on this deployment's pool: does it act
        on just this model or on the whole pool? The UI labels the action with
        the returned ``scope_label`` so a pool stop is never presented as a
        per-model unload."""
        unit = manager.unit(ident)
        return pool_edit.action_scope(action, unit, store, member_id)

    @app.get("/api/deployments/{ident}/eligibility")
    async def pool_eligibility(ident: str):
        """Can this deployment's configuration join its pool? Returns the hard
        errors only; the UI must present them and let the user choose a
        compatible pool or reconfigure. Nothing is auto-changed to fit."""
        unit = manager.unit(ident)
        if not unit.get("multi_model"):
            return {"eligible": True, "errors": []}
        d = store.get("deployment", ident)
        errors = sorted(pool_edit.eligible_for_pool(d, unit, store))
        return {"eligible": not errors, "errors": errors}

    @app.get("/api/deployments/{ident}/eviction-candidates")
    async def eviction_candidates_view(ident: str):
        """Idle models that may be unloaded so *this* model can load. Policy-
        gated (consent + non-pinned + priority) and always ``requires_consent``;
        the unit being loaded is never a candidate."""
        unit = manager.unit(ident)
        units = deployment_sets.units(store)
        candidates = pool_edit.eviction_candidates(
            units,
            selected_ids=[unit["id"]],
            inflight=manager.inflight,
            last_use=manager.last_use,
            now=time.monotonic(),
        )
        return {"candidates": candidates, "count": len(candidates)}

    @app.post("/api/deployments/{ident}/request-apply")
    async def request_apply_endpoint(ident: str, body: dict):
        """Queue a *reviewed* apply. The UI sends the ``token`` and the
        ``scope_fingerprint`` it captured when reviewing. The job revalidates
        (scope + launch plan) immediately before applying, so stale consent is
        never used. Returns the queued op plus a job id for progress polling."""
        token = body.get("token")
        scope = body.get("scope_fingerprint")
        mode = body.get("mode", "idle")
        if mode not in {"apply", "reload", "idle", "now"}:
            raise ValueError("Unknown configuration application mode")
        if mode == "now" and body.get("confirm_interrupt") is not True:
            raise Conflict(
                "Confirm interruption of active requests before reloading now"
            )
        if not token or not scope:
            raise ValueError(
                "Queuing an apply requires a reviewed token and scope fingerprint."
            )
        key = model_setup.unit_id(store, ident)
        if model_setup.desired(store, key):
            async with manager.lock:
                reviewed = model_setup.plan(manager, ident)
                if (
                    token != reviewed["plan_token"]
                    or scope != reviewed["scope_fingerprint"]
                ):
                    raise Conflict("The affected configuration changed; review again")
                if reviewed["errors"]:
                    raise Conflict("; ".join(reviewed["errors"]))
                if mode == "apply" and reviewed["loaded"]:
                    raise Conflict("Pool is loaded; review a reload before applying")
                if mode == "reload" and reviewed["inflight"]:
                    raise Conflict(
                        "Pool is serving requests; choose When Idle or Reload Now"
                    )
                op = aops.find_op(store, key)
                if op.state in qa.ApplyState.IN_FLIGHT:
                    raise Conflict("An apply is already queued")
                op = qa.create_op(
                    key,
                    model_setup.fingerprint(model_setup.desired(store, key)),
                    op.applied_rev,
                    time.time(),
                )
                aops.save_op(store, qa.request_apply(op, time.time(), token, scope))
                job = jobs.submit(
                    "Apply changes when idle",
                    lambda job: manager.apply_desired(
                        key, lambda text: jobs.progress(job, text), mode=mode
                    ),
                    deployment_id=key,
                    operation="apply",
                )
                return {
                    "op": aops.op_public(aops.find_op(store, key)),
                    "job_id": job["id"],
                }
        raise Conflict("Nothing pending to apply for this pool")

    @app.post("/api/deployments/{ident}/cancel")
    async def cancel_apply_endpoint(ident: str):
        """Cancel the queued apply before it begins. The saved change remains
        pending for a fresh review."""
        async with manager.lock:
            op = aops.cancel(store, model_setup.unit_id(store, ident))
            manager.request_changed.set()
        return {"op": aops.op_public(op)}

    @app.post("/api/deployments/{ident}/review-apply")
    async def review_apply(ident: str):
        async with manager.lock:
            return model_setup.plan(manager, ident)

    @app.post("/api/deployments/{ident}/discard")
    async def discard_endpoint(ident: str):
        """Discard pending changes: restore the last *applied* configuration and
        clear the operation. Returns the restored applied revision, or null when
        the unit was never activated (nothing to restore)."""
        async with manager.lock:
            key = model_setup.unit_id(store, ident)
            unit = manager.unit(key)
            op = aops.find_op(store, key)
            if op and op.state in qa.ApplyState.IN_FLIGHT:
                raise Conflict("Cancel the scheduled apply before discarding changes")
            snap = model_setup.desired(store, key)
            if snap:
                with store.transaction() as c:
                    store.delete("desired", key, c)
                    store.delete("queued_apply", key, c)
                restored = aops.current_applied_rev(store, key)
            else:
                restored = None
        return {"restored": restored, "scope_fingerprint": aops.scope_fingerprint(unit)}

    @app.get("/api/deployments/{ident}/logs")
    async def logs(ident: str, session_id: str | None = None):
        d = store.get("deployment", ident)
        path = Path(d.get("log_path", str(store.root / "missing")))
        if not path.is_file():
            return {"text": "No runtime log yet"}
        session = store.get("session", session_id) if session_id else None
        if session and session.get("deployment_id") != ident:
            raise ValueError("Run does not belong to this deployment")
        chunks = []
        for candidate in (path.with_suffix(".previous.log"), path):
            if not candidate.is_file():
                continue
            with candidate.open("rb") as f:
                f.seek(max(0, candidate.stat().st_size - 65536))
                chunks.extend(f.read().decode(errors="replace").splitlines())
        if session:
            selected = []
            for line in chunks:
                try:
                    ts = float(line.partition(" ")[0])
                except ValueError:
                    continue
                if session["started_at"] <= ts and (
                    session.get("ended_at") is None or ts <= session["ended_at"]
                ):
                    selected.append(line)
            chunks = selected
        return {"text": "\n".join(chunks)[-65536:] or "—"}

    @app.get("/api/deployments/{ident}/performance")
    async def performance(ident: str, hours: int = 24):
        from .resource_history import performance_samples

        return performance_samples(store, ident, max(1, min(hours, 2160)))

    @app.get("/api/events")
    async def events(after: int = 0):
        return store.events(after)

    @app.get("/api/events/stream")
    async def stream_events(request: Request, after: int = 0):
        try:
            after = max(after, int(request.headers.get("last-event-id", "0")))
        except ValueError:
            pass

        async def generate():
            cursor = after
            while not manager.stopping and not await request.is_disconnected():
                try:
                    sample_seconds = manager.settings()["sample_seconds"]
                except Exception:
                    sample_seconds = 2
                # Emit telemetry before touching the store so a locked registry
                # still delivers a fresh (possibly stale-flagged) snapshot and
                # does not kill the stream.
                yield f"event: telemetry\ndata: {encode(host_view(manager, sample_seconds))}\n\n"
                try:
                    for event in store.events(cursor):
                        cursor = event["seq"]
                        yield f"id: {cursor}\nevent: operation\ndata: {encode(event)}\n\n"
                except Exception:
                    # Keep the stream alive through a store lock; retry the same
                    # cursor next cycle once the lock clears.
                    pass
                await asyncio.sleep(float(sample_seconds))

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no"},
        )

    @app.get("/api/history/sessions")
    async def sessions():
        return sorted(
            store.list("session"), key=lambda x: x["started_at"], reverse=True
        )

    @app.get("/api/history/resources")
    async def resource_history(artifact_id: str | None = None):
        from .resource_history import summaries

        return summaries(store, manager.settings(), artifact_id)

    @app.post("/api/history/sessions/{ident}/restore")
    async def restore(ident: str):
        session = store.get("session", ident)
        saved = session["deployment_snapshot"]
        snapshot = {k: saved["profile_snapshot"][k] for k in PROFILE_FIELDS}
        with store.transaction() as c:
            for kind, key, snapshot_key in (
                ("artifact", "artifact_id", "artifact_identity"),
                ("runtime", "runtime_id", "runtime_identity"),
            ):
                saved_identity = session[snapshot_key]
                try:
                    current = store.get(kind, saved_identity["id"], c)
                except KeyError:
                    current = None
                if current is None:
                    current = store.put(kind, saved_identity, c=c)
                elif (
                    kind == "runtime"
                    and current.get("capabilities", {}).get("sha256")
                    != saved_identity.get("capabilities", {}).get("sha256")
                ) or (
                    kind == "artifact"
                    and current.get("sha256") != saved_identity.get("sha256")
                ):
                    current = store.put(kind, saved_identity | {"id": uid()}, c=c)
                snapshot[key] = current["id"]
            restored = {
                key: saved[key] for key in Deployment.model_fields if key in saved
            }
            restored.update(
                **{k: snapshot[k] for k in PROFILE_FIELDS},
                id=uid(),
                name=saved["name"] + " (restored)",
                profile_snapshot=snapshot,
                alias=saved["alias"][:140] + "-" + uid()[:8],
                enabled=False,
                state="STOPPED",
                reservation_active=0,
            )
            used_ports = {d.get("port") for d in store.list("deployment_set", c)} | {
                8001,
                8017,
            }
            pool_port = next(
                port for port in range(8120, 65536) if port not in used_ports
            )
            restored["port"] = None
            # A restored model is still a pool member: it is grouped with a set
            # rather than left as a standalone deployment.
            member = store.put("deployment", restored, c=c)
            value = DeploymentSet(
                name=saved["name"] + " pool",
                engine_pool=True,
                runtime_id=snapshot["runtime_id"],
                gpu=restored.get("gpu"),
                port=pool_port,
                member_ids=[member["id"]],
                residency=restored.get("residency") or "on-demand",
                priority=restored.get("priority", 50),
                idle_timeout=restored.get("idle_timeout", 300),
                allow_eviction=restored.get("allow_eviction", False),
                queue_timeout=restored.get("queue_timeout", 300),
                enabled=False,
            ).model_dump(exclude_none=True)
            save_set(value | {"restored_from_session": ident}, c=c)
            return store.get("deployment", member["id"], c)

    @app.get("/api/history/activations")
    async def activations():
        return sorted(
            store.list("activation"), key=lambda x: x["started_at"], reverse=True
        )

    @app.post("/api/history/activations/{ident}/restore")
    async def restore_activation(ident: str):
        saved = store.get("activation", ident)
        async with manager.lock:
            ports = {d.get("port") for d in store.list("deployment_set")} | {8001, 8017}
            suffix = uid()[:6]
            deployments = []
            with store.transaction() as c:
                for snapshot in saved["deployments"]:
                    d = {
                        k: v
                        for k, v in snapshot.items()
                        if k in Deployment.model_fields
                    }
                    name = snapshot["name"] + " (restored)"
                    snapshot_ = {
                        k: snapshot["profile_snapshot"][k] for k in PROFILE_FIELDS
                    }
                    for kind, key, snapshot_key in (
                        ("artifact", "artifact_id", "artifact_identity"),
                        ("runtime", "runtime_id", "runtime_identity"),
                    ):
                        saved_identity = snapshot[snapshot_key]
                        try:
                            current = store.get(kind, saved_identity["id"], c)
                        except KeyError:
                            current = None
                        if current is None:
                            current = store.put(kind, saved_identity, c=c)
                        elif (
                            kind == "runtime"
                            and current.get("capabilities", {}).get("sha256")
                            != saved_identity.get("capabilities", {}).get("sha256")
                        ) or (
                            kind == "artifact"
                            and current.get("sha256") != saved_identity.get("sha256")
                        ):
                            current = store.put(
                                kind, saved_identity | {"id": uid()}, c=c
                            )
                        snapshot_[key] = current["id"]
                    snapshot_["catalog"] = normalize(snapshot_ | {"name": name})
                    snapshot_["catalog"]["catalog_id"] += "-" + suffix
                    d.update(
                        id=uid(),
                        name=name,
                        **{k: snapshot_[k] for k in PROFILE_FIELDS},
                        profile_snapshot=snapshot_,
                        alias=d["alias"] + "-" + suffix,
                        enabled=False,
                        state="STOPPED",
                        reservation_active=0,
                    )
                    d["port"] = None
                    deployments.append(store.put("deployment", d, c=c)["id"])
                policy = saved.get(
                    "deployment_policy",
                    {
                        "residency": "pinned",
                        "priority": 50,
                        "idle_timeout": 0,
                        "allow_eviction": False,
                        "queue_timeout": 300,
                    },
                )
                value = DeploymentSet(
                    name="Restored " + (saved.get("deployment_name") or ident[:8]),
                    member_ids=deployments,
                    engine_pool=True,
                    runtime_id=store.get("deployment", deployments[0], c)["runtime_id"],
                    gpu=store.get("deployment", deployments[0], c).get("gpu"),
                    max_loaded=(saved.get("pool_configuration") or {}).get("max_loaded")
                    or 4,
                    port=next(port for port in range(8110, 65536) if port not in ports),
                    **(
                        {
                            k: v
                            for k, v in policy.items()
                            if k in DeploymentSet.model_fields
                        }
                        | {"enabled": False}
                    ),
                ).model_dump(exclude_none=True)
                return save_set(value | {"restored_from_activation": ident}, c=c)

    @app.get("/api/history/metrics")
    async def metric_history(hours: int = 24):
        hours = max(1, min(hours, 2160))
        with store.connect() as c:
            rows = c.execute(
                "SELECT data FROM samples WHERE ts IN (SELECT min(ts) FROM samples WHERE ts>? GROUP BY CAST(ts/? AS INTEGER)) ORDER BY ts",
                (time.time() - hours * 3600, max(2, hours * 3600 // 500)),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    @app.post("/api/history/purge")
    async def purge_history(request: Request):
        body = await request.json()
        days = body.get("older_than_days")
        if (
            type(days) is not int
            or not 1 <= days <= 365
            or body.get("confirm") is not True
        ):
            raise ValueError(
                "Confirm a telemetry purge threshold between 1 and 365 days"
            )
        cutoff = time.time() - days * 86400
        with store.transaction() as c:
            samples = c.execute("DELETE FROM samples WHERE ts<?", (cutoff,)).rowcount
            requests = c.execute("DELETE FROM requests WHERE ts<?", (cutoff,)).rowcount
            store.event(
                "purge",
                {"older_than_days": days, "samples": samples, "requests": requests},
                c=c,
            )
        return {
            "samples_removed": samples,
            "requests_removed": requests,
            "configuration_and_sessions_preserved": True,
        }

    @app.get("/api/history/requests")
    async def requests(deployment_id: str | None = None):
        ids = manager.unit(deployment_id)["member_ids"] if deployment_id else []
        with store.connect() as c:
            return [
                dict(r) | {"data": json.loads(r["data"])}
                for r in c.execute(
                    "SELECT * FROM requests "
                    + (
                        "WHERE deployment_id IN (" + ",".join("?" for _ in ids) + ") "
                        if ids
                        else ""
                    )
                    + "ORDER BY ts DESC LIMIT 300",
                    ids,
                )
            ]

    @app.post("/api/registry/{kind}/{ident}/delete")
    async def delete_record(kind: str, ident: str, remove_files: bool = False):
        if kind not in {"models", "runtimes", "deployments"}:
            raise HTTPException(404)
        async with manager.lock:
            row = store.get(kinds[kind], ident)
            deployments = store.list("deployment")
            if kind == "deployments":
                if model_setup.desired(store, model_setup.unit_id(store, ident)):
                    raise Conflict(
                        "Apply or discard pending changes before removing this model"
                    )
                if manager.unit(ident)["multi_model"]:
                    raise Conflict(
                        "Separate this model from its deployment before removing it"
                    )
                if row["state"] in ACTIVE:
                    raise Conflict("Unload the deployment first")
            if kind in {"models", "runtimes"}:
                key = {
                    "models": "artifact_id",
                    "runtimes": "runtime_id",
                }[kind]
                if any(d["profile_snapshot"].get(key) == ident for d in deployments):
                    raise Conflict("Deployment snapshots still reference this record")
                if kind == "runtimes" and any(
                    pool.get("runtime_id") == ident
                    for pool in store.list("deployment_set")
                ):
                    raise Conflict("Runtime pools still reference this record")
                if any(
                    entry["data"].get(key) == ident
                    for snap in store.list("desired")
                    for entry in snap["rows"]
                ):
                    raise Conflict(
                        "Scheduled configuration still references this record"
                    )
                if kind == "models":
                    # Template assets belong to the model; remove the custom
                    # template files they own and the rows themselves so a
                    # deleted model does not leave orphaned templates behind.
                    orphaned = [
                        t
                        for t in store.list("template")
                        if t.get("artifact_id") == ident
                    ]
                    for t in orphaned:
                        if t.get("kind") == "custom" and t.get("file_path"):
                            path = Path(t["file_path"])
                            if path.is_file() and path.is_relative_to(store.root):
                                path.unlink()
                    if orphaned:
                        with store.transaction() as c:
                            c.executemany(
                                "DELETE FROM objects WHERE kind=? AND id=?",
                                [("template", t["id"]) for t in orphaned],
                            )
            if remove_files:
                if kind != "runtimes":
                    raise ValueError(
                        "File removal is only supported for managed engines"
                    )
                from .managed_engines import remove

                remove(store, row)
            with store.transaction() as c:
                c.execute(
                    "DELETE FROM objects WHERE kind=? AND id=?", (kinds[kind], ident)
                )
                store.event(
                    "delete",
                    {
                        "kind": kind,
                        "id": ident,
                        "disk_files_preserved": not remove_files,
                    },
                    c=c,
                )
            return {"deleted": ident, "disk_files_preserved": not remove_files}

    @app.post("/api/settings")
    async def settings(body: Settings):
        return store.put("settings", body.model_dump() | {"id": "host"})

    @app.post("/api/backup")
    async def backup():
        return {"path": str(await asyncio.to_thread(store.backup))}

    @app.get("/api/catalog/hf")
    async def hf_search(q: str):
        return await jobs.hf_search(q)

    @app.post("/api/models/{ident}/inspect")
    async def inspect_model(ident: str):
        artifact = store.get("artifact", ident)

        async def action(job):
            jobs.progress(job, "Inspecting local metadata; weights stay in place")
            inspected = await asyncio.to_thread(
                adapters.inspect_artifact, artifact["local_path"]
            )
            metadata = {
                k: v for k, v in inspected["metadata"].items() if k != "file_sha256"
            }
            if artifact.get("repo") and artifact.get("source_revision"):
                upstream = await jobs.hf_files(
                    artifact["repo"], artifact["source_revision"]
                )
                metadata["discovery"] = upstream["capabilities"]
            current = store.get("artifact", ident)
            return store.put(
                "artifact",
                current | {"metadata": current.get("metadata", {}) | metadata},
            )

        return jobs.submit("Inspect model capabilities", action)

    @app.get("/api/catalog/hf/files")
    async def hf_files(repo: str, revision: str = "main"):
        return await jobs.hf_files(repo, revision)

    @app.get("/api/catalog/hf/revisions")
    async def hf_revisions(repo: str):
        return await jobs.hf_revisions(repo)

    @app.get("/api/catalog/hf/quantizations")
    async def hf_quantizations(repo: str):
        return await jobs.hf_quantizations(repo)

    @app.get("/api/catalog/hf/readme")
    async def hf_readme(repo: str, revision: str = "main"):
        """README of the pinned revision. Returns the raw text so the client
        can parse it with its own deterministic renderer; the client caches
        the parse keyed on revision so unrelated polling does not remount the
        article.
        """
        return {
            "repo": repo,
            "revision": revision,
            "content": await jobs.hf_readme(repo, revision),
        }

    @app.post("/api/downloads")
    async def download(request: Request):
        body = await request.json()
        return jobs.submit(
            "Download " + body["repo"] + " · " + body["filename"],
            lambda job: jobs.download(
                job,
                body["repo"],
                body["revision"],
                body["filename"],
                body.get("projector"),
            ),
            operation="download",
            repo=body["repo"],
            filename=body["filename"],
        )

    @app.post("/api/downloads/manifest")
    async def downloads_manifest(request: Request):
        """Repository file manifest with local acquisition status. POST (not GET)
        so the selection is a JSON list of group ids — group ids may carry
        arbitrary characters. Returns the resolved revision, the file list and
        groups with per-file local status, and (given ``selected``) the required,
        pending and retry-target sets. A stale selection for the resolved
        revision is a 409 conflict (revision safety)."""
        body = await request.json()
        try:
            return await jobs.manifest(
                body["repo"],
                body.get("revision", "main"),
                bundle_map=body.get("bundle_map"),
                selected=body.get("selected"),
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/downloads/files")
    async def downloads_files(request: Request):
        """Independent acquisition: download the selected groups' required files
        into the per-file inventory (DownloadedFile records) without creating a
        deployable artifact. Partial success; re-running re-acquires only
        failed/missing files."""
        body = await request.json()
        selected = body.get("selected") or []
        if not selected:
            raise HTTPException(400, "Select at least one file or bundle to download")
        if not re.fullmatch(r"[a-f0-9]{40}", str(body.get("revision", ""))):
            raise HTTPException(
                400,
                "revision must be the resolved 40-character sha from /api/downloads/manifest",
            )
        return jobs.submit(
            "Download files from " + body["repo"],
            lambda job: jobs.download_files(
                job,
                body["repo"],
                body["revision"],
                selected,
                bundle_map=body.get("bundle_map"),
            ),
            operation="download_files",
            repo=body["repo"],
            revision=body.get("revision"),
            selected=selected,
        )

    @app.post("/api/runtimes/install/preview")
    async def install_preview(request: Request):
        return jobs.install_plan(await request.json())

    @app.post("/api/runtimes/install")
    async def install(request: Request):
        body = await request.json()
        if not body.get("trust"):
            raise ValueError("Explicit source trust required")
        return jobs.submit(
            "Build runtime", lambda job: jobs.install(job, body, body["token"])
        )

    @app.post("/api/runtimes/pull")
    async def pull_image(request: Request):
        body = Runtime.model_validate(await request.json()).model_dump(
            exclude_none=True
        )
        if (
            body["execution_kind"] not in {"docker", "podman"}
            or not body["trust"]
            or "@sha256:" not in body["executable"]
        ):
            raise ValueError("Trusted digest-pinned OCI image required")

        async def action(job):
            await adapters.command(
                [body["execution_kind"], "pull", body["executable"]], timeout=3600
            )
            body["capabilities"] = await adapters.probe(body)
            return store.put("runtime", body)

        return jobs.submit("Pull runtime image", action)

    def catalog_rows():
        rows = []
        settings = manager.settings()
        for d in store.list("deployment"):
            unit = manager.unit(d["id"])
            if not lifecycle.visible(
                d
                | {
                    "state": deployment_sets.state(unit),
                    "enabled": d["enabled"] and unit["enabled"],
                },
                settings,
            ):
                continue
            # While a rename (or other change) is pending the runtime still
            # executes the applied configuration; advertise the served ID, not
            # the desired one, so no client ever requests an unserved ID.
            served_alias = aops.effective_alias(store, unit, d["id"])
            catalog = normalize(d, served_alias)
            catalog["catalog_id"] = served_alias
            catalog["model"]["name"] = d["name"]
            rows.append(
                {
                    "id": served_alias,
                    "object": "model",
                    "created": 0,
                    "owned_by": "menagerie",
                    "menagerie": {
                        "catalog": catalog,
                        "deployment_id": d["id"],
                        "state": d["state"],
                        "residency": d["residency"],
                    },
                }
            )
        return rows

    @app.post("/api/integration/opencode/export")
    async def export_opencode():
        path = export_config(store.root, catalog_rows(), gateway_url)
        return {
            "path": str(path),
            "note": "Managed fragment only; unrelated client settings are never overwritten. Dynamic-discovery clients read /v1/models automatically.",
        }

    @app.get("/v1/models")
    @app.get("/models")
    async def served_models():
        rows = catalog_rows()
        export_config(store.root, rows, gateway_url)
        return {"object": "list", "data": rows}

    @app.get("/api/integration/opencode")
    async def opencode():
        return {
            "catalog": catalog_rows(),
            "endpoint": gateway_url,
            "discovery": "Capability metadata is included in /v1/models. Refresh behavior depends on the client.",
            "reload_note": "Generated config may require client reload; dynamic discovery refreshes separately.",
        }

    @app.get("/metrics")
    async def metrics():
        lines = [
            "# TYPE menagerie_gateway_waiting gauge",
            f"menagerie_gateway_waiting {manager.waiting}",
        ]
        for gpu in manager.host.get("gpus", []):
            for key in (
                "used_mib",
                "free_mib",
                "utilization",
                "temperature",
                "power_w",
            ):
                if gpu[key] is not None:
                    lines.append(
                        f'menagerie_gpu_{key}{{gpu="{gpu["index"]}"}} {gpu[key]}'
                    )
        for d in store.list("deployment"):
            lines.append(
                f'menagerie_deployment_ready{{deployment="{d["id"]}"}} {int(d["state"] == "READY")}'
            )
            lines.append(
                f'menagerie_deployment_requests_active{{deployment="{d["id"]}"}} {manager.inflight.get(d["id"], 0)}'
            )
        return PlainTextResponse("\n".join(lines) + "\n")

    @app.post("/v1/chat/completions")
    async def completion(request: Request):
        body = await request.json()
        correlation = uid()
        started = time.monotonic()
        # Validate explicit modes and deployment-default effects before any load.
        if isinstance(body, dict):
            model = body.get("model")
            candidate = next(
                (
                    d
                    for d in store.list("deployment")
                    if d.get("enabled")
                    and aops.effective_alias(store, manager.unit(d["id"]), d["id"])
                    == model
                ),
                None,
            )
            if candidate:
                try:
                    apply_reasoning(body, candidate["profile_snapshot"])
                except ValueError as exc:
                    # Invalid selectors must not trigger an expensive on-demand load.
                    return JSONResponse(
                        {
                            "error": {
                                "message": str(exc),
                                "type": "invalid_request_error",
                            }
                        },
                        400,
                    )
        try:
            d = await manager.acquire(body.get("model", ""))
        except KeyError:
            return JSONResponse(
                {
                    "error": {
                        "message": "Unknown or disabled model alias",
                        "type": "model_not_found",
                        "correlation_id": correlation,
                    }
                },
                404,
            )
        except (Conflict, TimeoutError) as exc:
            return JSONResponse(
                {
                    "error": {
                        "message": str(exc) or "Model load queue timed out",
                        "type": "deployment_unavailable",
                        "retry_after": 5,
                        "correlation_id": correlation,
                    }
                },
                429 if "queue is full" in str(exc) else 503,
                headers={"Retry-After": "5"},
            )
        record = {
            "model_alias": d["alias"],
            "correlation_id": correlation,
            "error": None,
            "ttft": None,
            "output_tokens": None,
        }

        finished = False

        def finish(error=None):
            nonlocal finished
            if finished:
                return
            finished = True
            manager.release(d)
            record.update(latency=time.monotonic() - started, error=error)
            with store.connect() as c:
                c.execute(
                    "INSERT INTO requests VALUES(?,?,?,?)",
                    (correlation, time.time(), d["id"], encode(record)),
                )
                c.execute(
                    "INSERT INTO request_totals VALUES(?,1) "
                    "ON CONFLICT(deployment_id) DO UPDATE SET completed=completed+1",
                    (d["id"],),
                )
            if d.get("session_id"):
                with store.transaction() as c:
                    session = store.get("session", d["session_id"], c)
                    session["request_count"] = session.get("request_count", 0) + 1
                    session["error_count"] = session.get("error_count", 0) + int(
                        error is not None
                    )
                    session["output_tokens"] = session.get("output_tokens", 0) + (
                        record["output_tokens"] or 0
                    )
                    session["total_request_seconds"] = (
                        session.get("total_request_seconds", 0) + record["latency"]
                    )
                    store.put("session", session, historical=False, c=c)

        try:
            body = apply_reasoning(body, d["profile_snapshot"])
        except ValueError as exc:
            finish("invalid_reasoning_option")
            return JSONResponse(
                {"error": {"message": str(exc), "type": "invalid_request_error"}}, 400
            )
        body["model"] = d["alias"]
        sending = asyncio.create_task(
            manager.client.send(
                manager.client.build_request(
                    "POST",
                    f"http://127.0.0.1:{manager.runtime_port(d)}/v1/chat/completions",
                    json=body,
                    headers={"X-Request-ID": correlation},
                ),
                stream=True,
            )
        )
        try:
            while not sending.done():
                await asyncio.wait({sending}, timeout=0.25)
                if await request.is_disconnected():
                    sending.cancel()
                    await asyncio.gather(sending, return_exceptions=True)
                    if not sending.cancelled() and sending.exception() is None:
                        await sending.result().aclose()
                    finish("client_cancelled")
                    return JSONResponse(
                        {"error": {"message": "Client disconnected"}}, 499
                    )
            upstream = await sending
        except asyncio.CancelledError:
            sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)
            finish("client_cancelled")
            raise
        except httpx.HTTPError as exc:
            finish(redact(str(exc)))
            return JSONResponse(
                {
                    "error": {
                        "message": "Upstream unavailable",
                        "correlation_id": correlation,
                    }
                },
                502,
            )
        if upstream.status_code != 200:
            try:
                raw = await upstream.aread()
            finally:
                try:
                    await upstream.aclose()
                finally:
                    finish(f"Upstream HTTP {upstream.status_code}")
            return PlainTextResponse(
                raw,
                status_code=upstream.status_code,
                media_type="application/json",
                headers={"X-Request-ID": correlation},
            )
        if not body.get("stream"):
            try:
                data = json.loads(await upstream.aread())
                record["output_tokens"] = data.get("usage", {}).get("completion_tokens")
                record["generation_tok_s"] = data.get("timings", {}).get(
                    "predicted_per_second"
                )
                record["prefill_tok_s"] = data.get("timings", {}).get(
                    "prompt_per_second"
                )
                finish()
                return JSONResponse(
                    data,
                    headers={
                        "X-Request-ID": correlation,
                        "X-Menagerie-Deployment": d["id"],
                    },
                )
            except BaseException as exc:
                finish(type(exc).__name__)
                raise
            finally:
                await upstream.aclose()

        async def relay():
            error = None
            pending = b""
            try:
                async for chunk in upstream.aiter_bytes():
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        if line.startswith(b"data: ") and line[6:].strip() != b"[DONE]":
                            try:
                                item = json.loads(line[6:])
                                for choice in item.get("choices", []):
                                    delta = choice.get("delta", {})
                                    if (
                                        any(
                                            delta.get(k)
                                            for k in (
                                                "content",
                                                "reasoning_content",
                                                "tool_calls",
                                            )
                                        )
                                        and record["ttft"] is None
                                    ):
                                        record["ttft"] = time.monotonic() - started
                                if item.get("usage"):
                                    record["output_tokens"] = item["usage"].get(
                                        "completion_tokens"
                                    )
                            except ValueError:
                                pass
                    if len(pending) > 1024 * 1024:
                        pending = b""
                    yield chunk
            except asyncio.CancelledError:
                error = "client_cancelled"
                raise
            except Exception as exc:
                error = redact(str(exc))
                raise
            finally:
                try:
                    await upstream.aclose()
                finally:
                    finish(error)

        return StreamingResponse(
            relay(),
            media_type="text/event-stream",
            headers={
                "X-Request-ID": correlation,
                "X-Menagerie-Deployment": d["id"],
                "X-Accel-Buffering": "no",
            },
        )

    dist = Path(__file__).resolve().parent / "static"
    if not dist.exists():
        dist = ROOT / "frontend/dist"
    if dist.exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/favicon.svg")
        async def favicon():
            return FileResponse(dist / "favicon.svg", media_type="image/svg+xml")

        @app.get("/logo.png")
        async def logo():
            return FileResponse(dist / "logo.png", media_type="image/png")

        @app.get("/logo-mono.png")
        async def logo_mono():
            return FileResponse(dist / "logo-mono.png", media_type="image/png")

        @app.get("/")
        async def index():
            return FileResponse(
                dist / "index.html", headers={"Cache-Control": "no-store"}
            )
    else:

        @app.get("/")
        async def missing_dashboard():
            return JSONResponse(
                {
                    "error": "Dashboard assets missing. Build frontend with npm ci && npm run build, or install a Menagerie wheel."
                },
                status_code=503,
            )

    return app
