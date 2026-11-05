import asyncio
import contextlib
import json
import logging
import math
import re
import shutil
import socket
import time
from pathlib import Path

import httpx
import psutil

from . import (
    adapters,
    deployment_sets,
    host,
    processes,
    resource_history,
    resources,
    telemetry,
    templates,
)
from .schema import Settings
from .store import encode, identity, uid

logger = logging.getLogger("menagerie")

ACTIVE = {"QUEUED", "STARTING", "LOADING", "READY", "DEGRADED", "STOPPING"}
TRANSITIONS = {
    "DRAFT": {"VALIDATING", "STOPPED"},
    "STOPPED": {"VALIDATING"},
    "FAILED": {"VALIDATING", "STOPPED"},
    "ERROR": {"VALIDATING", "STOPPED"},
    "VALIDATING": {"QUEUED", "FAILED", "STOPPED"},
    "QUEUED": {"STARTING", "FAILED", "STOPPING"},
    "STARTING": {"LOADING", "FAILED", "STOPPING"},
    "LOADING": {"READY", "FAILED", "STOPPING"},
    "READY": {"DEGRADED", "STOPPING", "FAILED"},
    "DEGRADED": {"READY", "STOPPING", "FAILED"},
    "STOPPING": {"STOPPED", "FAILED"},
}


class Conflict(ValueError):
    pass


def redact(text):
    text = re.sub(
        r"(?i)(bearer\s+|(?:api[_-]?key|token|authorization)[=:]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        text,
    )
    return re.sub(r"\bhf_[a-zA-Z0-9]+\b", "[REDACTED]", text)


