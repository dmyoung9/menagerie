"""Contract tests for the download selection manifest and acquired-file
identity (Stage 1 of the model-first UI plan).

These assert the rules the Stage 3 download jobs and the repository UI rely on:
bundle detection, selection resolution, partial-failure/retry, revision safety,
and the separation of acquired files from deployable artifacts.
"""

import pytest

from controlplane import manifests
from controlplane.schema import Artifact
from controlplane.store import Store


def files(*names):
    return [{"name": name, "size": 100, "sha256": None} for name in names]


def manifest_for(repo, rev, names, bundle_map=None):
    return manifests.build_manifest(repo, rev, names, bundle_map)


# ---------------------------------------------------------------------------
# Group detection
# ---------------------------------------------------------------------------


def test_split_gguf_autodetects_into_complete_group():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files(
            "BF16/model-00001-of-00002.gguf",
            "BF16/model-00002-of-00002.gguf",
        ),
    )
    g = next(g for g in m["groups"] if g["id"] == "gguf-BF16_model-00002")
    assert g["kind"] == "gguf_split"
    assert g["required"] == [
        "BF16/model-00001-of-00002.gguf",
        "BF16/model-00002-of-00002.gguf",
    ]
    assert g["complete"] is True


def test_incomplete_split_gguf_stays_visible_but_not_selectable():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files("BF16/model-00001-of-00002.gguf"),
    )
    g = next(g for g in m["groups"] if g["id"] == "gguf-BF16_model-00002")
    assert g["complete"] is False
    # The missing shard is still named, so the UI can explain it.
    assert "BF16/model-00002-of-00002.gguf" in g["required"]


def test_explicit_safetensors_bundles_are_grouped_without_assuming_sharedness():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files(
            "model.safetensors",
            "extra.bin",
            "second.model.safetensors",
        ),
        bundle_map={"Bundle A": ["model.safetensors", "model.safetensors.index.json"]},
    )
    g = next(g for g in m["groups"] if g["id"] == "bundle-Bundle A")
    assert g["kind"] == "safetensors"
    # The index.json is required but absent at this revision -> incomplete.
    assert g["complete"] is False
    # second.model.safetensors is NOT in the bundle map, so it stays standalone
    # rather than being lumped into Bundle A.
    assert (
        next(g for g in m["groups"] if g["id"] == "second.model.safetensors")["kind"]
        == "standalone"
    )


def test_companions_and_standalones_remain_selectable_and_never_hidden():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files("mmproj-F16.gguf", "config.json", "notes.txt"),
    )
    kinds = {g["name"]: g["kind"] for g in m["groups"]}
    assert kinds["mmproj-F16.gguf"] == "companion"
    assert kinds["config.json"] == "standalone"
    assert kinds["notes.txt"] == "standalone"
    # Unknown/unclassified (notes.txt) is still a complete selectable group.
    assert all(g["complete"] for g in m["groups"])


def test_manifest_preserves_checksums_and_sizes_where_provided():
    rows = [
        {"name": "a.bin", "size": 5, "sha256": "abc"},
        {"name": "b.bin", "size": None, "sha256": None},
    ]
    m = manifests.build_manifest("org/model", "a" * 40, rows)
    assert m["files"] == rows
    assert next(f for f in m["files"] if f["name"] == "b.bin")["size"] is None


# ---------------------------------------------------------------------------
# Selection resolution
# ---------------------------------------------------------------------------


def test_selecting_a_group_expands_to_its_required_members():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files(
            "BF16/model-00001-of-00002.gguf",
            "BF16/model-00002-of-00002.gguf",
            "config.json",
        ),
    )
    needed = manifests.required_files(m, ["gguf-BF16_model-00002", "config.json"])
    assert needed == [
        "BF16/model-00001-of-00002.gguf",
        "BF16/model-00002-of-00002.gguf",
        "config.json",
    ]


def test_selecting_a_bundle_expands_only_to_declared_members():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files("model.safetensors", "extra.bin"),
        bundle_map={"Bundle A": ["model.safetensors"]},
    )
    assert manifests.required_files(m, ["bundle-Bundle A"]) == ["model.safetensors"]


def test_expanded_bundle_children_are_not_independently_selectable():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files("BF16/model-00001-of-00002.gguf", "BF16/model-00002-of-00002.gguf"),
    )
    # A raw shard path is a member, not a group id -> rejected, so a hidden
    # or stale selection can't slip a single shard in as its own "bundle".
    with pytest.raises(ValueError, match="not present at this revision"):
        manifests.required_files(m, ["BF16/model-00001-of-00002.gguf"])


def test_duplicate_selection_is_deduplicated_and_ordered():
    m = manifests.build_manifest("org/model", "a" * 40, files("a.bin", "b.bin"))
    assert manifests.validate_selection(m, ["b.bin", "a.bin", "b.bin"]) == [
        "b.bin",
        "a.bin",
    ]


def test_unknown_or_stale_selection_is_rejected():
    m = manifests.build_manifest("org/model", "a" * 40, files("a.bin"))
    with pytest.raises(ValueError, match="not present at this revision"):
        manifests.required_files(m, ["b.bin"])
    with pytest.raises(ValueError):
        manifests.required_files(m, ["bundle-ghost"])


