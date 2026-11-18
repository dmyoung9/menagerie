"""An incompatible registry must remain byte-for-byte usable by its old build."""

import sqlite3

import pytest

from controlplane.store import Store


@pytest.mark.parametrize("version", [None, 2, 3])
def test_old_layout_is_rejected_without_mutation(tmp_path, version):
    path = tmp_path / "registry.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE retained(value TEXT)")
        db.execute("INSERT INTO retained VALUES ('configuration')")
        if version is not None:
            db.execute("CREATE TABLE schema_version(version INTEGER PRIMARY KEY)")
            db.execute("INSERT INTO schema_version VALUES (?)", (version,))
    before = path.read_bytes()
    with pytest.raises(ValueError, match="requires fresh state"):
        Store(tmp_path)
    assert path.read_bytes() == before


def test_current_layout_reopens(tmp_path):
    Store(tmp_path).put("artifact", {"id": "weights", "name": "Fixture"})
    assert Store(tmp_path).get("artifact", "weights")["name"] == "Fixture"
