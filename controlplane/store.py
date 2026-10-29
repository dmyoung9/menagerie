"""Small transactional registry; immutable revisions live beside operational state."""

import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def identity(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def uid():
    return uuid.uuid4().hex


class Store:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.root / "registry.sqlite3"
        with self.connect() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript("""
            CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
            INSERT OR IGNORE INTO schema_version VALUES(1);
            CREATE TABLE IF NOT EXISTS objects(
              kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
              data TEXT NOT NULL, PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS revisions(
              kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,
              ts REAL NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id,revision));
            CREATE TABLE IF NOT EXISTS events(
              seq INTEGER PRIMARY KEY AUTOINCREMENT,ts REAL NOT NULL,
              deployment_id TEXT,kind TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS samples(
              ts REAL PRIMARY KEY,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS requests(
              id TEXT PRIMARY KEY,ts REAL NOT NULL,deployment_id TEXT NOT NULL,
              data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS requests_time ON requests(ts);
            CREATE INDEX IF NOT EXISTS events_time ON events(ts);
            """)
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=15)
        c.row_factory = sqlite3.Row
        try:
            with c:
                yield c
        finally:
            c.close()

    @contextmanager
    def transaction(self):
        with self.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            yield c

    def list(self, kind, c=None):
        if c is None:
            with self.connect() as c:
                return self.list(kind, c)
        return [
            json.loads(r[0])
            for r in c.execute(
                "SELECT data FROM objects WHERE kind=? ORDER BY id", (kind,)
            )
        ]

    def get(self, kind, ident, c=None):
        if c is None:
            with self.connect() as c:
                return self.get(kind, ident, c)
        row = c.execute(
            "SELECT data FROM objects WHERE kind=? AND id=?", (kind, ident)
        ).fetchone()
        if row is None:
            raise KeyError(f"Unknown {kind}: {ident}")
        return json.loads(row[0])

    def put(self, kind, data, expected=None, historical=True, c=None):
        if c is None:
            with self.transaction() as c:
                return self.put(kind, data, expected, historical, c)
        data = dict(data)
        ident = data.setdefault("id", uid())
        row = c.execute(
            "SELECT revision FROM objects WHERE kind=? AND id=?", (kind, ident)
        ).fetchone()
        revision = row[0] if row else 0
        if expected is not None and revision != expected:
            raise ValueError("Revision changed; refresh before saving")
        # Recreating a removed identity (for example a managed engine recipe)
        # must extend retained history, not collide with its first revision.
        historical_revision = (
            c.execute(
                "SELECT COALESCE(MAX(revision),0) FROM revisions WHERE kind=? AND id=?",
                (kind, ident),
            ).fetchone()[0]
            if row is None and historical
            else revision
        )
        data["revision"] = max(revision, historical_revision) + 1
        c.execute(
            "INSERT OR REPLACE INTO objects VALUES(?,?,?,?)",
            (kind, ident, data["revision"], encode(data)),
        )
        if historical:
            c.execute(
                "INSERT INTO revisions VALUES(?,?,?,?,?)",
                (kind, ident, data["revision"], time.time(), encode(data)),
            )
        return data

    def event(self, kind, data, deployment=None, c=None):
        if c is None:
            with self.connect() as c:
                return self.event(kind, data, deployment, c)
        cur = c.execute(
            "INSERT INTO events(ts,deployment_id,kind,data) VALUES(?,?,?,?)",
            (time.time(), deployment, kind, encode(data)),
        )
        return cur.lastrowid

    def events(self, after=0, limit=500):
        with self.connect() as c:
            rows = c.execute(
                "SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?", (after, limit)
            ).fetchall()
        return [dict(r) | {"data": json.loads(r["data"])} for r in rows]

    def history(self, kind, ident):
        with self.connect() as c:
            return [
                json.loads(r[0])
                for r in c.execute(
                    "SELECT data FROM revisions WHERE kind=? AND id=? ORDER BY revision DESC",
                    (kind, ident),
                )
            ]

    def backup(self):
        path = self.root / f"registry-backup-{time.time_ns()}.sqlite3"
        with self.connect() as source:
            dest = sqlite3.connect(path)
            try:
                source.backup(dest)
            finally:
                dest.close()
        path.chmod(0o600)
        return path
