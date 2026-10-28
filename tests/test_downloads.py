import hashlib
import struct
from types import SimpleNamespace

import pytest

from controlplane import jobs as jobs_module
from controlplane.jobs import Jobs, selected_download
from controlplane.store import Store


def files(*names):
    return [{"name": name, "size": 100, "sha256": None} for name in names]


def test_single_gguf_download():
    selected = selected_download(files("model-Q4_K_M.gguf"), "model-Q4_K_M.gguf")
    assert [f["name"] for f in selected] == ["model-Q4_K_M.gguf"]


def test_unknown_file_is_rejected():
    with pytest.raises(ValueError, match="not present"):
        selected_download(files("model-Q4_K_M.gguf"), "other.gguf")


def test_split_gguf_expands_to_complete_ordered_set():
    rows = files(
        "BF16/model-00002-of-00002.gguf",
        "BF16/model-00001-of-00002.gguf",
        "mmproj-F16.gguf",
    )
    selected = selected_download(rows, "BF16/model-00002-of-00002.gguf")
    assert [f["name"] for f in selected] == [
        "BF16/model-00001-of-00002.gguf",
        "BF16/model-00002-of-00002.gguf",
    ]


def test_incomplete_split_gguf_is_rejected():
    with pytest.raises(ValueError, match="found 1 of 2"):
        selected_download(
            files("BF16/model-00001-of-00002.gguf"), "BF16/model-00001-of-00002.gguf"
        )


def test_duplicate_split_shard_is_rejected():
    with pytest.raises(ValueError, match="found 2 of 2"):
        selected_download(
            files("model-00001-of-00002.gguf", "model-00001-of-00002.gguf"),
            "model-00001-of-00002.gguf",
        )


@pytest.mark.asyncio
async def test_download_persists_one_artifact_for_the_complete_shard_set(
    tmp_path, monkeypatch
):
    store = Store(tmp_path / "state")
    jobs = Jobs(SimpleNamespace(store=store))
    jobs.progress = lambda ident, text: None
    weights = b"GGUF" + struct.pack("<IQQ", 3, 0, 0)
    digest = hashlib.sha256(weights).hexdigest()
    names = ["BF16/model-00001-of-00002.gguf", "BF16/model-00002-of-00002.gguf"]
    metadata = {
        "files": [
            {"name": name, "size": len(weights), "sha256": digest} for name in names
        ]
    }
    downloaded = []

    async def hf_files(repo, revision):
        return metadata

    def fake_download(repo_id, filename, revision, cache_dir, tqdm_class):
        downloaded.append(filename)
        path = tmp_path / "cache" / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(weights)
        return str(path)

    jobs.hf_files = hf_files
    monkeypatch.setattr(jobs_module, "hf_hub_download", fake_download)
    revision = "a" * 40
    artifact = await jobs.download("job", "org/model-GGUF", revision, names[1])

    assert downloaded == names
    assert artifact["local_path"].endswith(names[0])
    assert artifact["name"] == "model"
    assert artifact["size_bytes"] == len(weights) * 2
    assert artifact["sha256"] == digest
    assert [s["name"] for s in artifact["metadata"]["shards"]] == names
    assert [s["path"] for s in artifact["metadata"]["shards"]] == [
        str(tmp_path / "cache" / n) for n in names
    ]


@pytest.mark.asyncio
async def test_interrupted_download_can_be_retried_without_partial_registration(
    tmp_path, monkeypatch
):
    store = Store(tmp_path / "state")
    jobs = Jobs(SimpleNamespace(store=store))
    jobs.progress = lambda ident, text: None
    weights = b"GGUF" + struct.pack("<IQQ", 3, 0, 0)
    names = ["model-00001-of-00002.gguf", "model-00002-of-00002.gguf"]

    async def hf_files(repo, revision):
        return {
            "files": [
                {
                    "name": n,
                    "size": len(weights),
                    "sha256": hashlib.sha256(weights).hexdigest(),
                }
                for n in names
            ]
        }

    jobs.hf_files = hf_files
    interrupted = True

    def download(repo_id, filename, revision, cache_dir, tqdm_class):
        if interrupted and filename == names[1]:
            raise OSError("Connection interrupted")
        path = tmp_path / filename
        path.write_bytes(weights)
        return str(path)

    monkeypatch.setattr(jobs_module, "hf_hub_download", download)
    with pytest.raises(OSError, match="Connection interrupted"):
        await jobs.download("first", "org/model-GGUF", "a" * 40, names[0])
    assert store.list("artifact") == []
    assert (tmp_path / names[0]).read_bytes() == weights
    interrupted = False
    artifact = await jobs.download("retry", "org/model-GGUF", "a" * 40, names[0])
    assert len(store.list("artifact")) == 1
    assert artifact["size_bytes"] == len(weights) * 2
