"""Destructive cleanup is exercised only against owned synthetic state."""

import json
import os

import pytest

from controlplane.cli import main
from controlplane.host import lock_file
from controlplane.store import Store
from controlplane.uninstall import CATEGORIES, MARKER, remove_data


def seed(root):
    Store(root).put(
        "artifact",
        {
            "id": "external",
            "local_path": str(root.parent / "external.gguf"),
            "source": "local",
        },
    )
    files = {
        "engines": ["engines/fixture/worker.exe", "runtimes/source/build/worker.exe"],
        "models": ["models/hf/models--fixture/blobs/weights.bin"],
        "cache": ["cache/cuda/fixture.bin"],
        "logs": [
            "daemon.log",
            "daemon.previous.log",
            "launcher.log",
            "deployments/fixture/runtime.log",
            "deployments/fixture/runtime.previous.log",
        ],
        "settings": ["registry-backup-123.sqlite3", "opencode-managed.json"],
    }
    for names in files.values():
        for name in names:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic owned data")
    (root.parent / "external.gguf").write_bytes(b"synthetic external weights")
    (root / "models/local-import.gguf").write_bytes(b"synthetic local import")
    (root / "unfamiliar.txt").write_text("user-owned file")
    return files


@pytest.mark.parametrize("category", CATEGORIES)
def test_each_category_preserves_unselected_data_and_external_models(
    tmp_path, category
):
    root = tmp_path / "state \u96ea"
    files = seed(root)
    result = remove_data(root, [category], confirm=True)
    assert result["categories"] == [category]
    for group, names in files.items():
        for name in names:
            assert (root / name).exists() == (group != category)
    assert (root / "registry.sqlite3").exists() == (category != "settings")
    assert (tmp_path / "external.gguf").read_bytes() == b"synthetic external weights"
    assert (root / "models/local-import.gguf").exists()
    assert (root / "unfamiliar.txt").read_text() == "user-owned file"


def test_all_categories_and_retry_without_registry(tmp_path):
    root = tmp_path / "state"
    seed(root)
    remove_data(root, ["settings"], confirm=True)
    assert not (root / "registry.sqlite3").exists()
    assert (root / MARKER).is_file()
    remove_data(root, CATEGORIES, confirm=True)
    assert not (root / "engines").exists()
    assert not (root / "models/hf").exists()
    assert not (root / "cache").exists()
    assert (root / "models/local-import.gguf").exists()
    assert remove_data(root, CATEGORIES, confirm=True)["removed_locations"] == 0


@pytest.mark.parametrize(
    "categories,confirmed", [([], True), (["models"], False), (["everything"], True)]
)
def test_consent_is_required(tmp_path, categories, confirmed):
    root = tmp_path / "state"
    seed(root)
    with pytest.raises(ValueError, match="Explicit categories"):
        remove_data(root, categories, confirm=confirmed)
    assert (root / "models/hf").exists()


@pytest.mark.parametrize("name", ["daemon.lock", "launcher.lock"])
def test_active_process_locks_prevent_cleanup(tmp_path, name):
    root = tmp_path / "state"
    seed(root)
    with lock_file(root / name):
        with pytest.raises(RuntimeError, match="Another Menagerie"):
            remove_data(root, CATEGORIES, confirm=True)
    assert (root / "engines/fixture/worker.exe").exists()
    assert (root / "registry.sqlite3").exists()


def test_unrecognized_directory_is_not_modified(tmp_path):
    root = tmp_path / "unrelated"
    root.mkdir()
    (root / "registry.sqlite3").write_bytes(b"not a database")
    with pytest.raises(ValueError, match="Cannot verify"):
        remove_data(root, CATEGORIES, confirm=True)
    assert sorted(p.name for p in root.iterdir()) == ["registry.sqlite3"]


def test_never_launched_state_is_a_noop(tmp_path):
    from controlplane.launcher import run

    root = tmp_path / "never-launched"
    run("stop", state=root, browser=False)
    assert not root.exists()
    assert remove_data(root, CATEGORIES, confirm=True)["removed_locations"] == 0
    assert not root.exists()


