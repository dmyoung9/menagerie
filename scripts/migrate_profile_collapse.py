#!/usr/bin/env python3
"""One-time migration: collapse the ``profile`` registry entity into deployments.

The ``profile`` record (id, name, artifact_id, runtime_id, config, raw_args,
catalog) is folded directly into each deployment. This script:

  1. Bakes in a self-contained registry backup (``registry.sqlite3`` via
     ``sqlite3.backup``) as a safety net. The owner should additionally copy
     the entire state directory to a timestamped ``.bak`` as the primary
     rollback point.
  2. Folds each profile's five fields (``artifact_id``, ``runtime_id``,
     ``config``, ``raw_args``, ``catalog``) into every deployment that
     references it, drops ``profile_id`` from the deployment, and re-sources
     the frozen ``profile_snapshot`` from the deployment's own folded fields
     (the snapshot no longer carries a separate ``id``/``name``/``revision``).
  3. Bumps each affected deployment's ``objects.revision`` by
     ``max(objects.revision, max(revisions.revision)) + 1`` and appends a
     matching row to ``revisions`` so the deployment history stays contiguous.
  4. Folds any ``kind='desired'`` rows the same way (no-op when nothing is
     pending).
  5. Deletes every ``profile`` row from both ``objects`` and ``revisions``
     (including the orphaned ``Bonsai 2 (27B)``).

The migration is a single transaction: on any failure it rolls back and exits
non-zero, leaving the registry untouched. It must be run against a **stopped**
daemon (the owner stops it and backs up the state directory first).

Usage:
    scripts/migrate_profile_collapse.py --dry-run --state /tmp/opencode/menagerie-copy
    scripts/migrate_profile_collapse.py --state ~/.local/state/menagerie

Rollback is: restore the pre-migration registry backup (or the owner's full
state-dir ``.bak``) AND revert the app build to the previous release.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

FIVE = ("artifact_id", "runtime_id", "config", "raw_args", "catalog")
SCHEMA_VERSION = 3


def encode(value: dict) -> str:
    """Match store.py::encode exactly so rewritten rows round-trip identically."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def decode(value: str) -> dict:
    return json.loads(value)


def daemon_running() -> bool:
    """Best-effort check for a live control-plane daemon (``python -m controlplane``)."""
    try:
        out = subprocess.run(
            ["pgrep", "-af", "controlplane"], text=True, capture_output=True, timeout=5
        ).stdout
    except (subprocess.SubprocessError, FileNotFoundError):
        return False
    for line in (out or "").splitlines():
        # Never match this script or its own shell.
        if os.path.abspath(__file__) in line:
            continue
        if "-m controlplane" in line or " controlplane" in line:
            return True
    return False