# ---------------------------------------------------------------------------
# Partial failure and retry
# ---------------------------------------------------------------------------


def test_pending_lists_every_not_downloaded_required_file():
    m = manifests.build_manifest("org/model", "a" * 40, files("a.bin", "b.bin"))
    statuses = {"a.bin": "downloaded", "b.bin": "failed"}
    assert manifests.pending(m, ["a.bin", "b.bin"], statuses) == ["b.bin"]


def test_retry_targets_are_exactly_failed_and_missing():
    m = manifests.build_manifest(
        "org/model",
        "a" * 40,
        files("a.bin", "b.bin", "c.bin", "d.bin"),
    )
    statuses = {
        "a.bin": "downloaded",
        "b.bin": "failed",
        "c.bin": "missing",
        "d.bin": "downloading",
    }
    assert manifests.retry_targets(m, ["a.bin", "b.bin", "c.bin"], statuses) == [
        "b.bin",
        "c.bin",
    ]
    # in-flight and completed bytes are never retransferred
    all_needed = manifests.required_files(m, ["a.bin", "b.bin", "c.bin", "d.bin"])
    assert "d.bin" not in manifests.retry_targets(m, all_needed, statuses)


def test_retry_targets_empty_when_all_complete():
    m = manifests.build_manifest("org/model", "a" * 40, files("a.bin"))
    assert manifests.retry_targets(m, ["a.bin"], {"a.bin": "downloaded"}) == []


# ---------------------------------------------------------------------------
# Revision safety
# ---------------------------------------------------------------------------


def test_selection_clears_when_revision_changes():
    m = manifests.build_manifest("org/model", "a" * 40, files("a.bin"))
    same, cleared = manifests.clear_selection(m, ["a.bin"], "a" * 40)
    assert same == ["a.bin"] and not cleared
    cleared_sel, changed = manifests.clear_selection(m, ["a.bin"], "b" * 40)
    assert cleared_sel == [] and changed


def test_selection_is_bound_to_one_revision():
    # The manifest is keyed to one resolved revision; a selection is only ever
    # validated against the manifest for the revision the user actually chose,
    # so bytes from revision A can never be silently applied to revision B.
    rev_a = manifests.build_manifest("org/model", "a" * 40, files("a.bin"))
    rev_b = manifests.build_manifest("org/model", "b" * 40, files("a.bin"))
    assert rev_a["revision"] != rev_b["revision"]
    cleared, changed = manifests.clear_selection(rev_a, ["a.bin"], "b" * 40)
    assert cleared == [] and changed


# ---------------------------------------------------------------------------
# Acquired-file vs deployable-artifact identity
# ---------------------------------------------------------------------------


def test_acquired_file_and_artifact_are_separate_records(tmp_path):
    store = Store(tmp_path / "state")
    rev = "a" * 40
    store.put(
        "downloaded_file", manifests.downloaded_file_record("org/m", rev, "a.bin")
    )
    store.put(
        "artifact",
        {
            "name": "Model",
            "local_path": "/x/a.bin",
            "source": "huggingface",
            "repo": "org/m",
            "source_revision": rev,
            "format": "gguf",
            "size_bytes": 100,
            "metadata": {},
        },
    )
    assert len(store.list("downloaded_file")) == 1
    assert len(store.list("artifact")) == 1
    # Round-tripping the acquired file through the model must succeed and must
    # strip the store-injected revision.
    rec = next(iter(store.list("downloaded_file")))
    validated = manifests.validate_downloaded_file(rec)
    assert validated.repo == "org/m"
    assert validated.source_revision == rev
    assert validated.name == "a.bin"
    assert validated.status == "not_downloaded"


def test_acquiring_a_file_never_enables_or_creates_a_model(tmp_path):
    store = Store(tmp_path / "state")
    store.put(
        "downloaded_file",
        manifests.downloaded_file_record(
            "org/m",
            "a" * 40,
            "mmproj.gguf",
            group_id="mmproj.gguf",
            size_bytes=10,
        ),
    )
    # No deployment, no artifact: acquisition is purely inventory.
    assert store.list("artifact") == []
    assert store.list("deployment") == []


def test_existing_artifact_record_still_validates_unchanged(tmp_path):
    """Additive schema: pre-existing artifact rows keep validating."""
    store = Store(tmp_path / "state")
    rec = store.get(
        "artifact",
        store.put(
            "artifact",
            {
                "name": "Model",
                "local_path": "/x",
                "format": "gguf",
                "size_bytes": 0,
                "metadata": {},
            },
        )["id"],
    )
    payload = dict(rec)
    payload.pop("revision", None)  # drop the store-injected revision
    Artifact.model_validate(payload)


def test_downloaded_file_key_is_repo_revision_path():
    assert manifests.downloaded_file_key("o", "r", "f") == ("o", "r", "f")
    assert manifests.downloaded_file_key(
        "o", "r", "f"
    ) != manifests.downloaded_file_key("o", "r2", "f")
    assert manifests.downloaded_file_key(
        "o", "r", "f"
    ) != manifests.downloaded_file_key("o", "r", "g")