@pytest.mark.skipif(
    os.name == "nt", reason="Windows junction coverage lives in installed checks"
)
def test_state_and_marker_links_are_never_followed(tmp_path):
    root = tmp_path / "state"
    seed(root)
    alias = tmp_path / "alias"
    alias.symlink_to(root, target_is_directory=True)
    with pytest.raises(ValueError, match="link/junction"):
        remove_data(alias, CATEGORIES, confirm=True)
    external = tmp_path / "external-marker"
    external.write_text("user data")
    (root / MARKER).symlink_to(external)
    with pytest.raises(ValueError, match="Unrecognized state marker"):
        remove_data(root, CATEGORIES, confirm=True)
    assert external.read_text() == "user data"
    assert (root / "registry.sqlite3").exists()


def test_failed_file_removal_preserves_registry_for_recovery(tmp_path, monkeypatch):
    from controlplane import uninstall

    root = tmp_path / "state"
    seed(root)

    def fail(path):
        raise PermissionError("synthetic locked engine file")

    monkeypatch.setattr(uninstall.shutil, "rmtree", fail)
    with pytest.raises(PermissionError, match="locked engine"):
        remove_data(root, CATEGORIES, confirm=True)
    assert (root / "registry.sqlite3").exists()
    assert (root / "models/hf").exists()


@pytest.mark.parametrize("name", ["cache", "engines", "registry-backup-123.sqlite3"])
def test_unexpected_file_types_reject_entire_plan(tmp_path, name):
    root = tmp_path / "state"
    Store(root)
    unexpected = root / name
    if name.endswith(".sqlite3"):
        unexpected.mkdir()
        (unexpected / "user-data.txt").write_text("unfamiliar data")
    else:
        unexpected.write_text("unfamiliar data")
    with pytest.raises(ValueError, match="unexpected type"):
        remove_data(root, CATEGORIES, confirm=True)
    assert unexpected.exists()
    assert (root / "registry.sqlite3").exists()


@pytest.mark.skipif(
    os.name == "nt",
    reason="Windows directory junction coverage lives in installed checks",
)
@pytest.mark.parametrize(
    "location", ["models", "models/hf", "cache", "engines/fixture"]
)
def test_directory_links_reject_entire_plan_before_any_deletion(tmp_path, location):
    root = tmp_path / "state"
    Store(root)
    external = tmp_path / "external"
    external.mkdir()
    (external / "keep.bin").write_bytes(b"external")
    target = root / location
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError, match="link|junction"):
        remove_data(root, CATEGORIES, confirm=True)
    assert (external / "keep.bin").read_bytes() == b"external"
    assert (root / "registry.sqlite3").exists()


@pytest.mark.skipif(
    os.name == "nt", reason="Creating file symlinks may require Windows developer mode"
)
def test_snapshot_file_symlinks_are_unlinked_without_following(tmp_path):
    root = tmp_path / "state"
    Store(root)
    external = tmp_path / "external.gguf"
    external.write_bytes(b"external weights")
    snapshot = root / "models/hf/snapshots/fixture/model.gguf"
    snapshot.parent.mkdir(parents=True)
    snapshot.symlink_to(external)
    remove_data(root, ["models"], confirm=True)
    assert external.read_bytes() == b"external weights"
    assert not snapshot.exists()


def test_cli_requires_confirmation_and_writes_result(tmp_path, capsys):
    root = tmp_path / "state"
    seed(root)
    report = tmp_path / "report.txt"
    assert (
        main(
            [
                "remove-data",
                "--state",
                str(root),
                "--remove",
                "cache",
                "--report",
                str(report),
            ]
        )
        == 1
    )
    assert (root / "cache").exists()
    assert "confirmation" in report.read_text()
    assert (
        main(
            [
                "remove-data",
                "--state",
                str(root),
                "--remove",
                "cache",
                "--confirm",
                "--report",
                str(report),
            ]
        )
        == 0
    )
    assert json.loads(report.read_text())["categories"] == ["cache"]
    capsys.readouterr()
