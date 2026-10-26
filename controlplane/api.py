import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from . import adapters, lifecycle, deployment_sets
from .jobs import Jobs
from .manager import Manager, Conflict, ACTIVE, redact
from .schema import Artifact, Runtime, Profile, Deployment, DeploymentSet, Settings
from .store import Store, encode, identity, uid
from .catalog import normalize, export_config

ROOT = Path(__file__).resolve().parent.parent


def create_app(state=None, dashboard_address=None, gateway_port=8001):
    store = Store(state or os.environ.get("MENAGERIE_STATE", str(Path.home() / ".local/state/menagerie")))
    manager = Manager(store)
    gateway_url = f"http://127.0.0.1:{gateway_port}/v1"
    jobs = Jobs(manager)
    csrf = secrets.token_urlsafe(32)
    @asynccontextmanager
    async def lifespan(app):
        os.umask(0o077)
        for job in store.list("job"):
            if job["state"] in {"RUNNING", "QUEUED"}:
                store.put("job", job | {"state": "FAILED", "error": "Daemon interrupted this job; retry explicitly"}, historical=False)
        await manager.start()
        yield
        await manager.close()
    app = FastAPI(title="Menagerie Control Plane", version="2.0.0", lifespan=lifespan)
    app.state.manager, app.state.store = manager, store

    def deployment_rows():
        settings = manager.settings()
        result = []
        for unit in deployment_sets.units(store):
            for d in unit["members"]:
                published = lifecycle.visible(d | {"state": deployment_sets.state(unit)}, settings)
                result.append(d | {"unit_id": unit["id"], "unit_name": unit["name"], "lifecycle": lifecycle.describe(d, settings) | {"serving": published}})
        return result

    def serving_rows():
        return [deployment_sets.describe(u, manager.settings(), manager.inflight) for u in deployment_sets.units(store)]

    def save_set(data, expected=None, c=None):
        # Caller owns the admission lock and the registry transaction.
        previous = next((u for u in store.list("deployment_set", c) if u["id"] == data.get("id")), None)
        if previous:
            data = previous | data
        ident = data.setdefault("id", uid())
        if any(d["id"] == ident for d in store.list("deployment", c)):
            raise Conflict("Deployment ID is already used by a model member")
        affected = set(data["member_ids"]) | set(previous["member_ids"] if previous else [])
        members = [store.get("deployment", i, c) for i in affected]
        if any(d["state"] in ACTIVE or manager.inflight.get(d["id"], 0) for d in members):
            raise Conflict("Unload all affected models before changing deployment membership or policy")
        for other in store.list("deployment_set", c):
            if other["id"] != ident and set(other["member_ids"]) & set(data["member_ids"]):
                raise Conflict("A model can belong to only one deployment")
        saved = store.put("deployment_set", data, expected, c=c)
        for i in data["member_ids"]:
            d = store.get("deployment", i, c)
            store.put("deployment", d | {k: saved[k] for k in deployment_sets.POLICY_KEYS}, c=c)
        store.event("deployment_configuration", {"name": saved["name"], "members": saved["member_ids"]}, ident, c)
        return saved

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({"error": str(exc)}, status_code=404)

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse({"error": str(exc)}, status_code=409 if isinstance(exc, Conflict) else 400)

    @app.middleware("http")
    async def boundary(request, call_next):
        host = request.url.hostname
        allowed_hosts = {"127.0.0.1", "localhost", "openchamber-preview.localhost", "testserver"}
        if dashboard_address:
            allowed_hosts.add(dashboard_address)
        if host not in allowed_hosts:
            return JSONResponse({"error": "Configured dashboard host required"}, 403)
        # Trust the accepted socket, never Host/Forwarded headers, for isolation.
        local_address = (request.scope.get("server") or (None, None))[0]
        if dashboard_address and local_address == dashboard_address:
            path = request.url.path
            if path == "/models" or path == "/v1" or path.startswith("/v1/"):
                return JSONResponse({"error": "Inference API is available on loopback only"}, 403)
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse({"error": "Same-origin requests required"}, 403)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.url.path.startswith("/api/"):
                if not secrets.compare_digest(request.headers.get("x-menagerie-token", ""), csrf):
                    return JSONResponse({"error": "Current dashboard token required"}, 403)
            try:
                length = int(request.headers.get("content-length", "0"))
            except ValueError:
                return JSONResponse({"error": "Invalid content length"}, 400)
            if length > 16 * 1024 * 1024:
                return JSONResponse({"error": "Request body exceeds 16 MiB"}, 413)
            if request.headers.get("transfer-encoding"):
                return JSONResponse({"error": "Content-Length required; chunked request bodies are not accepted"}, 411)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/status")
    async def status():
        return {"version": "2.0.0", "csrf_token": csrf, "host": manager.host,
                "deployments": [d | {"inflight": manager.inflight.get(d["id"], 0)} for d in deployment_rows()],
                "serving_deployments": serving_rows(), "queue": manager.waiting, "settings": manager.settings(), "gateway": "/v1", "gateway_url": gateway_url, "state_path": str(store.root)}

    @app.get("/health")
    async def health():
        return {"ok": True, "service": "menagerie", "active": [d["id"] for d in store.list("deployment") if d["state"] == "READY"], "inflight": manager.inflight}

    kinds = {"models": "artifact", "runtimes": "runtime", "profiles": "profile", "deployments": "deployment", "jobs": "job", "deployment_sets": "deployment_set"}
    @app.get("/api/registry/{kind}")
    async def registry(kind: str):
        if kind not in kinds:
            raise HTTPException(404)
        if kind == "deployments":
            return deployment_rows()
        if kind == "runtimes":
            return [r | {"capabilities": r.get("capabilities", {}) | {"schema": adapters.option_schema(r)}} for r in store.list("runtime")]
        return store.list(kinds[kind])

    @app.get("/api/models")
    async def models():
        return store.list("artifact")

    @app.get("/api/deployments")
    async def deployments():
        return deployment_rows()

    @app.get("/api/serving-deployments")
    async def serving_deployments():
        return serving_rows()

    @app.post("/api/deployment-sets")
    async def save_deployment_set(body: DeploymentSet, expected: int | None = None):
        async with manager.lock:
            with store.transaction() as c:
                data = body.model_dump(exclude_none=True)
                drafts = data.pop("members", None)
                if drafts is not None:
                    if data["member_ids"] or not drafts:
                        raise ValueError("Provide one or more model configurations, not member IDs")
                    previous = store.get("deployment_set", data["id"], c) if data.get("id") else None
                    owned = set(previous["member_ids"] if previous else [])
                    ids = [m["id"] for m in drafts if m.get("id")]
                    if len(ids) != len(set(ids)) or any(i not in owned for i in ids):
                        raise Conflict("Existing members must belong to this deployment; copy their configuration to reuse a model")
                    affected = [store.get("deployment", i, c) for i in owned]
                    if any(d["state"] in ACTIVE or manager.inflight.get(d["id"], 0) for d in affected):
                        raise Conflict("Unload the deployment before editing its models")
                    data["member_ids"] = []
                    for draft in drafts:
                        draft.update({k: data[k] for k in deployment_sets.POLICY_KEYS})
                        member = save_member(draft, c=c, owner_id=data.get("id"))
                        data["member_ids"].append(member["id"])
                    for removed in owned - set(data["member_ids"]):
                        d = store.get("deployment", removed, c)
                        store.put("deployment", d | {"enabled": False}, c=c)
                if not data["member_ids"]:
                    raise ValueError("A deployment requires at least one model")
                return save_set(data, expected, c)

    @app.post("/api/serving-deployments/{ident}/validate")
    async def validate_serving(ident: str):
        return manager.plan([ident])

    @app.post("/api/serving-deployments/{ident}/start")
    async def start_serving(ident: str, request: Request):
        body = await request.json()
        if not body.get("plan_token"):
            raise Conflict("Review the launch plan first")
        unit = manager.unit(ident)
        return jobs.submit("Load " + unit["name"], lambda job: manager.activate([ident], body.get("override", False), token=body["plan_token"]))

    @app.post("/api/serving-deployments/{ident}/stop")
    async def stop_serving(ident: str):
        unit = manager.unit(ident)
        return jobs.submit("Unload " + unit["name"], lambda job: manager.stop(ident))

    @app.post("/api/serving-deployments/{ident}/enabled")
    async def enable_serving(ident: str, request: Request):
        enabled = (await request.json()).get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be true or false")
        async with manager.lock:
            unit = manager.unit(ident)
            if any(d["state"] in ACTIVE for d in unit["members"]) or manager.unit_busy(unit):
                raise Conflict("Unload the deployment before changing client availability")
            with store.transaction() as c:
                if unit["multi_model"]:
                    stored = store.get("deployment_set", unit["id"], c)
                    store.put("deployment_set", stored | {"enabled": enabled}, c=c)
                for i in unit["member_ids"]:
                    store.put("deployment", store.get("deployment", i, c) | {"enabled": enabled}, c=c)
                store.event("deployment", {"enabled": enabled, "name": unit["name"]}, unit["id"], c)
            return deployment_sets.describe(manager.unit(ident), manager.settings(), manager.inflight)

    @app.post("/api/deployment-sets/{ident}/dissolve")
    async def dissolve_set(ident: str, expected: int):
        async with manager.lock:
            unit = manager.unit(ident)
            if not unit["multi_model"] or unit["id"] != ident or unit["revision"] != expected:
                raise Conflict("Deployment changed; refresh before separating models")
            if manager.unit_busy(unit) or any(d["state"] in ACTIVE for d in unit["members"]):
                raise Conflict("Unload the deployment before separating models")
            with store.transaction() as c:
                c.execute("DELETE FROM objects WHERE kind='deployment_set' AND id=?", (ident,))
                store.event("deployment_separated", {"name": unit["name"], "members": unit["member_ids"]}, ident, c)
            return {"member_ids": unit["member_ids"]}

    @app.post("/api/models/import")
    async def import_model(request: Request):
        body = await request.json()
        async def work(ident):
            jobs.progress(ident, "Reading metadata and hashing weights")
            artifact = await asyncio.to_thread(adapters.inspect_artifact, body["path"], True)
            artifact.update(id="artifact-" + (artifact["sha256"] or identity(artifact["local_path"]))[:20], source="local")
            existing = next((a for a in store.list("artifact") if a.get("sha256") and a["sha256"] == artifact["sha256"] or a["local_path"] == artifact["local_path"]), None)
            return existing or store.put("artifact", artifact)
        return jobs.submit("Import local artifact", work)

    @app.post("/api/runtimes")
    async def runtime(body: Runtime):
        data = body.model_dump(exclude_none=True)
        if data["execution_kind"] == "native":
            data["executable"] = str(Path(data["executable"]).expanduser().resolve())
        if data.get("id") and any(d["state"] in ACTIVE and d["profile_snapshot"]["runtime_id"] == data["id"] for d in store.list("deployment")):
            raise Conflict("Cannot change a runtime used by an active deployment")
        data["capabilities"] = await adapters.probe(data)
        if data.get("id"):
            try:
                previous = store.get("runtime", data["id"])
            except KeyError:
                previous = None
            keys = ("engine", "execution_kind", "executable", "env", "command_template")
            if previous and (any(previous.get(k) != data.get(k) for k in keys) or previous["capabilities"].get("sha256") != data["capabilities"].get("sha256")):
                raise Conflict("Runtime installations are version-specific. Clone/register a new installation instead of changing its executable or launch identity.")
        return store.put("runtime", data)

    @app.get("/api/runtimes/{ident}/capabilities")
    async def capabilities(ident: str):
        runtime = store.get("runtime", ident)
        return runtime["capabilities"] | {"schema": adapters.option_schema(runtime)}

    @app.post("/api/profiles")
    async def profile(body: Profile, expected: int | None = None):
        data = body.model_dump(exclude_none=True)
        artifact, runtime = store.get("artifact", data["artifact_id"]), store.get("runtime", data["runtime_id"])
        errors = adapters.validate_profile(data, artifact, runtime)
        if errors:
            raise ValueError("; ".join(errors))
        catalog = data.get("catalog", {})
        if catalog.get("model"):
            limits = catalog["model"].setdefault("limit", {})
            context = data["config"].get("ctx-size", data["config"].get("max-model-len"))
            if context:
                limits["context"] = context // data["config"].get("parallel", 1)
                limits["output"] = min(limits.get("output", 8192), limits["context"])
        data["catalog"] = normalize(data)
        return store.put("profile", data, expected=expected)

    @app.get("/api/profiles/{ident}/revisions")
    async def profile_revisions(ident: str):
        return store.history("profile", ident)

    @app.post("/api/deployments")
    async def deployment(body: Deployment, expected: int | None = None):
        async with manager.lock:
            with store.transaction() as c:
                saved = save_member(body.model_dump(exclude_none=True), expected, c)
                owner = deployment_sets.unit_for(store, saved["id"])
                if owner and owner["multi_model"]:
                    store.put("deployment_set", store.get("deployment_set", owner["id"], c), c=c)
                return saved

    def save_member(data, expected=None, c=None, owner_id=None):
        all_d = store.list("deployment", c)
        previous = next((d for d in all_d if d["id"] == data.get("id")), None)
        owner = deployment_sets.unit_for(store, data["id"]) if data.get("id") else None
        if owner and owner["multi_model"]:
            if any(m["state"] in ACTIVE for m in owner["members"]):
                raise Conflict("Unload the whole deployment before editing a model")
            if owner["id"] != owner_id and any(data[k] != owner[k] for k in deployment_sets.POLICY_KEYS):
                raise Conflict("Edit the deployment's shared policy instead of an individual model")
        if previous and (previous["state"] in ACTIVE or manager.inflight.get(previous["id"], 0)):
            raise Conflict("Stop this deployment before changing its configuration")
        if data["port"] in {8001, 8017}:
            raise ValueError("Ports 8001 and 8017 are reserved for Menagerie")
        if any(d["id"] != data.get("id") and (d["alias"] == data["alias"] or d["port"] == data["port"]) for d in all_d):
            raise Conflict("Alias and port must be unique")
        configuration = data.pop("configuration", None)
        if configuration is not None:
            configuration.pop("id", None)
            artifact = store.get("artifact", configuration["artifact_id"], c)
            runtime = store.get("runtime", configuration["runtime_id"], c)
            errors = adapters.validate_profile(configuration, artifact, runtime)
            if errors:
                raise ValueError("; ".join(errors))
            configuration["name"] = data["name"]
            configuration["catalog"] = normalize(configuration, data["alias"])
        elif not data.get("profile_id"):
            raise ValueError("Deployment configuration is required")
        if configuration is not None:
            # Private revision backing; never mutate another deployment's recipe.
            if previous:
                configuration["id"] = previous["profile_id"]
                if any(d["id"] != previous["id"] and d["profile_id"] == configuration["id"] for d in all_d):
                    configuration.pop("id")
            snapshot = store.put("profile", configuration, c=c)
            data["profile_id"] = snapshot["id"]
        else:
            snapshot = store.get("profile", data["profile_id"], c)
        data.update(state="STOPPED", profile_snapshot=snapshot, reservation_active=0)
        return store.put("deployment", data, expected, c=c)

    @app.post("/api/deployments/{ident}/validate")
    async def validate(ident: str):
        return manager.plan([ident])

    @app.post("/api/deployments/{ident}/start")
    async def start(ident: str, request: Request):
        body = await request.json()
        return jobs.submit("Start deployment", lambda job: manager.activate([ident], body.get("override", False), token=body.get("plan_token")))

    @app.post("/api/deployments/{ident}/stop")
    async def stop(ident: str):
        return jobs.submit("Stop deployment", lambda job: manager.stop(ident))

    @app.post("/api/deployments/{ident}/enabled")
    async def set_deployed(ident: str, request: Request):
        body = await request.json()
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be true or false")
        async with manager.lock:
            d = store.get("deployment", ident)
            if manager.unit(ident)["multi_model"]:
                raise Conflict("Change client availability on the whole deployment")
            if d["state"] in ACTIVE:
                raise Conflict("Stop this deployment before changing whether it is deployed")
            if d["enabled"] != enabled:
                store.put("deployment", d | {"enabled": enabled}, historical=False)
                store.event("deployment", {"alias": d["alias"], "enabled": enabled}, ident)
            return store.get("deployment", ident)

    @app.get("/api/deployments/{ident}/logs")
    async def logs(ident: str):
        d = store.get("deployment", ident)
        path = Path(d.get("log_path", str(store.root / "missing")))
        if not path.is_file():
            return {"text": "No runtime log yet"}
        with path.open("rb") as f:
            f.seek(max(0, path.stat().st_size - 65536))
            return {"text": f.read().decode(errors="replace")}

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
                for event in store.events(cursor):
                    cursor = event["seq"]
                    yield f"id: {cursor}\nevent: operation\ndata: {encode(event)}\n\n"
                yield f"event: telemetry\ndata: {encode(manager.host)}\n\n"
                await asyncio.sleep(manager.settings()["sample_seconds"])
        return StreamingResponse(generate(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    @app.get("/api/history/sessions")
    async def sessions():
        return sorted(store.list("session"), key=lambda x: x["started_at"], reverse=True)

    @app.post("/api/history/sessions/{ident}/restore")
    async def restore(ident: str):
        session = store.get("session", ident)
        p = dict(session["deployment_snapshot"]["profile_snapshot"])
        p.pop("revision", None)
        p["id"] = uid()
        p["name"] += " (restored)"
        with store.transaction() as c:
            for kind, key, snapshot_key in (("artifact", "artifact_id", "artifact_identity"), ("runtime", "runtime_id", "runtime_identity")):
                saved = session[snapshot_key]
                try:
                    current = store.get(kind, saved["id"], c)
                except KeyError:
                    current = None
                if current is None:
                    current = store.put(kind, saved, c=c)
                elif (kind == "runtime" and current.get("capabilities", {}).get("sha256") != saved.get("capabilities", {}).get("sha256")) or (kind == "artifact" and current.get("sha256") != saved.get("sha256")):
                    current = store.put(kind, saved | {"id": uid()}, c=c)
                p[key] = current["id"]
            p = store.put("profile", p, c=c)
            saved = session["deployment_snapshot"]
            restored = {key: saved[key] for key in Deployment.model_fields if key in saved and key not in {"id", "configuration"}}
            restored.update(id=uid(), name=saved["name"] + " (restored)", profile_id=p["id"], profile_snapshot=p,
                            alias=saved["alias"][:140] + "-" + uid()[:8], enabled=False, state="STOPPED", reservation_active=0)
            used_ports = {d["port"] for d in store.list("deployment", c)} | {8001, 8017}
            restored["port"] = next(port for port in range(8120, 65536) if port not in used_ports)
            return store.put("deployment", restored, c=c)

    @app.get("/api/history/activations")
    async def activations():
        return sorted(store.list("activation"), key=lambda x: x["started_at"], reverse=True)

    @app.post("/api/history/activations/{ident}/restore")
    async def restore_activation(ident: str):
        saved = store.get("activation", ident)
        async with manager.lock:
            ports = {d["port"] for d in store.list("deployment")} | {8001, 8017}
            suffix = uid()[:6]
            deployments = []
            with store.transaction() as c:
                for snapshot in saved["deployments"]:
                    p = dict(snapshot["profile_snapshot"])
                    p["id"] = uid()
                    p["name"] += " (restored)"
                    p["catalog"] = normalize(p)
                    p["catalog"]["catalog_id"] += "-" + suffix
                    p = store.put("profile", p, c=c)
                    d = {k: v for k, v in snapshot.items() if k in Deployment.model_fields}
                    d.update(id=uid(), name=d["name"] + " (restored)", profile_id=p["id"], profile_snapshot=p, alias=d["alias"] + "-" + suffix, enabled=False, state="STOPPED", reservation_active=0)
                    d["port"] = next(port for port in range(8110, 65536) if port not in ports)
                    ports.add(d["port"])
                    deployments.append(store.put("deployment", d, c=c)["id"])
                policy = saved.get("deployment_policy", {"residency": "pinned", "priority": 50, "idle_timeout": 0, "allow_eviction": False, "allow_uncertain": False, "queue_timeout": 300})
                value = DeploymentSet(name="Restored " + (saved.get("deployment_name") or ident[:8]), member_ids=deployments, **(policy | {"enabled": False})).model_dump(exclude_none=True)
                return save_set(value | {"restored_from_activation": ident}, c=c)

    @app.get("/api/history/metrics")
    async def metric_history(hours: int = 24):
        hours = max(1, min(hours, 2160))
        with store.connect() as c:
            rows = c.execute("SELECT data FROM samples WHERE ts IN (SELECT min(ts) FROM samples WHERE ts>? GROUP BY CAST(ts/? AS INTEGER)) ORDER BY ts", (time.time() - hours * 3600, max(2, hours * 3600 // 500))).fetchall()
        return [json.loads(r[0]) for r in rows]

    @app.post("/api/history/purge")
    async def purge_history(request: Request):
        body = await request.json()
        days = body.get("older_than_days")
        if type(days) is not int or not 1 <= days <= 365 or body.get("confirm") is not True:
            raise ValueError("Confirm a telemetry purge threshold between 1 and 365 days")
        cutoff = time.time() - days * 86400
        with store.transaction() as c:
            samples = c.execute("DELETE FROM samples WHERE ts<?", (cutoff,)).rowcount
            requests = c.execute("DELETE FROM requests WHERE ts<?", (cutoff,)).rowcount
            store.event("purge", {"older_than_days": days, "samples": samples, "requests": requests}, c=c)
        return {"samples_removed": samples, "requests_removed": requests, "configuration_and_sessions_preserved": True}

    @app.get("/api/history/requests")
    async def requests():
        with store.connect() as c:
            return [dict(r) | {"data": json.loads(r["data"])} for r in c.execute("SELECT * FROM requests ORDER BY ts DESC LIMIT 300")]

    @app.post("/api/registry/{kind}/{ident}/delete")
    async def delete_record(kind: str, ident: str):
        if kind not in {"models", "runtimes", "profiles", "deployments"}:
            raise HTTPException(404)
        async with manager.lock:
            row = store.get(kinds[kind], ident)
            deployments = store.list("deployment")
            if kind == "deployments":
                if manager.unit(ident)["multi_model"]:
                    raise Conflict("Separate this model from its deployment before removing it")
                if row["state"] in ACTIVE:
                    raise Conflict("Unload the deployment first")
            if kind in {"models", "runtimes", "profiles"}:
                key = {"models": "artifact_id", "runtimes": "runtime_id", "profiles": "id"}[kind]
                if any(d["profile_snapshot"].get(key) == ident for d in deployments):
                    raise Conflict("Deployment snapshots still reference this record")
                if kind != "profiles" and any(p.get(key) == ident for p in store.list("profile")):
                    raise Conflict("Profiles still reference this record")
            with store.transaction() as c:
                c.execute("DELETE FROM objects WHERE kind=? AND id=?", (kinds[kind], ident))
                store.event("delete", {"kind": kind, "id": ident, "note": "Disk artifacts and historical revisions retained"}, c=c)
            return {"deleted": ident, "disk_files_preserved": True}

    @app.post("/api/settings")
    async def settings(body: Settings):
        return store.put("settings", body.model_dump() | {"id": "host"})

    @app.post("/api/backup")
    async def backup():
        return {"path": str(await asyncio.to_thread(store.backup))}

    @app.get("/api/catalog/hf")
    async def hf_search(q: str):
        return await jobs.hf_search(q)

    @app.get("/api/catalog/hf/files")
    async def hf_files(repo: str, revision: str = "main"):
        return await jobs.hf_files(repo, revision)

    @app.get("/api/catalog/hf/revisions")
    async def hf_revisions(repo: str):
        return await jobs.hf_revisions(repo)

    @app.get("/api/catalog/hf/quantizations")
    async def hf_quantizations(repo: str):
        return await jobs.hf_quantizations(repo)

    @app.get("/api/catalog/ollama/search")
    async def ollama_search(q: str = ""):
        from .discovery import ollama_catalog
        return await ollama_catalog(manager.client, query=q)

    @app.get("/api/catalog/ollama/variants")
    async def ollama_variants(model: str):
        from .discovery import ollama_catalog
        return await ollama_catalog(manager.client, model=model)

    @app.post("/api/downloads")
    async def download(request: Request):
        body = await request.json()
        return jobs.submit("Download model", lambda job: jobs.download(job, body["repo"], body["revision"], body["filename"]))

    @app.get("/api/catalog/ollama")
    async def ollama():
        try:
            response = await manager.client.get("http://127.0.0.1:11434/api/tags", timeout=3)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError:
            return {"models": [], "note": "Ollama is not reachable. Blobs are not reinterpreted as GGUF files."}

    @app.post("/api/catalog/ollama/pull")
    async def ollama_pull(request: Request):
        import re
        body = await request.json()
        name = body.get("name", "")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,199}", name):
            raise ValueError("Invalid Ollama model name")
        async def action(ident):
            async with manager.client.stream("POST", "http://127.0.0.1:11434/api/pull", json={"model": name, "stream": True}) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    progress = json.loads(line)
                    if progress.get("error"):
                        raise ValueError(progress["error"])
                    jobs.progress(ident, f"{progress.get('status', 'Downloading')} · {progress.get('completed', 0):,} / {progress.get('total', 0):,} bytes")
            return {"model": name, "storage_owner": "Ollama", "note": "Ollama owns its blob format. Direct use with other engines is not assumed."}
        return jobs.submit("Ollama pull", action)

    @app.post("/api/runtimes/install/preview")
    async def install_preview(request: Request):
        return jobs.install_plan(await request.json())

    @app.post("/api/runtimes/install")
    async def install(request: Request):
        body = await request.json()
        if not body.get("trust"):
            raise ValueError("Explicit source trust required")
        return jobs.submit("Build runtime", lambda job: jobs.install(job, body, body["token"]))

    @app.post("/api/runtimes/pull")
    async def pull_image(request: Request):
        body = Runtime.model_validate(await request.json()).model_dump(exclude_none=True)
        if body["execution_kind"] not in {"docker", "podman"} or not body["trust"] or "@sha256:" not in body["executable"]:
            raise ValueError("Trusted digest-pinned OCI image required")
        async def action(job):
            await adapters.command([body["execution_kind"], "pull", body["executable"]], timeout=3600)
            body["capabilities"] = await adapters.probe(body)
            return store.put("runtime", body)
        return jobs.submit("Pull runtime image", action)

    def catalog_rows():
        rows = []
        settings = manager.settings()
        for d in store.list("deployment"):
            unit = manager.unit(d["id"])
            if not lifecycle.visible(d | {"state": deployment_sets.state(unit)}, settings):
                continue
            catalog = normalize(d["profile_snapshot"], d["alias"])
            catalog["catalog_id"] = d["alias"]
            catalog["model"]["name"] = d["name"]
            rows.append({"id": d["alias"], "object": "model", "created": 0, "owned_by": "menagerie", "shelf": catalog, "menagerie": {"deployment_id": d["id"], "state": d["state"], "residency": d["residency"]}})
        return rows

    @app.post("/api/integration/opencode/export")
    async def export_opencode():
        path = export_config(store.root, catalog_rows(), gateway_url)
        return {"path": str(path), "note": "Managed fragment only; unrelated client settings are never overwritten. Dynamic-discovery clients read /v1/models automatically."}

    @app.get("/v1/models")
    @app.get("/models")
    async def served_models():
        rows = catalog_rows()
        export_config(store.root, rows, gateway_url)
        return {"object": "list", "data": rows}

    @app.get("/api/integration/opencode")
    async def opencode():
        return {"catalog": catalog_rows(), "endpoint": gateway_url, "discovery": "Capability metadata is included in /v1/models. Refresh behavior depends on the client.", "reload_note": "Generated config may require client reload; dynamic discovery refreshes separately."}

    @app.get("/metrics")
    async def metrics():
        lines = ["# TYPE menagerie_gateway_waiting gauge", f"menagerie_gateway_waiting {manager.waiting}"]
        for gpu in manager.host.get("gpus", []):
            for key in ("used_mib", "free_mib", "utilization", "temperature", "power_w"):
                if gpu[key] is not None:
                    lines.append(f'menagerie_gpu_{key}{{gpu="{gpu["index"]}"}} {gpu[key]}')
        for d in store.list("deployment"):
            lines.append(f'menagerie_deployment_ready{{deployment="{d["id"]}"}} {int(d["state"] == "READY")}')
            lines.append(f'menagerie_deployment_requests_active{{deployment="{d["id"]}"}} {manager.inflight.get(d["id"], 0)}')
        return PlainTextResponse("\n".join(lines) + "\n")

    @app.post("/v1/chat/completions")
    async def completion(request: Request):
        body = await request.json()
        correlation = uid()
        started = time.monotonic()
        try:
            d = await manager.acquire(body.get("model", ""))
        except KeyError:
            return JSONResponse({"error": {"message": "Unknown or disabled model alias", "type": "model_not_found", "correlation_id": correlation}}, 404)
        except (Conflict, TimeoutError) as exc:
            return JSONResponse({"error": {"message": str(exc) or "Model load queue timed out", "type": "deployment_unavailable", "retry_after": 5, "correlation_id": correlation}}, 429 if "queue is full" in str(exc) else 503, headers={"Retry-After": "5"})
        record = {"model_alias": d["alias"], "correlation_id": correlation, "error": None, "ttft": None, "output_tokens": None}
        def finish(error=None):
            manager.release(d)
            record.update(latency=time.monotonic() - started, error=error)
            with store.connect() as c:
                c.execute("INSERT INTO requests VALUES(?,?,?,?)", (correlation, time.time(), d["id"], encode(record)))
            if d.get("session_id"):
                with store.transaction() as c:
                    session = store.get("session", d["session_id"], c)
                    session["request_count"] = session.get("request_count", 0) + 1
                    session["error_count"] = session.get("error_count", 0) + int(error is not None)
                    session["output_tokens"] = session.get("output_tokens", 0) + (record["output_tokens"] or 0)
                    session["total_request_seconds"] = session.get("total_request_seconds", 0) + record["latency"]
                    store.put("session", session, historical=False, c=c)
        body["model"] = d["alias"]
        sending = asyncio.create_task(manager.client.send(manager.client.build_request("POST", f"http://127.0.0.1:{d['port']}/v1/chat/completions", json=body, headers={"X-Request-ID": correlation}), stream=True))
        try:
            while not sending.done():
                await asyncio.wait({sending}, timeout=.25)
                if await request.is_disconnected():
                    sending.cancel()
                    await asyncio.gather(sending, return_exceptions=True)
                    if not sending.cancelled() and sending.exception() is None:
                        await sending.result().aclose()
                    finish("client_cancelled")
                    return JSONResponse({"error": {"message": "Client disconnected"}}, 499)
            upstream = await sending
        except asyncio.CancelledError:
            sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)
            finish("client_cancelled")
            raise
        except httpx.HTTPError as exc:
            finish(redact(str(exc)))
            return JSONResponse({"error": {"message": "Upstream unavailable", "correlation_id": correlation}}, 502)
        if upstream.status_code != 200:
            raw = await upstream.aread()
            await upstream.aclose()
            finish(f"Upstream HTTP {upstream.status_code}")
            return PlainTextResponse(raw, status_code=upstream.status_code, media_type="application/json", headers={"X-Request-ID": correlation})
        if not body.get("stream"):
            try:
                data = json.loads(await upstream.aread())
                record["output_tokens"] = data.get("usage", {}).get("completion_tokens")
                record["generation_tok_s"] = data.get("timings", {}).get("predicted_per_second")
                record["prefill_tok_s"] = data.get("timings", {}).get("prompt_per_second")
                finish()
                return JSONResponse(data, headers={"X-Request-ID": correlation, "X-Menagerie-Deployment": d["id"]})
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
                                    if any(delta.get(k) for k in ("content", "reasoning_content", "tool_calls")) and record["ttft"] is None:
                                        record["ttft"] = time.monotonic() - started
                                if item.get("usage"):
                                    record["output_tokens"] = item["usage"].get("completion_tokens")
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
                await upstream.aclose()
                finish(error)
        return StreamingResponse(relay(), media_type="text/event-stream", headers={"X-Request-ID": correlation, "X-Menagerie-Deployment": d["id"], "X-Accel-Buffering": "no"})

    dist = ROOT / "frontend/dist"
    if dist.exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
        @app.get("/favicon.svg")
        async def favicon():
            return FileResponse(dist / "favicon.svg", media_type="image/svg+xml")
        @app.get("/")
        async def index():
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-store"})
    return app