def run(args: argparse.Namespace) -> int:
    state = Path(os.path.expanduser(args.state)).resolve()
    db = state / "registry.sqlite3"
    if not db.exists():
        print(f"ERROR: no registry at {db}", file=sys.stderr)
        return 1

    # --- Safety gate: refuse to touch a live registry. --------------------
    if args.force and not args.dry_run:
        print("WARNING: --force given; skipping daemon check.", file=sys.stderr)
    if not args.dry_run and not args.force and daemon_running():
        print(
            "ERROR: a Menagerie daemon appears to be running. "
            "Stop it (`systemctl --user stop menagerie`) before migrating. "
            "Use --force only if you are certain.",
            file=sys.stderr,
        )
        return 2
    try:
        # Short lock probe: a live writer holds the write lock and will block
        # this immediate write transaction past the timeout. No data is written.
        probe = sqlite3.connect(f"{db.as_uri()}", uri=True, timeout=5)
        try:
            probe.execute("BEGIN IMMEDIATE")
            probe.rollback()
        finally:
            probe.close()
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc).lower():
            print(
                "ERROR: registry is locked; daemon likely still running.",
                file=sys.stderr,
            )
            return 2
        raise

    conn = sqlite3.connect(db, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            ver = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
        if ver != SCHEMA_VERSION:
            print(
                f"ERROR: schema_version={ver}, expected {SCHEMA_VERSION}. Aborting.",
                file=sys.stderr,
            )
            return 2

        # --- Backup (consistent pre-migration copy). ------------------------
        if not args.dry_run:
            backup = state / f"registry-migration-backup-{int(time.time())}.sqlite3"
            with conn:
                dst = sqlite3.connect(backup)
                try:
                    conn.backup(dst)
                finally:
                    dst.close()
            os.chmod(backup, 0o600)
            print(f"Backup written: {backup}")
            print("Note: for full rollback also keep the owner's state-dir `.bak`.")

        # Read everything we need before mutating.
        profiles = {
            r["id"]: decode(r["data"])
            for r in conn.execute("SELECT id, data FROM objects WHERE kind='profile'")
        }
        deployments = {
            r["id"]: decode(r["data"])
            for r in conn.execute(
                "SELECT id, data FROM objects WHERE kind='deployment'"
            )
        }
        desired_rows = list(
            conn.execute("SELECT id, revision, data FROM objects WHERE kind='desired'")
        )

        # --- Apply the fold in-transaction; dry-run rolls it back below. ----
        folded = do(conn, profiles, deployments, desired_rows)

        # --- Verify in-transaction state (post-asserts). --------------------
        assert_state(conn, folded)

        if args.dry_run:
            conn.rollback()
            print("DRY-RUN complete; rolled back, no changes persisted.")
            print("Post-asserts passed against the in-transaction result.")
            return 0

        conn.commit()
        print("Migration committed.")
        print(post_summary(conn, profiles, deployments))
        return 0

    except Exception as exc:  # noqa: BLE001 - report the full failure and roll back
        import traceback  # noqa: B008

        traceback.print_exc()
        conn.rollback()
        print(f"ERROR: migration failed and rolled back: {exc!r}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def do(conn, profiles, deployments, desired_rows) -> list:
    """Apply the fold. All reads use the pre-migration ``profiles``; writes go
    to the single transaction already open. Returns the folded deployment ids."""

    # 4. Desired rows: fold each deployment member, same as deployments.
    for row in desired_rows:
        data = decode(row["data"])
        rows = data.get("rows")
        if not isinstance(rows, list):
            continue
        changed = False
        for member in rows:
            if member.get("kind") != "deployment":
                continue
            d = member.get("data")
            if not isinstance(d, dict) or not d.get("profile_id"):
                continue
            fold(d, profiles)
            changed = True
        if changed:
            obj_rev = row["revision"]
            hist_rev = conn.execute(
                "SELECT COALESCE(MAX(revision),0) FROM revisions WHERE kind='desired' AND id=?",
                (row["id"],),
            ).fetchone()[0]
            data["revision"] = max(obj_rev, hist_rev) + 1
            encoded = encode(data)
            conn.execute(
                "INSERT OR REPLACE INTO objects(kind,id,revision,data) VALUES(?,?,?,?)",
                ("desired", row["id"], data["revision"], encoded),
            )
            conn.execute(
                "INSERT INTO revisions(kind,id,revision,ts,data) VALUES(?,?,?,?,?)",
                ("desired", row["id"], data["revision"], time.time(), encoded),
            )

    # 8. Deployments: fold + bump revision + append history (folded only).
    folded = []
    for dep_id, d in deployments.items():
        if d.get("profile_id") is None:
            continue
        if d["profile_id"] not in profiles:
            raise RuntimeError(
                f"Deployment {dep_id} references missing profile {d['profile_id']}"
            )
        fold(d, profiles)
        folded.append(dep_id)

    for dep_id in folded:
        d = deployments[dep_id]
        obj_rev = conn.execute(
            "SELECT revision FROM objects WHERE kind='deployment' AND id=?", (dep_id,)
        ).fetchone()[0]
        hist_rev = conn.execute(
            "SELECT COALESCE(MAX(revision),0) FROM revisions WHERE kind='deployment' AND id=?",
            (dep_id,),
        ).fetchone()[0]
        new_rev = max(obj_rev, hist_rev) + 1
        d["revision"] = new_rev
        encoded = encode(d)
        conn.execute(
            "INSERT OR REPLACE INTO objects(kind,id,revision,data) VALUES(?,?,?,?)",
            ("deployment", dep_id, new_rev, encoded),
        )
        conn.execute(
            "INSERT INTO revisions(kind,id,revision,ts,data) VALUES(?,?,?,?,?)",
            ("deployment", dep_id, new_rev, time.time(), encoded),
        )

    # 9. Delete every profile (objects + revisions) — including the orphan.
    if profiles:
        ids = ",".join("?" * len(profiles))
        conn.execute(
            f"DELETE FROM objects WHERE kind='profile' AND id IN ({ids})",
            tuple(profiles),
        )
        conn.execute(
            f"DELETE FROM revisions WHERE kind='profile' AND id IN ({ids})",
            tuple(profiles),
        )

    return folded


def fold(d: dict, profiles: dict) -> None:
    """Copy the referenced profile's five fields into deployment `d`, drop
    `profile_id`, and re-source `profile_snapshot` from the folded fields."""
    pid = d.get("profile_id")
    if pid is None:
        return
    p = profiles[pid]
    for k in FIVE:
        d[k] = p[k]
    d.pop("profile_id", None)
    # Keep a stable, self-contained snapshot (no id/name/revision keys).
    d["profile_snapshot"] = {k: p[k] for k in FIVE}


def assert_state(conn, folded):
    """Post-migration invariants, checked in-transaction."""
    n_prof = conn.execute(
        "SELECT COUNT(*) FROM objects WHERE kind='profile'"
    ).fetchone()[0]
    n_prof_rev = conn.execute(
        "SELECT COUNT(*) FROM revisions WHERE kind='profile'"
    ).fetchone()[0]
    assert n_prof == 0, f"expected 0 profile objects, found {n_prof}"
    assert n_prof_rev == 0, f"expected 0 profile revisions, found {n_prof_rev}"
    # Every deployment carries the five fields, no profile_id.
    for row in conn.execute("SELECT id, data FROM objects WHERE kind='deployment'"):
        d = decode(row["data"])
        assert "profile_id" not in d, f"{row['id']} still has profile_id"
        for k in FIVE:
            assert k in d, f"{row['id']} missing {k}"
    # Folded deployments re-source the snapshot from their own fields.
    for dep_id in folded:
        d = decode(
            conn.execute(
                "SELECT data FROM objects WHERE kind='deployment' AND id=?", (dep_id,)
            ).fetchone()[0]
        )
        keys = sorted(d.get("profile_snapshot", {}).keys())
        assert keys == sorted(FIVE), (
            f"{dep_id} snapshot keys {keys!r}, expected {sorted(FIVE)!r}"
        )
    print("  OK: zero profile objects and zero profile revisions")
    if folded:
        print(
            f"  OK: {len(folded)} deployments carry the five fields and a 5-key snapshot"
        )


def post_summary(conn, profiles, deployments) -> str:
    n_deps = conn.execute(
        "SELECT COUNT(*) FROM objects WHERE kind='deployment'"
    ).fetchone()[0]
    lines = [
        "=== Migration summary ===",
        f"  Deployments: {n_deps} (all five fields present, no profile_id)",
        f"  Profiles deleted: {len(profiles)} (incl. orphan)",
        "  All post-asserts passed",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--state", default=os.path.expanduser("~/.local/state/menagerie"))
    ap.add_argument(
        "--dry-run", action="store_true", help="Preview; rolls back, no writes"
    )
    ap.add_argument(
        "--force", action="store_true", help="Skip the daemon-running check"
    )
    args = ap.parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
