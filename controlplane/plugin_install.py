"""Install only Menagerie's auto-discovered plugin, never rewrite user JSONC."""

import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from .version import VERSION

FILES = ("index.ts", "discovery.ts", "package.json")
MANIFEST = ".menagerie-managed.json"


def source():
    bundled = Path(__file__).resolve().parent / "opencode_plugin"
    return (
        bundled
        if bundled.exists()
        else Path(__file__).resolve().parent.parent / "plugins/opencode"
    )


def config_root(value=None):
    return (
        Path(
            value
            or os.environ.get("OPENCODE_CONFIG_DIR")
            or Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
            / "opencode"
        )
        .expanduser()
        .resolve()
    )


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(target):
    if target.is_symlink() or not target.is_dir() or not (target / MANIFEST).is_file():
        raise ValueError(f"Refusing to replace an unmanaged plugin: {target}")
    manifest = json.loads((target / MANIFEST).read_text())
    if manifest.get("owner") != "menagerie" or set(manifest.get("files", {})) != set(
        FILES
    ) | {"settings.json"}:
        raise ValueError("Invalid managed-plugin manifest")
    allowed = set(manifest["files"]) | {
        MANIFEST,
        "node_modules",
        "package-lock.json",
        "bun.lock",
        "bun.lockb",
    }
    if any(p.name not in allowed for p in target.iterdir()):
        raise ValueError(
            "Plugin directory contains unfamiliar files; preserve/review it manually"
        )
    for name, expected in manifest["files"].items():
        file = target / name
        if file.is_symlink() or not file.is_file() or digest(file) != expected:
            raise ValueError(
                f"Managed plugin file was edited; preserve/review it manually: {file}"
            )
    return manifest


def manage(operation, directory=None, gateway_port=8001):
    root = config_root(directory)
    target = root / "plugins/menagerie"
    if operation == "status":
        if not target.exists() and not target.is_symlink():
            return {"installed": False, "path": str(target)}
        manifest = verify(target)
        return {
            "installed": True,
            "path": str(target),
            "version": manifest["version"],
            "reload_required": "Restart the OpenCode server to load changed plugins.",
        }
    if not 1 <= gateway_port <= 65535:
        raise ValueError("Gateway port must be 1..65535")
    backup = None
    if target.exists() or target.is_symlink():
        verify(target)
    if operation == "remove":
        if target.exists():
            backups = root / "menagerie-plugin-backups"
            backups.mkdir(parents=True, exist_ok=True, mode=0o700)
            backup = (
                Path(tempfile.mkdtemp(prefix=f"removed-{time.time_ns()}-", dir=backups))
                / "menagerie"
            )
            target.rename(backup)
    elif operation == "install":
        target.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=".menagerie-install-", dir=root))
        try:
            for name in FILES:
                shutil.copyfile(source() / name, stage / name)
            # Deployed package has only runtime dependencies, never test tooling.
            package = json.loads((stage / "package.json").read_text())
            package.pop("devDependencies", None)
            package.pop("scripts", None)
            (stage / "package.json").write_text(json.dumps(package, indent=2) + "\n")
            (stage / "settings.json").write_text(
                json.dumps({"baseURL": f"http://127.0.0.1:{gateway_port}/v1"}) + "\n"
            )
            manifest = {
                "owner": "menagerie",
                "version": VERSION,
                "files": {
                    name: digest(stage / name) for name in (*FILES, "settings.json")
                },
            }
            (stage / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n")
            if target.exists():
                backups = root / "menagerie-plugin-backups"
                backups.mkdir(parents=True, exist_ok=True, mode=0o700)
                backup = (
                    Path(
                        tempfile.mkdtemp(
                            prefix=f"updated-{time.time_ns()}-", dir=backups
                        )
                    )
                    / "menagerie"
                )
                target.rename(backup)
            try:
                stage.rename(target)
            except OSError:
                if backup:
                    backup.rename(target)
                raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)  # Only our private staging directory.
    else:
        raise ValueError("Unknown plugin operation")
    return {
        "operation": operation,
        "path": str(target),
        "backup": str(backup) if backup else None,
        "config_preserved": True,
        "note": "Restart the OpenCode server (and reconnect OpenChamber) to load/unload the plugin. Existing defaults are unchanged.",
    }
