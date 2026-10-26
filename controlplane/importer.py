"""Read-only shelf import; never executes shelf Python or edits its source."""
import asyncio
import json
from pathlib import Path
import tomllib
from . import adapters
from .store import identity
from .catalog import normalize


async def preview(root):
    root = Path(root).expanduser().resolve()
    engines = tomllib.loads((root / "engines.toml").read_text())["engines"]
    runtimes, artifacts, profiles, deployments = {}, {}, [], []
    for key, engine in engines.items():
        env = {}
        if engine.get("cuda"):
            libs = sorted((root.parent / "cuda12-runtime/lib").glob("python*/site-packages/nvidia/*/lib"))
            if libs:
                env["LD_LIBRARY_PATH"] = ":".join(str(p) for p in libs)
        runtimes[key] = {"id": "shelf-" + key, "name": key.title() + " (imported)", "engine": "prism" if key == "prism" else "llama.cpp", "execution_kind": "native", "executable": str(Path(engine["binary"]).expanduser()), "env": env, "trust": True, "command_template": [], "source": str(root / "engines.toml")}
    for index, path in enumerate(sorted((root / "models").glob("*.toml"))):
        m = tomllib.loads(path.read_text())
        config = dict(engines[m["engine"]]["defaults"]) | m["runtime"]
        model_path = str(Path(config.pop("model")).expanduser().resolve())
        aid = "artifact-" + identity(model_path)[:20]
        if aid not in artifacts:
            artifacts[aid] = await asyncio.to_thread(adapters.inspect_artifact, model_path)
            artifacts[aid].update(id=aid, source="shelf-import", source_revision=None)
        for k in adapters.IGNORED:
            config.pop(k, None)
        catalog = {"version": 2, "catalog_id": m.get("catalog_id", m["id"]), "disabled_variants": m.get("disabled_variants", {}), "model": {
            "name": m.get("name", m["id"]), "enabled": m.get("enabled", True), "capabilities": m["capabilities"], "limit": {"context": config["ctx-size"] // config.get("parallel", 1), "output": m.get("output_limit", 8192)}, "variants": m.get("variants", []), "cost": m.get("pricing", {"input": 0, "output": 0})}}
        for k in ("body", "compatibility", "family"):
            if k in m:
                catalog["model"][k] = m[k]
        profile = {"id": "shelf-" + m["id"], "name": m.get("name", m["id"]), "artifact_id": aid, "runtime_id": runtimes[m["engine"]]["id"], "config": config, "raw_args": [], "catalog": catalog}
        profile["catalog"] = normalize(profile, m["id"])
        profiles.append(profile)
        deployments.append({"id": "shelf-" + m["id"], "name": m.get("name", m["id"]), "profile_id": profile["id"], "alias": m["id"], "port": 8110 + index, "residency": "on-demand", "priority": 50, "idle_timeout": 300, "reservation_mib": 0, "allow_eviction": True, "allow_uncertain": False, "enabled": False, "gpu": 0, "queue_timeout": 300})
    return {"source": str(root), "runtimes": list(runtimes.values()), "artifacts": list(artifacts.values()), "profiles": profiles, "deployments": deployments,
            "notes": ["Files referenced in place; no weights duplicated.", "Model checksum and source revision remain unknown until verified.", "Uncertain launch approval is required before automatic loading.", "Existing aliases and explicit capability metadata preserved."]}


async def apply(store, data):
    # Probe before starting the atomic import. Never overwrite an existing import.
    for runtime in data["runtimes"]:
        runtime["capabilities"] = await adapters.probe(runtime)
    with store.transaction() as c:
        for plural, kind in (("runtimes", "runtime"), ("artifacts", "artifact"), ("profiles", "profile"), ("deployments", "deployment")):
            existing = {x["id"] for x in store.list(kind, c)}
            for row in data[plural]:
                if row["id"] in existing:
                    continue
                if kind == "deployment":
                    row = row | {"state": "STOPPED", "profile_snapshot": store.get("profile", row["profile_id"], c), "reservation_active": 0}
                store.put(kind, row, c=c)
        store.event("import", {"source": data["source"], "profiles": len(data["profiles"])}, c=c)
    return {"imported": len(data["profiles"]), "notes": data["notes"]}
