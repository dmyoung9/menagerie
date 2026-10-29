"""Explicit, offline cleanup of known application data. Never follow registry paths."""

import os
import re
import shutil
import sqlite3
import stat
from contextlib import ExitStack, closing
from pathlib import Path

from .host import lock_file, state_path

CATEGORIES = ("engines", "models", "cache", "logs", "settings")
MARKER = ".menagerie-state"
SIGNATURE = "menagerie-state-v1\n"


def reparse(path):
    info = path.lstat()
    return path.is_symlink() or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def owned_state(root):
    marker = root / MARKER
    if marker.exists() or marker.is_symlink():
        if (
            not marker.is_file()
            or reparse(marker)
            or marker.read_text(encoding="utf-8") != SIGNATURE
        ):
            raise ValueError("Unrecognized state marker; refusing data removal")
        return
    database = root / "registry.sqlite3"
    if not database.is_file() or reparse(database):
        raise ValueError("No recognizable Menagerie state; refusing data removal")
    try:
        with closing(
            sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)
        ) as connection:
            tables = {
                r[0]
                for r in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
        if (
            not {
                "objects",
                "revisions",
                "schema_version",
                "events",
                "samples",
                "requests",
            }
            <= tables
        ):
            raise ValueError("Registry is not Menagerie state")
    except sqlite3.Error as exc:
        raise ValueError(
            "Cannot verify Menagerie registry; refusing data removal"
        ) from exc


def targets(root, categories):
    result = []
    for category in CATEGORIES:
        if category not in categories:
            continue
        if category == "engines":
            result.extend(root / name for name in ("engines", "runtimes"))
        elif category == "models":
            result.append(root / "models/hf")
        elif category == "cache":
            result.append(root / "cache")
        elif category == "logs":
            result.extend(
                root / name
                for name in ("daemon.log", "daemon.previous.log", "launcher.log")
            )
            deployments = root / "deployments"
            if deployments.exists():
                if reparse(deployments):
                    raise ValueError(
                        "Runtime log directory is a link or junction; refusing cleanup"
                    )
                for directory in deployments.iterdir():
                    if reparse(directory):
                        raise ValueError(
                            "Runtime directory is a link or junction; refusing cleanup"
                        )
                    if directory.is_dir():
                        result.extend(
                            directory / name
                            for name in ("runtime.log", "runtime.previous.log")
                        )
        else:
            result.extend(
                root / name
                for name in (
                    "registry.sqlite3",
                    "registry.sqlite3-wal",
                    "registry.sqlite3-shm",
                    "opencode-managed.json",
                )
            )
            result.extend(
                p
                for p in root.iterdir()
                if re.fullmatch(r"registry-backup-\d+\.sqlite3", p.name)
            )
    return result


def validate_target(root, path):
    # Reject links/junctions on every selected path component. A models/hf
    # junction must never redirect deletion into a shared Hugging Face cache.
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        if current.exists() or current.is_symlink():
            if reparse(current):
                raise ValueError(
                    "Selected data path is a link or junction; nothing was removed"
                )
    if not path.exists():
        return
    if path.is_dir():
        for directory, dirs, files in os.walk(path, followlinks=False):
            for name in dirs + files:
                item = Path(directory) / name
                if reparse(item):
                    # HF snapshots legitimately contain file symlinks. Unlink
                    # those entries, never traverse them. Directory links and
                    # other reparse types remain an explicit recovery error.
                    if item.is_symlink() and not item.is_dir():
                        continue
                    raise ValueError(
                        "Selected data contains a directory link/junction; nothing was removed"
                    )


def remove_data(value, categories, *, confirm=False):
    selected = set(categories)
    if not confirm or not selected or selected - set(CATEGORIES):
        raise ValueError(
            "Explicit categories and confirmation are required for data removal"
        )
    raw = state_path(value, resolve=False)
    root = raw.resolve()
    if root == Path(root.anchor) or root == Path.home().resolve():
        raise ValueError("Refusing cleanup of a filesystem root or home directory")
    if not raw.exists() and not raw.is_symlink():
        return {
            "categories": [c for c in CATEGORIES if c in selected],
            "removed_locations": 0,
        }
    if not raw.is_dir() or reparse(raw):
        raise ValueError(
            "State directory is not a directory or is a link/junction; refusing cleanup"
        )
    owned_state(root)
    with ExitStack() as stack:
        stack.enter_context(lock_file(root / "launcher.lock"))
        stack.enter_context(lock_file(root / "daemon.lock"))
        owned_state(root)
        planned = targets(root, selected)
        for target in planned:
            validate_target(root, target)
        # Keep this tiny ownership marker and lock files even after removing the
        # registry, so later cleanup can safely identify retained application data.
        (root / MARKER).write_text(SIGNATURE, encoding="utf-8")
        removed = 0
        for target in planned:
            if not target.exists():
                continue
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            removed += 1
    return {
        "categories": [c for c in CATEGORIES if c in selected],
        "removed_locations": removed,
    }