class Manager:
    def __init__(self, store):
        self.store = store
        self.lock = asyncio.Lock()
        self.processes = {}
        self.inflight = {}
        self.waiting = 0
        self.last_use = {}
        self.tasks = set()
        self.host = {"gpus": [], "errors": ["Collecting hardware baseline"]}
        self.client = httpx.AsyncClient(
            trust_env=False,
            timeout=httpx.Timeout(1800, connect=5),
            limits=httpx.Limits(max_connections=128),
        )
        self.stopping = False
        self.file_lock = None
        self.loop_task = None
        self.was_pressure = False
        self.verified_artifacts = {}
        self.request_changed = asyncio.Event()
        self.collector = {
            "consecutive_errors": 0,
            "last_error": None,
            "last_error_at": None,
        }

    def unit(self, ident):
        unit = deployment_sets.unit_for(self.store, ident)
        if unit is None:
            raise KeyError(f"Unknown deployment: {ident}")
        return unit

    def runtime_port(self, deployment):
        unit = self.unit(deployment["id"])
        return (
            unit["members"][0]["port"]
            if unit.get("engine_pool")
            else deployment["port"]
        )

    def unit_busy(self, unit):
        return any(self.inflight.get(i, 0) for i in unit["member_ids"])

    async def wait_for_requests(self):
        # Call only after releasing the admission lock: an in-flight model may
        # need to call another member before its own request can finish.
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self.request_changed.wait(), 1)

    def automatic_stops(self, ids):
        selected = deployment_sets.expand(self.store, ids)
        priority = min(self.unit(i)["priority"] for i in selected)
        deficits = {}
        for gpu in self.host.get("gpus", []):
            needed = sum(
                self.estimate(d)["peak_mib"] or 0
                for d in (self.store.get("deployment", i) for i in selected)
                if d["gpu"] == gpu["index"] and d["state"] not in ACTIVE
            )
            deficits[gpu["index"]] = max(
                0,
                needed - max(0, gpu["free_mib"] - self.settings()["gpu_headroom_mib"])
                if gpu.get("free_mib") is not None
                else 0,
            )
        candidates = [
            u
            for u in deployment_sets.units(self.store)
            if not set(u["member_ids"]) & set(selected)
            and u["residency"] != "pinned"
            and u["allow_eviction"]
            and u["priority"] <= priority
            and any(d["state"] in ACTIVE for d in u["members"])
        ]
        candidates.sort(
            key=lambda u: (self.unit_busy(u), u["priority"], self.unit_last_use(u))
        )
        stops = []
        for unit in candidates:
            freed = {}
            for d in unit["members"]:
                if d["state"] in ACTIVE:
                    metrics = self.host.get("deployments", {}).get(d["id"], {})
                    by_device = metrics.get("gpu_by_device_mib")
                    if by_device is None and len(self.host.get("gpus", [])) == 1:
                        by_device = {str(d["gpu"]): metrics.get("gpu_mib")}
                    for index, measured in (by_device or {}).items():
                        if measured is not None:
                            gpu_index = int(index)
                            freed[gpu_index] = freed.get(gpu_index, 0) + measured
            if any(
                deficits.get(gpu, 0) > 0 and amount > 0 for gpu, amount in freed.items()
            ):
                stops.extend(unit["member_ids"])
                for gpu, amount in freed.items():
                    deficits[gpu] = max(0, deficits.get(gpu, 0) - amount)
        return stops

    def plan(self, ids):
        return self.validate(ids, self.automatic_stops(ids))

    def unit_last_use(self, unit):
        return max(
            self.last_use.setdefault(i, time.monotonic()) for i in unit["member_ids"]
        )

    async def _stop_unit_locked(self, ident, reason):
        unit = self.unit(ident)
        if self.unit_busy(unit):
            raise Conflict(
                "Deployment has active requests; let them finish before unloading"
            )
        for i in reversed(unit["member_ids"]):
            await self._stop(i, reason)

    def settings(self):
        try:
            return Settings.model_validate(
                {
                    k: v
                    for k, v in self.store.get("settings", "host").items()
                    if k not in {"id", "revision"}
                }
            ).model_dump()
        except KeyError:
            return Settings().model_dump()

    def spawn(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def transition(self, ident, state, reason=None, **extra):
        from .activity import operation_id

        with self.store.transaction() as c:
            d = self.store.get("deployment", ident, c)
            if state != d["state"] and state not in TRANSITIONS.get(d["state"], set()):
                raise Conflict(f"Invalid transition {d['state']} → {state}")
            old = d["state"]
            correlation = operation_id.get() or (
                uid()
                if (
                    state in {"VALIDATING", "STOPPING"}
                    and state != old
                    or old in {"READY", "DEGRADED"}
                    and state in {"READY", "DEGRADED", "FAILED"}
                    and state != old
                )
                else d.get("operation_id") or uid()
            )
            d.update(
                extra,
                state=state,
                state_since=time.time(),
                failure_reason=reason,
                operation_id=correlation,
            )
            self.store.put("deployment", d, historical=False, c=c)
            self.store.event(
                "state",
                {
                    "from": old,
                    "to": state,
                    "reason": reason,
                    "operation_id": correlation,
                    "session_id": d.get("session_id"),
                    "name": d["name"],
                },
                ident,
                c,
            )
        return d

    def owned(self, d):
        return processes.owned(d)

    async def start(self):
        self.file_lock = host.lock_file(self.store.root / "daemon.lock")
        self.host = await asyncio.to_thread(telemetry.sample)
        for d in self.store.list("deployment"):
            if d["state"] in ACTIVE | {"VALIDATING"}:
                if self.owned(d) and d["state"] in {"READY", "DEGRADED"}:
                    ready = await self.ready(d)
                    self.transition(
                        d["id"],
                        "READY" if ready else "DEGRADED",
                        None if ready else "Reconciled process is not ready",
                    )
                else:
                    runtime = self.store.get(
                        "runtime", d["profile_snapshot"]["runtime_id"]
                    )
                    if self.owned(d) or runtime["execution_kind"] != "native":
                        await self._terminate(d)
                    self.transition(
                        d["id"],
                        "FAILED",
                        "Daemon interrupted; incomplete launch not replayed",
                        reservation_active=0,
                        pid=None,
                    )
                    self.finish_session(d, "interrupted")
        self.store.event("daemon", {"state": "ready"})
        self.loop_task = asyncio.create_task(self.monitor())
        resume = [
            i
            for unit in deployment_sets.units(self.store)
            if unit["residency"] == "pinned"
            and any(d.get("resume_on_boot") for d in unit["members"])
            and any(d["state"] not in ACTIVE for d in unit["members"])
            for i in unit["member_ids"]
        ]
        if resume:

            async def restore_pinned():
                try:
                    await self.activate(resume)
                except Exception as exc:
                    self.store.event(
                        "recovery_required",
                        {"error": redact(str(exc)), "deployments": resume},
                    )

            self.spawn(restore_pinned())

    async def close(self):
        self.stopping = True
        if self.loop_task:
            self.loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.loop_task
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        # Graceful daemon stop owns its children. Unclean restarts reconcile by PID identity.
        async with self.lock:
            for d in self.store.list("deployment"):
                if d["state"] in ACTIVE:
                    resume = d["residency"] == "pinned" and d["state"] in {
                        "READY",
                        "DEGRADED",
                    }
                    await self._stop(d["id"], "Daemon shutdown", force=True)
                    if resume:
                        saved = self.store.get("deployment", d["id"])
                        self.store.put(
                            "deployment",
                            saved | {"resume_on_boot": True},
                            historical=False,
                        )
        await self.client.aclose()
        if self.file_lock:
            self.file_lock.close()

    def estimate(self, d):
        p = d["profile_snapshot"]
        a = self.store.get("artifact", p["artifact_id"])
        runtime = self.store.get("runtime", p["runtime_id"])
        fingerprint = resources.profile_hash(p, a, runtime, d.get("gpu", 0))
        measured = [
            s
            for s in resource_history.retained(self.store, self.settings())
            if resources.run_profile_hash(s) == fingerprint
            and not s.get("pool_aggregate")
        ]
        result = resources.estimate(a, p["config"], measured)
        observation = adapters.runtime_protocol.observation(self.store, d) or {}
        memory = observation.get("memory") or {}
        stage = "effective" if memory.get("effective") else "min"
        native = memory.get(stage)
        if result["basis"] != "observed" and native and native.get("devices"):
            devices = native["devices"]
            if all(
                all(type(device.get(k)) is int for k in ("model", "context", "compute"))
                for device in devices
            ):
                result.update(
                    peak_mib=sum(
                        sum(device[k] for k in ("model", "context", "compute"))
                        for device in devices
                        if device["kind"] == "device"
                    )
                    / 1048576,
                    ram_mib=sum(
                        sum(device[k] for k in ("model", "context", "compute"))
                        for device in devices
                        if device["kind"] == "host"
                    )
                    / 1048576
                    if any(device["kind"] == "host" for device in devices)
                    else None,
                    basis="engine",
                    components=None,
                    provenance=f"Runtime {stage} allocation report in bytes; not a process peak or fit guarantee. Projectors may be omitted.",
                )
        return result | {"profile_hash": fingerprint}

    def validate(self, ids, authorized_stops=None):
        duplicates = len(set(ids)) != len(ids)
        ids = deployment_sets.expand(self.store, ids)
        authorized_stops = deployment_sets.expand(self.store, authorized_stops or [])
        errors, warnings, estimates = [], [], {}
        all_d = self.store.list("deployment")
        selected = [self.store.get("deployment", i) for i in ids]
        from . import runtime_pool

        for unit in deployment_sets.units(self.store):
            if set(unit["member_ids"]) & set(ids):
                errors.extend(runtime_pool.validate(unit, self.store))
        if duplicates:
            errors.append("Duplicate models in deployment")
        if set(ids) & set(authorized_stops):
            errors.append("A deployment cannot be started and stopped in the same plan")
        for i in authorized_stops:
            self.store.get("deployment", i)
            if self.inflight.get(i, 0):
                warnings.append(
                    f"{self.store.get('deployment', i)['name']}: waiting for active requests to finish"
                )
        aliases = [d["alias"] for d in all_d]
        ports = [d["port"] for d in all_d]
        for d in selected:
            if not d["enabled"]:
                errors.append(f"{d['alias']} is disabled")
            if aliases.count(d["alias"]) > 1 or ports.count(d["port"]) > 1:
                errors.append(f"Duplicate alias or port: {d['alias']}")
            p = d["profile_snapshot"]
            a, r = (
                self.store.get("artifact", p["artifact_id"]),
                self.store.get("runtime", p["runtime_id"]),
            )
            selection = templates.effective_selection(d, a, self.store)
            errors += [
                f"{d['alias']}: {e}"
                for e in adapters.validate_profile(p, a, r, selection)
            ]
            if not Path(a["local_path"]).exists():
                errors.append(f"Missing artifact: {a['name']}")
            elif shards := (a.get("metadata", {}).get("shards") or []):
                if len(shards) < 2 or any(
                    not Path(s["path"]).is_file()
                    or Path(s["path"]).stat().st_size != s["size"]
                    for s in shards
                ):
                    errors.append(
                        f"Artifact shard set changed: {a['name']}; re-import before launch"
                    )
            elif (
                Path(a["local_path"]).is_file()
                and Path(a["local_path"]).stat().st_size != a["size_bytes"]
            ):
                errors.append(
                    f"Artifact size changed: {a['name']}; re-import before launch"
                )
            for key in (
                "mmproj",
                "spec-draft-model",
                "model-draft",
                "chat-template-file",
            ):
                if (
                    p["config"].get(key)
                    and not Path(p["config"][key]).expanduser().is_file()
                ):
                    errors.append(f"Missing auxiliary artifact for {d['alias']}: {key}")
            if d["state"] not in ACTIVE:
                sock = socket.socket()
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    sock.bind(("127.0.0.1", d["port"]))
                except OSError:
                    errors.append(f"Port {d['port']} is already occupied")
                finally:
                    sock.close()
            est = self.estimate(d)
            estimates[d["id"]] = est
        settings = self.settings()
        if shutil.disk_usage(self.store.root).free < 128 * 1024 * 1024:
            errors.append(
                "Insufficient registry/log disk capacity (128 MiB reserve required)"
            )
        for gpu in self.host.get("gpus", []):
            new = [
                d
                for d in selected
                if d["gpu"] == gpu["index"] and d["state"] not in ACTIVE
            ]
            needed = sum(estimates[d["id"]]["peak_mib"] or 0 for d in new)
            if (
                gpu.get("free_mib") is not None
                and needed > gpu["free_mib"] - settings["gpu_headroom_mib"]
                and not authorized_stops
            ):
                warnings.append(
                    f"GPU {gpu['index']}: {(needed - gpu['free_mib'] + settings['gpu_headroom_mib']) / 1024:.1f} GiB over budget"
                )
            if (
                gpu.get("free_mib") is not None
                and gpu["free_mib"] < settings["gpu_headroom_mib"]
                and not authorized_stops
            ):
                errors.append("GPU below desktop headroom gate")
        if any(
            str(d["profile_snapshot"]["config"].get("gpu-layers", "all")) != "0"
            and d["gpu"] is not None
            and d["gpu"] not in [g["index"] for g in self.host.get("gpus", [])]
            for d in selected
        ):
            warnings.append(
                "Selected GPU telemetry unavailable; memory accounting is unavailable"
            )
        if (
            self.host.get("ram_available_mib") is not None
            and self.host["ram_available_mib"] < settings["ram_headroom_mib"]
        ):
            errors.append("Host below RAM headroom gate")
        ram = [
            estimates[d["id"]]["ram_mib"] for d in selected if d["state"] not in ACTIVE
        ]
        if (
            all(v is not None for v in ram)
            and self.host.get("ram_available_mib") is not None
        ):
            over = (
                sum(ram) - self.host["ram_available_mib"] + settings["ram_headroom_mib"]
            )
            if over > 0:
                warnings.append(f"System RAM: {over / 1024:.1f} GiB over budget")
        plan = {
            "deployments": [
                {
                    "id": d["id"],
                    "profile": identity(d["profile_snapshot"]),
                    "revision": d["revision"],
                }
                for d in selected
            ],
            "authorized_stops": [
                {"id": i, "revision": self.store.get("deployment", i)["revision"]}
                for i in authorized_stops
            ],
            "units": [
                {"id": u["id"], "revision": u["revision"]}
                for u in deployment_sets.units(self.store)
                if set(u["member_ids"]) & set(ids + authorized_stops)
            ],
        }
        return {
            "errors": errors,
            "warnings": warnings,
            "estimates": estimates,
            "resources": resources.preview(
                self,
                [
                    {
                        "name": d["name"],
                        "gpu": d["gpu"],
                        "configuration": d["profile_snapshot"],
                    }
                    for d in selected
                    if d["state"] not in ACTIVE
                ],
            ),
            "stops": authorized_stops,
            "plan_token": identity(plan),
            "impact": "Stops lose KV caches. Failed replacement launches attempt to restore stopped deployments.",
        }

    async def activate(self, ids, override=False, authorized_stops=None, token=None):
        if not ids or len(set(ids)) != len(ids):
            raise Conflict("Select distinct models or deployments to load")
        timeout = max(self.unit(i)["queue_timeout"] for i in ids)
        try:
            async with asyncio.timeout(timeout):
                while True:
                    async with self.lock:
                        expanded = deployment_sets.expand(self.store, ids)
                        stops = (
                            self.automatic_stops(expanded)
                            if authorized_stops is None
                            else deployment_sets.expand(self.store, authorized_stops)
                        )
                        if not any(self.inflight.get(i, 0) for i in stops):
                            return await self._activate_locked(
                                expanded, override, stops, token
                            )
                        self.request_changed.clear()
                    await self.wait_for_requests()
        except TimeoutError as exc:
            raise Conflict(
                "Timed out waiting for deployment capacity or active requests"
            ) from exc

    async def _activate_locked(
        self, ids, override=False, authorized_stops=None, token=None
    ):
        # Every caller owns self.lock, including request admission. No request
        # can slip between selecting victims and reserving its member slot.
        if self.stopping:
            raise Conflict("Daemon is shutting down")
        check = self.validate(ids, authorized_stops)
        if token and token != check["plan_token"]:
            raise Conflict("Launch plan changed; validate again")
        if check["errors"]:
            raise Conflict("; ".join(check["errors"]))
        if any(self.inflight.get(i, 0) for i in authorized_stops or []):
            raise Conflict("Deployment has active requests")
        stopped, started = [], []
        unit = self.unit(ids[0])
        activation = self.store.put(
            "activation",
            {
                "id": uid(),
                "deployment_id": unit["id"],
                "deployment_name": unit["name"],
                "deployment_policy": {k: unit[k] for k in deployment_sets.POLICY_KEYS},
                "started_at": time.time(),
                "deployments": [self.store.get("deployment", i) for i in ids],
                "authorized_stops": authorized_stops or [],
                "plan": check,
                "state": "STARTING",
            },
        )
        from .activity import operation_id

        operation_token = operation_id.set(operation_id.get() or activation["id"])
        try:
            for i in authorized_stops or []:
                d = self.store.get("deployment", i)
                if d["state"] in ACTIVE:
                    stopped.append(i)
                    await self._stop(i, "Authorized deployment switch")
            # Commit lifecycle ownership before any launch side effect; no memory reservation.
            with self.store.transaction() as c:
                for i in ids:
                    d = self.store.get("deployment", i, c)
                    if d["state"] == "READY":
                        continue
                    if d["state"] in ACTIVE:
                        raise Conflict(f"{d['alias']} is already transitioning")
                    self.store.event(
                        "state",
                        {
                            "from": d["state"],
                            "to": "VALIDATING",
                            "operation_id": operation_id.get(),
                            "name": d["name"],
                        },
                        i,
                        c,
                    )
                    d.update(
                        state="QUEUED",
                        session_id=None,
                        failure_reason=None,
                        operation_id=operation_id.get(),
                    )
                    self.store.put("deployment", d, historical=False, c=c)
                    self.store.event(
                        "state",
                        {
                            "from": "VALIDATING",
                            "to": "QUEUED",
                            "operation_id": operation_id.get(),
                            "name": d["name"],
                        },
                        i,
                        c,
                    )
                    started.append(i)
            for i in started:
                await self._start(i, activation["id"])
        except BaseException as exc:
            self.store.put(
                "activation",
                activation
                | {
                    "state": "FAILED",
                    "error": redact(str(exc)),
                    "ended_at": time.time(),
                },
                historical=False,
            )
            for i in reversed(started):
                await self._stop(i, "Launch rollback", force=True)
                self.finish_session(
                    self.store.get("deployment", i), "failed", redact(str(exc))
                )
                self.transition(i, "VALIDATING")
                self.transition(i, "FAILED", redact(str(exc)))
            for i in stopped:
                try:
                    await self._stop(i, "Restoration cleanup", force=True)
                    self.transition(i, "VALIDATING")
                    self.transition(
                        i,
                        "QUEUED",
                        session_id=None,
                    )
                    await self._start(i)
                except Exception as restore_error:
                    await self._stop(i, "Restoration failed", force=True)
                    self.store.event(
                        "recovery_required", {"error": redact(str(restore_error))}, i
                    )
            raise
        finally:
            operation_id.reset(operation_token)
        self.store.put(
            "activation",
            activation | {"state": "SUCCEEDED", "ended_at": time.time()},
            historical=False,
        )
        return {"started": started, "stopped": stopped}

    async def _start(self, ident, activation_id=None):
        d = self.store.get("deployment", ident)
        p = d["profile_snapshot"]
        a, r = (
            self.store.get("artifact", p["artifact_id"]),
            self.store.get("runtime", p["runtime_id"]),
        )
        folder = self.store.root / "deployments" / ident
        folder.mkdir(parents=True, exist_ok=True)
        spec = adapters.launch_spec(d, p, a, r, folder, self.store)
        unit = self.unit(ident)
        pool_owner = unit["members"][0] if unit.get("engine_pool") else None
        if pool_owner:
            from . import runtime_pool

            errors = runtime_pool.validate(unit, self.store)
            if errors:
                raise Conflict("; ".join(errors))
            spec = runtime_pool.launch_spec(
                unit, self.store, spec, self.settings(), ident
            )
        artifact_path = Path(a["local_path"])
        if a.get("sha256") and artifact_path.is_file():
            stat = artifact_path.stat()
            signature = (
                str(artifact_path),
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            )
            digest = self.verified_artifacts.get(signature)
            if digest is None:
                digest = await asyncio.to_thread(adapters.file_hash, artifact_path)
                self.verified_artifacts[signature] = digest
            if digest != a["sha256"]:
                raise Conflict(
                    "Model artifact checksum changed; preserved profile cannot launch different weights"
                )
        # Refuse executable drift after capability discovery.
        if r["execution_kind"] == "native" and r["capabilities"].get("sha256"):
            if (
                await asyncio.to_thread(adapters.file_hash, r["executable"])
                != r["capabilities"]["sha256"]
            ):
                raise Conflict(
                    "Runtime binary changed; register/re-probe it before launch"
                )
        session = self.store.put(
            "session",
            {
                "id": uid(),
                "activation_id": activation_id,
                "deployment_id": ident,
                "deployment_snapshot": d,
                "profile_hash": resources.profile_hash(p, a, r, d["gpu"]),
                "runtime_identity": r,
                "artifact_identity": a,
                "argv": spec["argv"],
                "started_at": time.time(),
                "ended_at": None,
                "outcome": "running",
                "pool_aggregate": bool(pool_owner),
            },
        )
        self.transition(
            ident,
            "STARTING",
            session_id=session["id"],
            log_path=str(folder / "runtime.log"),
            runtime_observation=None,
        )
        if pool_owner and ident != pool_owner["id"]:
            owner = self.store.get("deployment", pool_owner["id"])
            if not self.owned(owner):
                raise Conflict("Runtime pool process is not owned")
            self.transition(
                ident, "LOADING", pid=owner["pid"], pid_started=owner["pid_started"]
            )
            if not await self.ready(self.store.get("deployment", ident)):
                raise Conflict("Runtime pool did not publish its configured model")
            self.transition(ident, "READY", resume_on_boot=False)
            self.last_use[ident] = time.monotonic()
            return
        proc = await processes.spawn(
            *spec["argv"],
            cwd=folder,
            env=spec["env"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self.processes[ident] = proc
        self.transition(
            ident,
            "LOADING",
            pid=proc.pid,
            pid_started=psutil.Process(proc.pid).create_time(),
        )
        log_task = self.spawn(self.capture_log(ident, proc, folder / "runtime.log"))
        deadline = time.monotonic() + d["queue_timeout"]
        while time.monotonic() < deadline:
            if proc.returncode is not None:
                if log_task:
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(asyncio.shield(log_task), 1)
                raise RuntimeError(
                    self.engine_failure(
                        d | {"session_id": session["id"]}, proc.returncode
                    )
                )
            settings = self.settings()
            gpus = [
                g
                for g in self.host.get("gpus", [])
                if d.get("gpu") is None or g["index"] == d["gpu"]
            ]
            from .activity import condition_text, pressure_conditions

            conditions = pressure_conditions(self.host | {"gpus": gpus}, settings)
            if conditions:
                raise RuntimeError(
                    "Launch aborted: " + "; ".join(map(condition_text, conditions))
                )
            if await self.ready(d):
                self.last_use[ident] = time.monotonic()
                extra = {}
                if r["execution_kind"] != "native":
                    info = await self.container_info(d, r)
                    extra = {
                        "container_id": info["Id"],
                        "runtime_pid": info["State"]["Pid"],
                    }
                self.transition(
                    ident, "READY", resume_on_boot=d["residency"] == "pinned", **extra
                )
                return
            await asyncio.sleep(0.5)
        raise RuntimeError("Model readiness timed out")

    async def capture_log(self, ident, proc, path):
        # Bound both disk and line buffers. Do not persist prompts or credential values deliberately.
        pending = b""
        while chunk := await proc.stdout.read(8192):
            pending += chunk
            while b"\n" in pending or len(pending) > 16384:
                if b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                else:
                    line, pending = pending[:16384], pending[16384:]
                self.write_log(path, redact(line.decode(errors="replace")))
        if pending:
            self.write_log(path, redact(pending.decode(errors="replace")))

    def write_log(self, path, line):
        if path.exists() and path.stat().st_size > 4 * 1024 * 1024:
            path.replace(path.with_suffix(".previous.log"))
        with path.open("a", encoding="utf-8") as f:
            f.write(f"{time.time():.3f} {line}\n")

    def engine_failure(self, d, returncode=None):
        path = self.store.root / "deployments" / d["id"] / "runtime.log"
        tail = ""
        with contextlib.suppress(OSError):
            with path.open("rb") as stream:
                stream.seek(max(0, path.stat().st_size - 4096))
                tail = redact(stream.read().decode(errors="replace").strip())
        if d.get("session_id"):
            started_at = self.store.get("session", d["session_id"])["started_at"]
            current = []
            for line in tail.splitlines():
                with contextlib.suppress(ValueError):
                    if float(line.partition(" ")[0]) >= started_at - 0.001:
                        current.append(line)
            tail = "\n".join(current)
        status = (
            processes.exit_reason(returncode)
            if returncode is not None
            else "(exit status unavailable)"
        )
        return f"Runtime exited {status}" + (
            f"\n{tail}" if tail else "; no engine output captured"
        )

    async def ready(self, d):
        try:
            port = self.runtime_port(d)
            response = await self.client.get(
                f"http://127.0.0.1:{port}/health", timeout=2
            )
            if response.status_code != 200:
                return False
            runtime = self.store.get("runtime", d["profile_snapshot"]["runtime_id"])
            protocol = adapters.runtime_protocol.PROTOCOLS[runtime["engine"]]
            observation = None
            if self.unit(d["id"]).get("engine_pool"):
                from . import runtime_pool

                response = await self.client.get(
                    f"http://127.0.0.1:{port}/models", timeout=2
                )
                response.raise_for_status()
                model = next(
                    (
                        m
                        for m in response.json().get("data", [])
                        if m.get("id") == d["alias"]
                    ),
                    None,
                )
                if model is None:
                    return False
                state = model.get("status", {}).get("value")
                observation = {
                    "residency": {
                        "loaded": "resident",
                        "sleeping": "sleeping",
                        "unloaded": "unloaded",
                        "loading": "loading",
                    }.get(state, "unknown"),
                    "memory": runtime_pool.memory_facts(model.get("memory")),
                    "source": "runtime /models",
                    "observed_at": time.time(),
                }
            elif protocol.properties_path:
                props = await self.client.get(
                    f"http://127.0.0.1:{port}{protocol.properties_path}", timeout=2
                )
                if props.status_code == 200:
                    observation = adapters.runtime_observation(props.json())
            if observation is not None:
                saved = self.store.get("deployment", d["id"])
                self.store.put(
                    "runtime_observation",
                    {
                        "id": d["id"],
                        "session_id": saved.get("session_id"),
                        "facts": observation,
                    },
                    historical=False,
                )
                if saved.get("session_id"):
                    session = self.store.get("session", saved["session_id"])
                    self.store.put(
                        "session",
                        session | {"runtime_observation": observation},
                        historical=False,
                    )
                if (
                    self.unit(d["id"]).get("engine_pool")
                    or observation.get("residency") == "sleeping"
                ):
                    return True
            models = await self.client.get(
                f"http://127.0.0.1:{port}/v1/models", timeout=2
            )
            return models.status_code == 200 and any(
                x.get("id") == d["alias"] for x in models.json().get("data", [])
            )
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            return False

    async def container_info(self, d, runtime):
        info = json.loads(
            await adapters.command(
                [runtime["execution_kind"], "inspect", "menagerie-" + d["id"]],
                timeout=5,
            )
        )[0]
        expected = str(self.store.root / "deployments" / d["id"])
        if info.get("Config", {}).get("Labels", {}).get("menagerie.owner") != expected:
            raise Conflict("Container ownership label mismatch; refusing to control it")
        return info

    async def _terminate(self, d):
        unit = self.unit(d["id"])
        process_id = d["id"]
        if unit.get("engine_pool"):
            if any(
                m["id"] != d["id"] and m["state"] in ACTIVE - {"QUEUED", "STARTING"}
                for m in unit["members"]
            ):
                return
            process_id = unit["members"][0]["id"]
        runtime = self.store.get("runtime", d["profile_snapshot"]["runtime_id"])
        if runtime["execution_kind"] != "native":
            try:
                await self.container_info(d, runtime)
                await adapters.command(
                    [
                        runtime["execution_kind"],
                        "stop",
                        "--time",
                        "20",
                        "menagerie-" + d["id"],
                    ],
                    timeout=30,
                )
            except Conflict:
                raise
            except ValueError as exc:
                if "No such" not in str(exc) and "no such" not in str(exc):
                    raise
        await processes.terminate(d)
        proc = self.processes.pop(process_id, None)
        if proc:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), 5)

    async def _stop(self, ident, reason, force=False):
        d = self.store.get("deployment", ident)
        if self.inflight.get(ident, 0) and not force:
            raise Conflict(
                "Deployment has active requests; let them finish before stopping"
            )
        if d["state"] not in ACTIVE:
            return
        self.transition(ident, "STOPPING", reason)
        await self._terminate(d)
        self.finish_session(d, "stopped", reason)
        self.transition(
            ident,
            "STOPPED",
            reason,
            pid=None,
            reservation_active=0,
            resume_on_boot=False,
            runtime_observation=None,
        )

    def finish_session(self, d, outcome, reason=None):
        if d.get("session_id"):
            session = self.store.get("session", d["session_id"])
            session.update(ended_at=time.time(), outcome=outcome, failure_reason=reason)
            self.store.put("session", session, historical=False)

    async def stop(self, ident):
        try:
            async with asyncio.timeout(self.unit(ident)["queue_timeout"]):
                while True:
                    async with self.lock:
                        if not self.unit_busy(self.unit(ident)):
                            return await self._stop_unit_locked(ident, "Manual stop")
                        self.request_changed.clear()
                    await self.wait_for_requests()
        except TimeoutError as exc:
            raise Conflict("Timed out waiting for active requests to finish") from exc

    async def acquire(self, alias):
        if self.waiting >= self.settings()["max_queue"]:
            raise Conflict("Gateway queue is full")
        d = next(
            (
                d
                for d in self.store.list("deployment")
                if d["alias"] == alias and d["enabled"]
            ),
            None,
        )
        if d is None:
            raise KeyError("Unknown or disabled model alias")
        self.waiting += 1
        try:
            async with asyncio.timeout(d["queue_timeout"]):
                while True:
                    async with self.lock:
                        unit = self.unit(d["id"])
                        d = self.store.get("deployment", d["id"])
                        if not unit["enabled"] or not d["enabled"]:
                            raise KeyError("Unknown or disabled model alias")
                        if not all(m["state"] == "READY" for m in unit["members"]):
                            if unit["residency"] != "on-demand":
                                raise Conflict("Deployment is not ready")
                            victims = self.automatic_stops(unit["member_ids"])
                            if any(self.inflight.get(i, 0) for i in victims):
                                self.request_changed.clear()
                            else:
                                await self._activate_locked(
                                    unit["member_ids"], authorized_stops=victims
                                )
                                unit = self.unit(d["id"])
                        if all(m["state"] == "READY" for m in unit["members"]):
                            d = self.store.get("deployment", d["id"])
                            self.inflight[d["id"]] = self.inflight.get(d["id"], 0) + 1
                            self.last_use[d["id"]] = time.monotonic()
                            return d
                    await self.wait_for_requests()
        finally:
            self.waiting -= 1

    def release(self, d):
        self.inflight[d["id"]] = max(0, self.inflight.get(d["id"], 1) - 1)
        self.last_use[d["id"]] = time.monotonic()
        self.request_changed.set()

    async def unload_idle(self):
        # Caller owns the admission lock. One timer and one busy check per unit.
        now = time.monotonic()
        for unit in deployment_sets.units(self.store):
            from .runtime_protocol import native_idle_sleep

            member = unit["members"][0]
            if unit.get("engine_pool"):
                continue
            runtime = self.store.get(
                "runtime", member["profile_snapshot"]["runtime_id"]
            )
            if not unit["multi_model"] and native_idle_sleep(member, runtime):
                continue
            if (
                unit["residency"] == "on-demand"
                and unit["idle_timeout"]
                and now - self.unit_last_use(unit) > unit["idle_timeout"]
                and not self.unit_busy(unit)
                and any(d["state"] in {"READY", "DEGRADED"} for d in unit["members"])
            ):
                await self._stop_unit_locked(unit["id"], "Idle unload")

    def _note_collector_success(self):
        # A clean sample cycle closes out any prior failure run: clear the
        # in-memory error state so "healthy now" is distinguishable from
        # "was broken", and record recovery in the event log.
        if self.collector["consecutive_errors"]:
            try:
                self.store.event(
                    "collector_recovered",
                    {"last_error": self.collector["last_error"]},
                )
            except Exception:
                # The store may still be locked; the in-memory state below is
                # the source of truth for /api/status and the dashboard.
                pass
        self.collector.update(
            consecutive_errors=0,
            last_error=None,
            last_error_at=None,
        )

    def _note_collector_failure(self, message):
        first = self.collector["consecutive_errors"] == 0
        self.collector.update(
            consecutive_errors=self.collector["consecutive_errors"] + 1,
            last_error=message,
            last_error_at=time.time(),
        )
        # Only persist the failure on the first iteration of a failure run, so
        # a persistently locked store does not flood the event log; on the
        # first failure the write itself may also fail, which is logged once.
        if first:
            try:
                self.store.event("collector_error", {"error": message})
            except Exception:
                logger.warning("collector failure could not be persisted: %s", message)

    async def monitor(self):
        last_cleanup = 0
        while True:
            try:
                self.host = await asyncio.to_thread(telemetry.sample)
                live = self.store.list("deployment")
                for d in live:
                    if d["state"] not in ACTIVE:
                        continue
                    unit = self.unit(d["id"])
                    if d.get("pid") and (
                        not unit.get("engine_pool") or d["id"] == unit["member_ids"][0]
                    ):
                        data = await asyncio.to_thread(
                            telemetry.process_sample, d.get("runtime_pid") or d["pid"]
                        )
                        data["provenance"] = (
                            "container host PID"
                            if d.get("runtime_pid")
                            else "native process tree"
                        )
                        if unit.get("engine_pool"):
                            data["provenance"] = (
                                "runtime pool aggregate; not a per-model measurement"
                            )
                        data["gpu_mib"] = telemetry.gpu_process_usage(
                            self.host, data["pids"]
                        )
                        data["gpu_by_device_mib"] = {
                            str(g["index"]): telemetry.gpu_process_usage(
                                self.host, data["pids"], g["index"]
                            )
                            for g in self.host.get("gpus", [])
                        }
                        self.host.setdefault("deployments", {})[d["id"]] = data
                        if d.get("session_id"):
                            session = self.store.get("session", d["session_id"])
                            data["session_id"] = session["id"]
                            data["profile_hash"] = resources.run_profile_hash(session)
                            for field, measurement in (
                                ("peak_gpu_mib", data["gpu_mib"]),
                                ("peak_ram_mib", data["rss_mib"]),
                            ):
                                if measurement is not None:
                                    session[field] = max(
                                        session.get(field) or 0, measurement
                                    )
                            self.store.put("session", session, historical=False)
                    if d["state"] in {"READY", "DEGRADED"} and not self.lock.locked():
                        async with self.lock:
                            d = self.store.get("deployment", d["id"])
                            if d["state"] not in {"READY", "DEGRADED"}:
                                continue
                            if not self.owned(d):
                                processes.release(d.get("pid"))
                                self.transition(
                                    d["id"],
                                    "FAILED",
                                    self.engine_failure(
                                        d,
                                        getattr(
                                            self.processes.get(d["id"]),
                                            "returncode",
                                            None,
                                        ),
                                    ),
                                    reservation_active=0,
                                    pid=None,
                                )
                                self.finish_session(d, "failed", self.engine_failure(d))
                                continue
                            ready = await self.ready(d)
                            if ready != (d["state"] == "READY"):
                                self.transition(
                                    d["id"],
                                    "READY" if ready else "DEGRADED",
                                    None if ready else "Readiness check failed",
                                )
                    if d["state"] == "READY" and not unit.get("engine_pool"):
                        try:
                            response = await self.client.get(
                                f"http://127.0.0.1:{d['port']}/metrics", timeout=2
                            )
                            if response.status_code == 200:
                                values = {}
                                for line in response.text.splitlines():
                                    if line and not line.startswith("#"):
                                        parts = line.split()
                                        if len(parts) >= 2:
                                            with contextlib.suppress(ValueError):
                                                value = float(parts[1])
                                                if math.isfinite(value):
                                                    values[parts[0]] = value
                                self.host.setdefault("runtime_metrics", {})[d["id"]] = (
                                    values
                                )
                        except httpx.HTTPError:
                            pass
                if not self.lock.locked():
                    async with self.lock:
                        await self.unload_idle()
                # Admission is not physical isolation: alert on pressure, never silently evict pinned models.
                settings = self.settings()
                from .activity import pressure_conditions

                conditions = pressure_conditions(self.host, settings)
                pressure = bool(conditions)
                self.host["pressure"] = pressure
                if pressure != self.was_pressure:
                    self.store.event(
                        "pressure",
                        {
                            "active": pressure,
                            "conditions": conditions,
                            "previous_conditions": getattr(self, "last_conditions", []),
                            "note": "Pinned deployments are never automatically evicted",
                        },
                    )
                    self.was_pressure = pressure
                self.last_conditions = conditions
                if pressure and not self.lock.locked():
                    async with self.lock:
                        candidates = [
                            u
                            for u in deployment_sets.units(self.store)
                            if any(
                                d["state"] in {"READY", "DEGRADED"}
                                for d in u["members"]
                            )
                            and u["residency"] == "evictable"
                            and u["allow_eviction"]
                            and not self.unit_busy(u)
                        ]
                        if candidates:
                            victim = min(
                                candidates,
                                key=lambda u: (u["priority"], self.unit_last_use(u)),
                            )
                            await self._stop_unit_locked(
                                victim["id"], "Authorized pressure eviction"
                            )
                with self.store.connect() as c:
                    c.execute(
                        "INSERT INTO samples VALUES(?,?)",
                        (self.host["ts"], encode(self.host)),
                    )
                    if time.time() - last_cleanup > 60:
                        resource_history.prune(self.store, settings, c)
                        cutoff = time.time() - settings["retention_days"] * 86400
                        # Preserve memory and thermal extremes, rather than an arbitrary first sample.
                        c.execute(
                            """DELETE FROM samples WHERE ts<? AND ts NOT IN (
                          SELECT ts FROM (SELECT ts,
                            row_number() OVER(PARTITION BY CAST(ts/60 AS INTEGER) ORDER BY json_extract(data,'$.gpus[0].free_mib') ASC) AS memory_rank,
                            row_number() OVER(PARTITION BY CAST(ts/60 AS INTEGER) ORDER BY json_extract(data,'$.gpus[0].temperature') DESC) AS heat_rank
                            FROM samples WHERE ts<?) WHERE memory_rank=1 OR heat_rank=1)""",
                            (cutoff, cutoff),
                        )
                        c.execute(
                            "DELETE FROM samples WHERE ts<?",
                            (time.time() - settings["summary_days"] * 86400,),
                        )
                        c.execute(
                            "DELETE FROM requests WHERE ts<?",
                            (time.time() - settings["summary_days"] * 86400,),
                        )
                        quota = settings["history_quota_mib"] * 1048576
                        for table in ("samples", "requests"):
                            size = c.execute(
                                f"SELECT coalesce(sum(length(data)),0) FROM {table}"
                            ).fetchone()[0]
                            if size > quota:
                                c.execute(
                                    f"DELETE FROM {table} WHERE ts IN (SELECT ts FROM (SELECT ts,sum(length(data)) OVER(ORDER BY ts DESC) AS bytes FROM {table}) WHERE bytes>?)",
                                    (quota,),
                                )
                        last_cleanup = time.time()
                self._note_collector_success()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # A locked store must not end supervision: the failed write is
                # reported in memory even when its event cannot be persisted.
                self._note_collector_failure(redact(str(exc)))
            try:
                interval = self.settings()["sample_seconds"]
            except Exception:
                interval = 2
            await asyncio.sleep(interval)
