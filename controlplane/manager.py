import asyncio
import contextlib
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import time
import httpx
import psutil
from . import adapters, telemetry, deployment_sets
from .schema import Settings
from .store import encode, identity, uid

ACTIVE = {"QUEUED", "STARTING", "LOADING", "READY", "DEGRADED", "STOPPING"}
TRANSITIONS = {
    "DRAFT": {"VALIDATING", "STOPPED"}, "STOPPED": {"VALIDATING"}, "FAILED": {"VALIDATING", "STOPPED"},
    "ERROR": {"VALIDATING", "STOPPED"}, "VALIDATING": {"QUEUED", "FAILED", "STOPPED"},
    "QUEUED": {"STARTING", "FAILED", "STOPPING"}, "STARTING": {"LOADING", "FAILED", "STOPPING"},
    "LOADING": {"READY", "FAILED", "STOPPING"}, "READY": {"DEGRADED", "STOPPING", "FAILED"},
    "DEGRADED": {"READY", "STOPPING", "FAILED"}, "STOPPING": {"STOPPED", "FAILED"},
}


class Conflict(ValueError):
    pass


def redact(text):
    text = re.sub(r"(?i)(bearer\s+|(?:api[_-]?key|token|authorization)[=:]\s*)[^\s,;]+", r"\1[REDACTED]", text)
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
        self.client = httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(1800, connect=5), limits=httpx.Limits(max_connections=128))
        self.stopping = False
        self.file_lock = None
        self.loop_task = None
        self.was_pressure = False
        self.verified_artifacts = {}
        self.request_changed = asyncio.Event()

    def unit(self, ident):
        unit = deployment_sets.unit_for(self.store, ident)
        if unit is None:
            raise KeyError(f"Unknown deployment: {ident}")
        return unit

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
            needed = sum(self.estimate(d)["reservation_mib"] for d in (self.store.get("deployment", i) for i in selected) if d["gpu"] == gpu["index"] and d["state"] not in ACTIVE)
            deficits[gpu["index"]] = max(0, needed - max(0, gpu["free_mib"] - self.settings()["gpu_headroom_mib"]))
        candidates = [u for u in deployment_sets.units(self.store) if not set(u["member_ids"]) & set(selected) and u["residency"] != "pinned" and u["allow_eviction"] and u["priority"] <= priority and any(d["state"] in ACTIVE for d in u["members"])]
        candidates.sort(key=lambda u: (self.unit_busy(u), u["priority"], self.unit_last_use(u)))
        stops = []
        for unit in candidates:
            freed = {}
            for d in unit["members"]:
                if d["state"] in ACTIVE:
                    measured = self.host.get("deployments", {}).get(d["id"], {}).get("gpu_mib")
                    freed[d["gpu"]] = freed.get(d["gpu"], 0) + (measured if measured is not None else d.get("reservation_active") or self.estimate(d)["reservation_mib"])
            if any(deficits.get(gpu, 0) > 0 and amount > 0 for gpu, amount in freed.items()):
                stops.extend(unit["member_ids"])
                for gpu, amount in freed.items():
                    deficits[gpu] = max(0, deficits.get(gpu, 0) - amount)
        return stops

    def plan(self, ids):
        return self.validate(ids, self.automatic_stops(ids))

    def unit_last_use(self, unit):
        return max(self.last_use.setdefault(i, time.monotonic()) for i in unit["member_ids"])

    async def _stop_unit_locked(self, ident, reason):
        unit = self.unit(ident)
        if self.unit_busy(unit):
            raise Conflict("Deployment has active requests; let them finish before unloading")
        for i in reversed(unit["member_ids"]):
            await self._stop(i, reason)

    def settings(self):
        try:
            return Settings.model_validate({k: v for k, v in self.store.get("settings", "host").items() if k not in {"id", "revision"}}).model_dump()
        except KeyError:
            return Settings().model_dump()

    def spawn(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def transition(self, ident, state, reason=None, **extra):
        with self.store.transaction() as c:
            d = self.store.get("deployment", ident, c)
            if state != d["state"] and state not in TRANSITIONS.get(d["state"], set()):
                raise Conflict(f"Invalid transition {d['state']} → {state}")
            old = d["state"]
            d.update(extra, state=state, state_since=time.time(), failure_reason=reason)
            self.store.put("deployment", d, historical=False, c=c)
            self.store.event("state", {"from": old, "to": state, "reason": reason}, ident, c)
        return d

    def owned(self, d):
        try:
            p = psutil.Process(d["pid"])
            return p.is_running() and p.status() != psutil.STATUS_ZOMBIE and abs(p.create_time() - d["pid_started"]) < .01 and os.getpgid(p.pid) == p.pid
        except (KeyError, TypeError, psutil.Error, ProcessLookupError):
            return False

    async def start(self):
        self.file_lock = open(self.store.root / "daemon.lock", "a")
        try:
            fcntl.flock(self.file_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError("Another daemon owns this registry")
        self.host = await asyncio.to_thread(telemetry.sample)
        for d in self.store.list("deployment"):
            if d["state"] in ACTIVE | {"VALIDATING"}:
                if self.owned(d) and d["state"] in {"READY", "DEGRADED"}:
                    ready = await self.ready(d)
                    self.transition(d["id"], "READY" if ready else "DEGRADED", None if ready else "Reconciled process is not ready")
                else:
                    runtime = self.store.get("runtime", d["profile_snapshot"]["runtime_id"])
                    if self.owned(d) or runtime["execution_kind"] != "native":
                        await self._terminate(d)
                    self.transition(d["id"], "FAILED", "Daemon interrupted; incomplete launch not replayed", reservation_active=0, pid=None)
                    self.finish_session(d, "interrupted")
        self.store.event("daemon", {"state": "ready"})
        self.loop_task = asyncio.create_task(self.monitor())
        resume = [i for unit in deployment_sets.units(self.store) if unit["residency"] == "pinned" and any(d.get("resume_on_boot") for d in unit["members"]) and any(d["state"] not in ACTIVE for d in unit["members"]) for i in unit["member_ids"]]
        if resume:
            async def restore_pinned():
                try:
                    await self.activate(resume)
                except Exception as exc:
                    self.store.event("recovery_required", {"error": redact(str(exc)), "deployments": resume})
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
                    resume = d["residency"] == "pinned" and d["state"] in {"READY", "DEGRADED"}
                    await self._stop(d["id"], "Daemon shutdown", force=True)
                    if resume:
                        saved = self.store.get("deployment", d["id"])
                        self.store.put("deployment", saved | {"resume_on_boot": True}, historical=False)
        await self.client.aclose()
        if self.file_lock:
            self.file_lock.close()

    def estimate(self, d):
        from .resources import estimate
        p = d["profile_snapshot"]
        a = self.store.get("artifact", p["artifact_id"])
        measured = [s for s in self.store.list("session") if s.get("profile_hash") == identity(p) and s.get("peak_gpu_mib", 0) > 0 and s.get("outcome") == "stopped"]
        result = estimate(a, p["config"], d.get("reservation_mib", 0), [s["peak_gpu_mib"] for s in measured])
        runtime = self.store.get("runtime", p["runtime_id"])
        gpu = next((g for g in self.host.get("gpus", []) if g["index"] == d.get("gpu", 0)), {})
        if runtime["engine"] == "vllm" and gpu.get("total_mib"):
            allocated = round(gpu["total_mib"] * float(p["config"].get("gpu-memory-utilization", .5)))
            required = result["peak_mib"]
            result.update(peak_mib=max(required, allocated), required_mib=required, allocation_mib=allocated,
                          components=None, reservation_mib=d.get("reservation_mib") or max(required, allocated))
        return result

    def validate(self, ids, authorized_stops=None):
        duplicates = len(set(ids)) != len(ids)
        ids = deployment_sets.expand(self.store, ids)
        authorized_stops = deployment_sets.expand(self.store, authorized_stops or [])
        errors, warnings, estimates = [], [], {}
        all_d = self.store.list("deployment")
        selected = [self.store.get("deployment", i) for i in ids]
        if duplicates:
            errors.append("Duplicate models in deployment")
        if set(ids) & set(authorized_stops):
            errors.append("A deployment cannot be started and stopped in the same plan")
        for i in authorized_stops:
            self.store.get("deployment", i)
            if self.inflight.get(i, 0):
                warnings.append(f"{self.store.get('deployment', i)['name']}: waiting for active requests to finish")
        aliases = [d["alias"] for d in all_d]
        ports = [d["port"] for d in all_d]
        for d in selected:
            if not d["enabled"]:
                errors.append(f"{d['alias']} is disabled")
            if aliases.count(d["alias"]) > 1 or ports.count(d["port"]) > 1:
                errors.append(f"Duplicate alias or port: {d['alias']}")
            p = d["profile_snapshot"]
            a, r = self.store.get("artifact", p["artifact_id"]), self.store.get("runtime", p["runtime_id"])
            errors += [f"{d['alias']}: {e}" for e in adapters.validate_profile(p, a, r)]
            if not Path(a["local_path"]).exists():
                errors.append(f"Missing artifact: {a['name']}")
            elif shards := (a.get("metadata", {}).get("shards") or []):
                if len(shards) < 2 or any(not Path(s["path"]).is_file() or Path(s["path"]).stat().st_size != s["size"] for s in shards):
                    errors.append(f"Artifact shard set changed: {a['name']}; re-import before launch")
            elif Path(a["local_path"]).is_file() and Path(a["local_path"]).stat().st_size != a["size_bytes"]:
                errors.append(f"Artifact size changed: {a['name']}; re-import before launch")
            for key in ("mmproj", "spec-draft-model", "model-draft", "chat-template-file"):
                if p["config"].get(key) and not Path(p["config"][key]).expanduser().is_file():
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
            errors.append("Insufficient registry/log disk capacity (128 MiB reserve required)")
        for gpu in self.host.get("gpus", []):
            resident = [d for d in all_d if d["gpu"] == gpu["index"] and d["state"] in ACTIVE and d["id"] not in authorized_stops]
            new = [d for d in selected if d["gpu"] == gpu["index"] and d["state"] not in ACTIVE]
            explicit = sum(d["reservation_mib"] for d in resident + new)
            if explicit + settings["gpu_headroom_mib"] > gpu["total_mib"]:
                errors.append("Explicit reservations exceed GPU capacity including desktop headroom")
            needed = sum(estimates[d["id"]]["reservation_mib"] for d in new)
            if needed > gpu["free_mib"] - settings["gpu_headroom_mib"] and not authorized_stops:
                warnings.append(f"Estimated peak exceeds currently free GPU {gpu['index']} capacity")
            if gpu["free_mib"] < settings["gpu_headroom_mib"] and not authorized_stops:
                errors.append("GPU below desktop headroom gate")
        if any(str(d["profile_snapshot"]["config"].get("gpu-layers", "all")) != "0" and d["gpu"] not in [g["index"] for g in self.host.get("gpus", [])] for d in selected):
            errors.append("Selected NVIDIA GPU has no telemetry")
        ram_needed = sum(estimates[d["id"]].get("ram_mib", 0) for d in selected if d["state"] not in ACTIVE)
        if ram_needed > self.host.get("ram_available_mib", 0) - settings["ram_headroom_mib"]:
            errors.append("CPU/RAM offload exceeds currently available system memory")
        if self.host.get("ram_available_mib", 0) < settings["ram_headroom_mib"]:
            errors.append("Host below RAM headroom gate")
        plan = {"deployments": [{"id": d["id"], "profile": identity(d["profile_snapshot"]), "revision": d["revision"]} for d in selected], "authorized_stops": [{"id": i, "revision": self.store.get("deployment", i)["revision"]} for i in authorized_stops], "units": [{"id": u["id"], "revision": u["revision"]} for u in deployment_sets.units(self.store) if set(u["member_ids"]) & set(ids + authorized_stops)]}
        return {"errors": errors, "warnings": warnings, "estimates": estimates, "stops": authorized_stops, "plan_token": identity(plan), "impact": "Stops lose KV caches. Failed replacement launches attempt to restore stopped deployments."}

    async def activate(self, ids, authorized_stops=None, token=None):
        if not ids or len(set(ids)) != len(ids):
            raise Conflict("Select distinct models or deployments to load")
        timeout = max(self.unit(i)["queue_timeout"] for i in ids)
        try:
            async with asyncio.timeout(timeout):
                while True:
                    async with self.lock:
                        expanded = deployment_sets.expand(self.store, ids)
                        stops = self.automatic_stops(expanded) if authorized_stops is None else deployment_sets.expand(self.store, authorized_stops)
                        if not any(self.inflight.get(i, 0) for i in stops):
                            return await self._activate_locked(expanded, stops, token)
                        self.request_changed.clear()
                    await self.wait_for_requests()
        except TimeoutError as exc:
            raise Conflict("Timed out waiting for deployment capacity or active requests") from exc

    async def _activate_locked(self, ids, authorized_stops=None, token=None):
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
        activation = self.store.put("activation", {"id": uid(), "deployment_id": unit["id"], "deployment_name": unit["name"], "deployment_policy": {k: unit[k] for k in deployment_sets.POLICY_KEYS}, "started_at": time.time(), "deployments": [self.store.get("deployment", i) for i in ids], "authorized_stops": authorized_stops or [], "plan": check, "state": "STARTING"})
        try:
            for i in authorized_stops or []:
                d = self.store.get("deployment", i)
                if d["state"] in ACTIVE:
                    stopped.append(i)
                    await self._stop(i, "Authorized deployment switch")
            # All reservations are committed before any launch side effect.
            with self.store.transaction() as c:
                for i in ids:
                    d = self.store.get("deployment", i, c)
                    if d["state"] == "READY":
                        continue
                    if d["state"] in ACTIVE:
                        raise Conflict(f"{d['alias']} is already transitioning")
                    self.store.event("state", {"from": d["state"], "to": "VALIDATING"}, i, c)
                    d.update(state="QUEUED", reservation_active=check["estimates"][i]["reservation_mib"], failure_reason=None)
                    self.store.put("deployment", d, historical=False, c=c)
                    self.store.event("state", {"from": "VALIDATING", "to": "QUEUED", "reservation_mib": d["reservation_active"]}, i, c)
                    started.append(i)
            for i in started:
                await self._start(i, activation["id"])
        except BaseException as exc:
            self.store.put("activation", activation | {"state": "FAILED", "error": redact(str(exc)), "ended_at": time.time()}, historical=False)
            for i in reversed(started):
                await self._stop(i, "Launch rollback", force=True)
                self.transition(i, "VALIDATING")
                self.transition(i, "FAILED", redact(str(exc)))
            for i in stopped:
                try:
                    await self._stop(i, "Restoration cleanup", force=True)
                    self.transition(i, "VALIDATING")
                    self.transition(i, "QUEUED", reservation_active=self.estimate(self.store.get("deployment", i))["reservation_mib"])
                    await self._start(i)
                except Exception as restore_error:
                    await self._stop(i, "Restoration failed", force=True)
                    self.store.event("recovery_required", {"error": redact(str(restore_error))}, i)
            raise
        self.store.put("activation", activation | {"state": "SUCCEEDED", "ended_at": time.time()}, historical=False)
        return {"started": started, "stopped": stopped}

    async def _start(self, ident, activation_id=None):
        d = self.store.get("deployment", ident)
        p = d["profile_snapshot"]
        a, r = self.store.get("artifact", p["artifact_id"]), self.store.get("runtime", p["runtime_id"])
        folder = self.store.root / "deployments" / ident
        folder.mkdir(parents=True, exist_ok=True)
        spec = adapters.launch_spec(d, p, a, r, folder)
        artifact_path = Path(a["local_path"])
        if a.get("sha256") and artifact_path.is_file():
            stat = artifact_path.stat()
            signature = (str(artifact_path), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            digest = self.verified_artifacts.get(signature)
            if digest is None:
                digest = await asyncio.to_thread(adapters.file_hash, artifact_path)
                self.verified_artifacts[signature] = digest
            if digest != a["sha256"]:
                raise Conflict("Model artifact checksum changed; preserved profile cannot launch different weights")
        # Refuse executable drift after capability discovery.
        if r["execution_kind"] == "native" and r["capabilities"].get("sha256"):
            if await asyncio.to_thread(adapters.file_hash, r["executable"]) != r["capabilities"]["sha256"]:
                raise Conflict("Runtime binary changed; register/re-probe it before launch")
        session = self.store.put("session", {"id": uid(), "activation_id": activation_id, "deployment_id": ident, "deployment_snapshot": d, "profile_hash": identity(p), "runtime_identity": r, "artifact_identity": a, "argv": spec["argv"], "started_at": time.time(), "ended_at": None, "outcome": "running", "peak_gpu_mib": 0, "peak_ram_mib": 0})
        self.transition(ident, "STARTING", session_id=session["id"], log_path=str(folder / "runtime.log"))
        proc = await asyncio.create_subprocess_exec(*spec["argv"], cwd=folder, env=spec["env"], start_new_session=True, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        self.processes[ident] = proc
        self.transition(ident, "LOADING", pid=proc.pid, pid_started=psutil.Process(proc.pid).create_time())
        self.spawn(self.capture_log(ident, proc, folder / "runtime.log"))
        deadline = time.monotonic() + d["queue_timeout"]
        while time.monotonic() < deadline:
            if proc.returncode is not None:
                raise RuntimeError(f"Runtime exited {proc.returncode}; inspect deployment logs")
            settings = self.settings()
            gpu = next((g for g in self.host.get("gpus", []) if g["index"] == d["gpu"]), None)
            if gpu and (gpu["free_mib"] < settings["gpu_headroom_mib"] or (gpu.get("temperature") or 0) > settings["temperature_limit"]):
                raise RuntimeError("Launch aborted: measured GPU headroom/temperature crossed the desktop safety gate")
            if self.host.get("ram_available_mib", float("inf")) < settings["ram_headroom_mib"]:
                raise RuntimeError("Launch aborted: measured RAM below desktop safety gate")
            if await self.ready(d):
                self.last_use[ident] = time.monotonic()
                extra = {}
                if r["execution_kind"] != "native":
                    info = await self.container_info(d, r)
                    extra = {"container_id": info["Id"], "runtime_pid": info["State"]["Pid"]}
                self.transition(ident, "READY", resume_on_boot=d["residency"] == "pinned", **extra)
                return
            await asyncio.sleep(.5)
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
        with path.open("a") as f:
            f.write(f"{time.time():.3f} {line}\n")

    async def ready(self, d):
        try:
            response = await self.client.get(f"http://127.0.0.1:{d['port']}/health", timeout=2)
            if response.status_code != 200:
                return False
            models = await self.client.get(f"http://127.0.0.1:{d['port']}/v1/models", timeout=2)
            return models.status_code == 200 and any(x.get("id") == d["alias"] for x in models.json().get("data", []))
        except (httpx.HTTPError, ValueError):
            return False

    async def container_info(self, d, runtime):
        info = json.loads(await adapters.command([runtime["execution_kind"], "inspect", "menagerie-" + d["id"]], timeout=5))[0]
        expected = str(self.store.root / "deployments" / d["id"])
        if info.get("Config", {}).get("Labels", {}).get("menagerie.owner") != expected:
            raise Conflict("Container ownership label mismatch; refusing to control it")
        return info

    async def _terminate(self, d):
        runtime = self.store.get("runtime", d["profile_snapshot"]["runtime_id"])
        if runtime["execution_kind"] != "native":
            try:
                info = await self.container_info(d, runtime)
                await adapters.command([runtime["execution_kind"], "stop", "--time", "20", "menagerie-" + d["id"]], timeout=30)
            except Conflict:
                raise
            except ValueError as exc:
                if "No such" not in str(exc) and "no such" not in str(exc):
                    raise
        if self.owned(d):
            os.killpg(d["pid"], signal.SIGTERM)
            deadline = time.monotonic() + 20
            while self.owned(d) and time.monotonic() < deadline:
                await asyncio.sleep(.1)
            if self.owned(d):
                os.killpg(d["pid"], signal.SIGKILL)
        proc = self.processes.pop(d["id"], None)
        if proc:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), 5)

    async def _stop(self, ident, reason, force=False):
        d = self.store.get("deployment", ident)
        if self.inflight.get(ident, 0) and not force:
            raise Conflict("Deployment has active requests; let them finish before stopping")
        if d["state"] not in ACTIVE:
            return
        self.transition(ident, "STOPPING", reason)
        await self._terminate(d)
        self.finish_session(d, "stopped", reason)
        self.transition(ident, "STOPPED", reason, pid=None, reservation_active=0, resume_on_boot=False)

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
        d = next((d for d in self.store.list("deployment") if d["alias"] == alias and d["enabled"]), None)
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
                                await self._activate_locked(unit["member_ids"], authorized_stops=victims)
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
            if unit["residency"] == "on-demand" and unit["idle_timeout"] and now - self.unit_last_use(unit) > unit["idle_timeout"] and not self.unit_busy(unit) and any(d["state"] in {"READY", "DEGRADED"} for d in unit["members"]):
                await self._stop_unit_locked(unit["id"], "Idle unload")

    async def monitor(self):
        last_cleanup = 0
        while True:
            try:
                self.host = await asyncio.to_thread(telemetry.sample)
                live = self.store.list("deployment")
                for d in live:
                    if d["state"] not in ACTIVE:
                        continue
                    if d.get("pid"):
                        data = await asyncio.to_thread(telemetry.process_sample, d.get("runtime_pid") or d["pid"])
                        data["provenance"] = "container host PID" if d.get("runtime_pid") else "native process tree"
                        data["gpu_mib"] = sum(p["gpu_mib"] or 0 for p in self.host["processes"] if p["pid"] in data["pids"])
                        self.host.setdefault("deployments", {})[d["id"]] = data
                        if d.get("session_id"):
                            session = self.store.get("session", d["session_id"])
                            session.update(peak_gpu_mib=max(session.get("peak_gpu_mib", 0), data["gpu_mib"]), peak_ram_mib=max(session.get("peak_ram_mib", 0), data["rss_mib"] or 0))
                            self.store.put("session", session, historical=False)
                    if d["state"] in {"READY", "DEGRADED"} and not self.lock.locked():
                        async with self.lock:
                            d = self.store.get("deployment", d["id"])
                            if d["state"] not in {"READY", "DEGRADED"}:
                                continue
                            if not self.owned(d):
                                self.transition(d["id"], "FAILED", "Runtime process exited", reservation_active=0, pid=None)
                                self.finish_session(d, "failed", "Runtime exited")
                                continue
                            ready = await self.ready(d)
                            if ready != (d["state"] == "READY"):
                                self.transition(d["id"], "READY" if ready else "DEGRADED", None if ready else "Readiness check failed")
                    if d["state"] == "READY":
                        try:
                            response = await self.client.get(f"http://127.0.0.1:{d['port']}/metrics", timeout=2)
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
                                self.host.setdefault("runtime_metrics", {})[d["id"]] = values
                        except httpx.HTTPError:
                            pass
                if not self.lock.locked():
                    async with self.lock:
                        await self.unload_idle()
                # Admission is not physical isolation: alert on pressure, never silently evict pinned models.
                settings = self.settings()
                pressure = any(g["free_mib"] < settings["gpu_headroom_mib"] or (g["temperature"] or 0) > settings["temperature_limit"] for g in self.host["gpus"]) or self.host["ram_available_mib"] < settings["ram_headroom_mib"]
                self.host["pressure"] = pressure
                if pressure != self.was_pressure:
                    self.store.event("pressure", {"active": pressure, "note": "Pinned deployments are never automatically evicted"})
                    self.was_pressure = pressure
                if pressure and not self.lock.locked():
                    async with self.lock:
                        candidates = [u for u in deployment_sets.units(self.store) if any(d["state"] in {"READY", "DEGRADED"} for d in u["members"]) and u["residency"] == "evictable" and u["allow_eviction"] and not self.unit_busy(u)]
                        if candidates:
                            victim = min(candidates, key=lambda u: (u["priority"], self.unit_last_use(u)))
                            await self._stop_unit_locked(victim["id"], "Authorized pressure eviction")
                with self.store.connect() as c:
                    c.execute("INSERT INTO samples VALUES(?,?)", (self.host["ts"], encode(self.host)))
                    if time.time() - last_cleanup > 60:
                        cutoff = time.time() - settings["retention_days"] * 86400
                        # Preserve memory and thermal extremes, rather than an arbitrary first sample.
                        c.execute("""DELETE FROM samples WHERE ts<? AND ts NOT IN (
                          SELECT ts FROM (SELECT ts,
                            row_number() OVER(PARTITION BY CAST(ts/60 AS INTEGER) ORDER BY json_extract(data,'$.gpus[0].free_mib') ASC) AS memory_rank,
                            row_number() OVER(PARTITION BY CAST(ts/60 AS INTEGER) ORDER BY json_extract(data,'$.gpus[0].temperature') DESC) AS heat_rank
                            FROM samples WHERE ts<?) WHERE memory_rank=1 OR heat_rank=1)""", (cutoff, cutoff))
                        c.execute("DELETE FROM samples WHERE ts<?", (time.time() - settings["summary_days"] * 86400,))
                        c.execute("DELETE FROM requests WHERE ts<?", (time.time() - settings["summary_days"] * 86400,))
                        quota = settings["history_quota_mib"] * 1048576
                        for table in ("samples", "requests"):
                            size = c.execute(f"SELECT coalesce(sum(length(data)),0) FROM {table}").fetchone()[0]
                            if size > quota:
                                c.execute(f"DELETE FROM {table} WHERE ts IN (SELECT ts FROM (SELECT ts,sum(length(data)) OVER(ORDER BY ts DESC) AS bytes FROM {table}) WHERE bytes>?)", (quota,))
                        last_cleanup = time.time()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.store.event("collector_error", {"error": redact(str(exc))})
            await asyncio.sleep(self.settings()["sample_seconds"])
