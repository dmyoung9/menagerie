#!/usr/bin/env python3
"""One-time migration: promote pool runtime settings to the pool row.

Old shape: every model member (``deployment`` row) carried its own
``port``; the pool row (``deployment_set`` with ``engine_pool: true``)
carried only shared policy keys. The pooled model code requires the pool
row to own ``runtime_id`` / ``gpu`` / ``port`` — members mirror
``runtime_id`` / ``gpu`` and never carry a serving port.

This script:

  1. Bakes in a self-contained registry backup (``registry.sqlite3`` via
     ``sqlite3.backup``) as a safety net. The owner should additionally copy
     the entire state directory to a timestamped ``.bak`` as the primary
     rollback point.
  2. For each ``engine_pool`` set, promotes the owner member's fields to the
     pool row: ``runtime_id`` / ``gpu`` / ``port``. The owner is the first
     member in ``member_ids`` — the member whose deployment directory is the
     pool router's ``--models-preset`` and whose port is the shared serving
     port.
  3. Nulls ``port`` on every pool member (owner included) and refuses to
     run unless members already mirror the owner's ``runtime_id`` / ``gpu``.
  4. Bumps each affected row's ``objects.revision`` by
     ``max(objects.revision, max(revisions.revision)) + 1`` and appends a
     matching row to ``revisions`` so the history stays contiguous.
  5. Rewrites any ``kind='desired'`` rows the same way (none currently exist;
     the path is kept so a pending change can never outlive the migration).

The migration is a single transaction: on any failure it rolls back and
exits non-zero, leaving the registry untouched. It must be run against a
**stopped** daemon (the owner stops it and backs up the state directory first).

Usage:
    scripts/migrate_pools_ownership.py --dry-run --state /tmp/opencode/menagerie-copy
    scripts/migrate_pools_ownership.py --state ~/.local/state/menagerie

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

SCHEMA_VERSION = 3
RESERVED_PORTS = {8001, 8017}  # gateway + control plane


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
        pools = [
            decode(r["data"])
            for r in conn.execute(
                "SELECT data FROM objects WHERE kind='deployment_set'"
            )
        ]
        deployments = {
            r["id"]: decode(r["data"])
            for r in conn.execute(
                "SELECT id, data FROM objects WHERE kind='deployment'"
            )
        }
        desired_rows = list(
            conn.execute("SELECT id, revision, data FROM objects WHERE kind='desired'")
        )

        # --- Apply the promotion in-transaction; dry-run rolls it back. ----
        facts_by_pool = do(conn, pools, deployments, desired_rows)

        # --- Verify in-transaction state (post-asserts). --------------------
        assert_state(conn, facts_by_pool)

        if args.dry_run:
            conn.rollback()
            print("DRY-RUN complete; rolled back, no changes persisted.")
            print("Post-asserts passed against the in-transaction result.")
            return 0

        conn.commit()
        print("Migration committed.")
        print(post_summary(conn, facts_by_pool))
        return 0

    except Exception as exc:  # noqa: BLE001 - report the full failure and roll back
        import traceback  # noqa: B008

        traceback.print_exc()
        conn.rollback()
        print(f"ERROR: migration failed and rolled back: {exc!r}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def _bump_and_write(conn: sqlite3.Connection, kind: str, data: dict) -> None:
    """Write a row with a contiguous revision and append history."""
    obj_rev = int(data.get("revision") or 0)
    hist_rev = conn.execute(
        "SELECT COALESCE(MAX(revision),0) FROM revisions WHERE kind=? AND id=?",
        (kind, data["id"]),
    ).fetchone()[0]
    data["revision"] = max(obj_rev, hist_rev) + 1
    encoded = encode(data)
    conn.execute(
        "INSERT OR REPLACE INTO objects(kind,id,revision,data) VALUES(?,?,?,?)",
        (kind, data["id"], data["revision"], encoded),
    )
    conn.execute(
        "INSERT INTO revisions(kind,id,revision,ts,data) VALUES(?,?,?,?,?)",
        (kind, data["id"], data["revision"], time.time(), encoded),
    )


def do(conn, pools, deployments, desired_rows):
    """Apply the promotion. All reads use the pre-migration rows; writes go to
    the single transaction already open. Returns ``{pool_id: owner facts}``."""
    pools_by_id = {p["id"]: p for p in pools}
    facts_by_pool = {}

    # --- Owner facts: every engine pool is promoted from its first member. --
    for p in pools:
        if not p.get("engine_pool"):
            continue
        member_ids = p.get("member_ids") or []
        if not member_ids:
            raise RuntimeError(
                f"engine_pool {p['id']} has no members; cannot promote an owner"
            )
        owner_id = member_ids[0]
        if owner_id not in deployments:
            raise RuntimeError(
                f"engine_pool {p['id']} references missing owner {owner_id}"
            )
        owner = deployments[owner_id]
        runtime_id = owner.get("runtime_id")
        port = owner.get("port")
        if not runtime_id:
            raise RuntimeError(
                f"owner {owner_id} ({owner.get('name')!r}) has no runtime_id"
            )
        if port is None:
            raise RuntimeError(
                f"owner {owner_id} ({owner.get('name')!r}) has no serving port"
            )
        if port in RESERVED_PORTS:
            raise RuntimeError(
                f"owner {owner_id} port {port} is reserved (gateway/control plane)"
            )
        for mid in member_ids:
            if mid not in deployments:
                raise RuntimeError(
                    f"engine_pool {p['id']} references missing member {mid}"
                )
        facts = {"runtime_id": runtime_id, "gpu": owner.get("gpu"), "port": port}
        # Members must already mirror the owner; if not, this is a registry
        # inconsistency a human must resolve, not something to "fix" here.
        for mid in member_ids:
            d = deployments[mid]
            if d.get("runtime_id") != runtime_id or d.get("gpu") != owner.get("gpu"):
                raise RuntimeError(
                    f"member {mid} ({d.get('name')!r}) does not mirror owner "
                    f"runtime_id/gpu of {owner_id}; fix before migrating"
                )
        facts_by_pool[p["id"]] = facts

    # --- Pool rows gain runtime_id / gpu / port. ----------------------------
    for pool_id, facts in facts_by_pool.items():
        p = pools_by_id[pool_id]
        p["runtime_id"] = facts["runtime_id"]
        p["gpu"] = facts["gpu"]
        p["port"] = facts["port"]
        _bump_and_write(conn, "deployment_set", p)

    # --- Members lose their serving port (owner included). -------------------
    member_facts = {}
    for p in pools_by_id.values():
        facts = facts_by_pool.get(p["id"])
        if facts is None:
            continue
        for mid in p.get("member_ids") or []:
            member_facts[mid] = facts

    for mid, facts in member_facts.items():
        d = deployments[mid]
        d["runtime_id"] = facts["runtime_id"]
        d["gpu"] = facts["gpu"]
        d["port"] = None
        _bump_and_write(conn, "deployment", d)

    # --- Desired rows: same shape, so they migrate with the live rows. -------
    for row in desired_rows:
        data = decode(row["data"])
        rows = data.get("rows")
        if not isinstance(rows, list):
            continue
        changed = False
        for member in rows:
            d = member.get("data")
            if not isinstance(d, dict):
                continue
            kind = member.get("kind")
            if kind == "deployment_set" and d.get("engine_pool"):
                facts = facts_by_pool.get(d.get("id"))
                if facts is None:
                    continue
                before = (d.get("runtime_id"), d.get("gpu"), d.get("port"))
                d["runtime_id"] = facts["runtime_id"]
                d["gpu"] = facts["gpu"]
                d["port"] = facts["port"]
                if before != (facts["runtime_id"], facts["gpu"], facts["port"]):
                    changed = True
            elif kind == "deployment":
                facts = member_facts.get(d.get("id"))
                if facts is None:
                    continue
                before = (d.get("port"), d.get("runtime_id"), d.get("gpu"))
                d["port"] = None
                d["runtime_id"] = facts["runtime_id"]
                d["gpu"] = facts["gpu"]
                if before != (None, facts["runtime_id"], facts["gpu"]):
                    changed = True
        if changed:
            obj_rev = int(row["revision"])
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

    return facts_by_pool


def assert_state(conn, facts_by_pool):
    """Post-migration invariants, checked in-transaction."""
    pools = [
        decode(r["data"])
        for r in conn.execute("SELECT data FROM objects WHERE kind='deployment_set'")
    ]
    deployments = {
        r["id"]: decode(r["data"])
        for r in conn.execute("SELECT id, data FROM objects WHERE kind='deployment'")
    }
    owned = set()
    for p in pools:
        if not p.get("engine_pool"):
            continue
        facts = facts_by_pool[p["id"]]
        if (
            p.get("runtime_id") != facts["runtime_id"]
            or p.get("gpu") != facts["gpu"]
            or p.get("port") != facts["port"]
        ):
            raise RuntimeError(f"pool {p['id']} not promoted to {facts}")
        if facts["port"] in RESERVED_PORTS:
            raise RuntimeError(f"pool {p['id']} got a reserved port {facts['port']}")
        for mid in p.get("member_ids") or []:
            owned.add(mid)
            d = deployments[mid]
            if d.get("port") is not None:
                raise RuntimeError(
                    f"pooled member {mid} still carries port {d['port']}"
                )
            if d.get("runtime_id") != facts["runtime_id"]:
                raise RuntimeError(f"member {mid} runtime_id does not match pool")
            if d.get("gpu") != facts["gpu"]:
                raise RuntimeError(f"member {mid} gpu does not match pool")

    n_standalone = 0
    for d_id, d in deployments.items():
        if d_id not in owned:
            n_standalone += 1
            if d.get("port") is None:
                raise RuntimeError(
                    f"standalone deployment {d_id} lost its serving port"
                )

    print(f"  OK: {len(facts_by_pool)} pools own their runtime/device/port")
    print(
        f"  OK: {sum(len(p['member_ids']) for p in pools if p.get('engine_pool'))} "
        "pool members null-port, all mirroring pool runtime_id/gpu"
    )
    print(f"  OK: {n_standalone} standalone deployments keep their ports unchanged")


def post_summary(conn, facts_by_pool) -> str:
    pooled_members = 0
    standalone = 0
    owned = set()
    for p in (
        decode(r["data"])
        for r in conn.execute("SELECT data FROM objects WHERE kind='deployment_set'")
    ):
        if not p.get("engine_pool"):
            continue
        owned.update(p.get("member_ids") or [])
        pooled_members += len(p.get("member_ids") or [])
    for d_id, d in (
        (r["id"], decode(r["data"]))
        for r in conn.execute("SELECT id, data FROM objects WHERE kind='deployment'")
    ):
        if d_id not in owned:
            standalone += 1
    lines = [
        "=== Migration summary ===",
        f"  Runtime pools promoted: {len(facts_by_pool)} (owner runtime_id/gpu/port moved to pool rows)",
        f"  Pooled members port-nullified: {pooled_members}",
        f"  Standalone deployments unchanged: {standalone}",
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
