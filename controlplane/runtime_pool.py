"""Native model pools: the runtime owns children and pool-local residency.

Menagerie owns the router process, explicit membership and cross-pool policy.
"""

import configparser
import io
import json

from . import templates


def validate(unit, store):
    if not unit.get("engine_pool"):
        return []
    errors = []
    members = unit["members"]
    runtimes = {m["profile_snapshot"]["runtime_id"] for m in members}
    if len(runtimes) != 1 or len({m.get("gpu") for m in members}) != 1:
        errors.append(
            "A runtime pool requires one runtime installation and shared device visibility"
        )
    if unit["residency"] != "on-demand":
        errors.append(
            "Runtime pools require on-demand policy; use supervised deployments for pinned or atomic residency"
        )
    for member in members:
        profile = member["profile_snapshot"]
        runtime = store.get("runtime", profile["runtime_id"])
        if runtime["execution_kind"] != "native" or not runtime.get(
            "capabilities", {}
        ).get("mechanisms", {}).get("router"):
            errors.append(
                "Runtime pool requires a native installation advertising model routing"
            )
        if profile.get("raw_args"):
            errors.append(
                "Runtime pools require named configuration options rather than raw arguments"
            )
        shared = {
            "models-preset",
            "models-dir",
            "models-max",
            "models-autoload",
            "models-memory-margin",
            "host",
            "port",
        }
        if shared.intersection(profile.get("config", {})):
            errors.append(
                "Shared router settings belong to the pool, not individual model presets"
            )
    return sorted(set(errors))


def preset(unit, store):
    errors = validate(unit, store)
    if errors:
        raise ValueError("; ".join(errors))
    config = configparser.ConfigParser(interpolation=None, default_section="$defaults")
    config.optionxform = str
    config["*"] = {"load-on-startup": "false"}
    for member in unit["members"]:
        profile = member["profile_snapshot"]
        artifact = store.get("artifact", profile["artifact_id"])
        values = {"model": artifact["local_path"]} | profile["config"]
        selection = templates.effective_selection(member, artifact, store)
        if selection.get("source") not in (None, "automatic") and selection.get(
            "asset"
        ):
            values["chat-template-file"] = selection["asset"]["file_path"]
        runtime = store.get("runtime", profile["runtime_id"])
        if unit["idle_timeout"] and runtime.get("capabilities", {}).get(
            "mechanisms", {}
        ).get("native_idle_sleep"):
            values["sleep-idle-seconds"] = unit["idle_timeout"]
        encoded = {}
        for key, value in values.items():
            text = (
                json.dumps(value, separators=(",", ":"))
                if isinstance(value, (bool, dict, list))
                else str(value)
            )
            if any(c in text for c in ("\n", "\r", "\x00")):
                raise ValueError("Runtime preset values must be single-line")
            encoded[key] = text
        config[member["alias"]] = encoded
    output = io.StringIO()
    output.write("version = 1\n\n")
    config.write(output)
    return output.getvalue()


def launch_spec(unit, store, spec, settings, member_id):
    """Render router startup at the adapter boundary, not in the lifecycle owner."""
    owner = unit["members"][0]
    runtime = store.get("runtime", owner["profile_snapshot"]["runtime_id"])
    folder = store.root / "deployments" / owner["id"]
    folder.mkdir(parents=True, exist_ok=True)
    cache = folder / "engine-cache"
    cache.mkdir(exist_ok=True)
    # Presets supplement the default cache; a private cache preserves membership.
    spec["env"]["LLAMA_CACHE"] = str(cache)
    path = folder / "models.ini"
    if member_id == owner["id"]:
        path.write_text(preset(unit, store), encoding="utf-8")
        path.chmod(0o600)
    spec["argv"] = [
        runtime["executable"],
        "--models-preset",
        str(path),
        "--host",
        "127.0.0.1",
        "--port",
        str(owner["port"]),
        "--no-ui",
        "--metrics",
        "--models-max",
        str(unit.get("max_loaded", 4) if unit["allow_eviction"] else 0),
        "--models-autoload",
    ]
    if "models-memory-margin" in runtime.get("capabilities", {}).get("flags", []):
        spec["argv"] += [
            "--models-memory-margin",
            str(settings["gpu_headroom_mib"] if unit["allow_eviction"] else 0),
        ]
    return spec


def memory_facts(value):
    """Whitelist native allocation facts, not arbitrary runtime response content."""
    if not isinstance(value, dict):
        return None
    result = {
        "status": value.get("status")
        if value.get("status") in {"unmeasured", "measuring", "measured", "failed"}
        else "unmeasured"
    }
    for stage in ("min", "max", "effective"):
        entry = value.get(stage)
        if not isinstance(entry, dict):
            continue
        devices = []
        for device in entry.get("devices", [])[:64]:
            if not isinstance(device, dict):
                continue
            fact = {
                k: v
                for k, v in device.items()
                if k in {"total", "free", "model", "context", "compute"}
                and type(v) is int
                and v >= 0
            }
            fact["kind"] = "host" if device.get("kind") == "host" else "device"
            if isinstance(device.get("name"), str):
                fact["name"] = device["name"][:128]
            devices.append(fact)
        result[stage] = {"devices": devices}
        if type(entry.get("n_ctx")) is int and entry["n_ctx"] >= 0:
            result[stage]["n_ctx"] = entry["n_ctx"]
    return result
