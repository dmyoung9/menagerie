"""Stage 3: independent repository acquisition.

The repository manifest endpoint and the per-file inventory download job,
with no live runtime and no network. The HF API and the file downloads are
faked at the client / SDK boundaries, matching the Stage-1
(repo, revision, name) identity contract.
"""

import hashlib
from types import SimpleNamespace

import httpx
import pytest

from controlplane import jobs as jobs_module
from controlplane import manifests
from controlplane.api import create_app
from controlplane.store import Store

Jobs = jobs_module.Jobs


REPO = "org/model"
SHA = "a" * 40
CACHE = "/cache/"


def hf_file(name, size=100, verified=True):
    """A file row from ``hf_files``. When ``verified`` its sha256 equals what
    the mocked ``adapters.file_hash`` will return for the cache path, so the
    download's checksum verification passes exactly as it would for real
    bytes. ``verified=False`` gives ``sha256=None`` (no metadata to check)."""
    sha = hashlib.sha256((CACHE + name).encode()).hexdigest() if verified else None
    return {"name": name, "size": size, "sha256": sha}


def _file_hash():
    """A synchronous ``adapters.file_hash`` stand-in (called via
    ``asyncio.to_thread`` by the job). Deterministic on the path."""

    def fh(path):
        return hashlib.sha256(str(path).encode()).hexdigest()

    return fh


def hf_files_factory(files):
    """A ``Jobs.hf_files`` stand-in. Must take ``(self, repo, revision)`` because
    it replaces a bound instance method on the class via monkeypatch."""

    async def hf_files(self, repo, revision="main"):
        return {"repo": repo, "revision": SHA, "files": files}

    return hf_files


def make_jobs(tmp_path, files, monkeypatch):
    """A bare ``Jobs`` over an isolated ``Store``, with ``hf_files`` faked.
    The store doubles as the manager's store so job rows can be seeded."""
    store = Store(tmp_path / "state")
    monkeypatch.setattr(jobs_module.Jobs, "hf_files", hf_files_factory(files))
    return Jobs(SimpleNamespace(store=store)), store


def complete_ids(manifest):
    return [g["id"] for g in manifest["groups"] if g["complete"]]


# ---------------------------------------------------------------------------
# Per-file independent download job
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_download_files_registers_per_file_no_artifact(tmp_path, monkeypatch):
    files = [
        hf_file("model.safetensors"),
        hf_file("mmproj.gguf"),
        hf_file("config.json", verified=False),
    ]
    jobs, store = make_jobs(tmp_path, files, monkeypatch)
    monkeypatch.setattr(
        jobs_module, "hf_hub_download", lambda **kw: f"{CACHE}{kw['filename']}"
    )
    monkeypatch.setattr(jobs_module.adapters, "file_hash", _file_hash())

    manifest = manifests.build_manifest(REPO, SHA, files)
    job = store.put("job", {"id": "df1", "name": "df", "state": "QUEUED"})
    result = await jobs.download_files(job["id"], REPO, SHA, complete_ids(manifest))

    assert result["downloaded"] == 3
    assert result["failed"] == 0
    rows = {r["name"]: r for r in store.list("downloaded_file")}
    assert set(rows) == {"model.safetensors", "mmproj.gguf", "config.json"}
    assert all(r["status"] == "downloaded" for r in rows.values())
    # Verified bytes matched the repository metadata; unknown-sha bytes pass.
    assert rows["model.safetensors"]["sha256"]
    assert rows["config.json"]["sha256"] is None
    assert rows["model.safetensors"]["local_path"] == CACHE + "model.safetensors"
    # Independent acquisition registers inventory only: no deployable artifact
    # and no deployment is created or enabled.
    assert store.list("artifact") == []
    assert store.list("deployment") == []
    # Deterministic (repo, revision, path) identity.
    assert rows["model.safetensors"]["id"] == jobs_module.downloaded_file_id(
        REPO, SHA, "model.safetensors"
    )


@pytest.mark.asyncio
async def test_download_files_partial_success(tmp_path, monkeypatch):
    files = [hf_file("a.bin"), hf_file("b.bin"), hf_file("c.bin", verified=False)]
    jobs, store = make_jobs(tmp_path, files, monkeypatch)
    monkeypatch.setattr(jobs_module.adapters, "file_hash", _file_hash())

    calls = []

    def hf_hub_download(**kw):
        fn = kw["filename"]
        calls.append(fn)
        if fn == "b.bin":
            raise OSError("simulated upstream failure")
        return f"{CACHE}{fn}"

    monkeypatch.setattr(jobs_module, "hf_hub_download", hf_hub_download)

    manifest = manifests.build_manifest(REPO, SHA, files)
    job = store.put("job", {"id": "df2", "name": "df", "state": "QUEUED"})
    result = await jobs.download_files(job["id"], REPO, SHA, complete_ids(manifest))

    # Partial success: b.bin fails, a.bin and c.bin succeed.
    assert result["downloaded"] == 2
    assert result["failed"] == 1
    assert result["skipped"] == 0
    rows = {r["name"]: r for r in store.list("downloaded_file")}
    assert rows["a.bin"]["status"] == "downloaded"
    assert rows["c.bin"]["status"] == "downloaded"
    assert rows["b.bin"]["status"] == "failed"
    assert rows["b.bin"]["error"]
    assert rows["b.bin"]["local_path"] is None
    # Every requested file was attempted, in selection order.
    assert calls == ["a.bin", "b.bin", "c.bin"]


@pytest.mark.asyncio
async def test_download_files_reacquire_skips_downloaded(tmp_path, monkeypatch):
    files = [hf_file("a.bin"), hf_file("b.bin")]
    jobs, store = make_jobs(tmp_path, files, monkeypatch)
    monkeypatch.setattr(jobs_module.adapters, "file_hash", _file_hash())

    b_attempts = {"n": 0}
    calls = []

    def hf_hub_download(**kw):
        fn = kw["filename"]
        calls.append(fn)
        # b.bin fails on its first attempt only and succeeds on retry.
        if fn == "b.bin":
            b_attempts["n"] += 1
            if b_attempts["n"] == 1:
                raise OSError("simulated upstream failure")
        return f"{CACHE}{fn}"

    monkeypatch.setattr(jobs_module, "hf_hub_download", hf_hub_download)

    manifest = manifests.build_manifest(REPO, SHA, files)
    job = store.put("job", {"id": "df3", "name": "df", "state": "QUEUED"})

    # First run: a.bin succeeds, b.bin fails.
    first = await jobs.download_files(job["id"], REPO, SHA, complete_ids(manifest))
    assert first["downloaded"] == 1 and first["failed"] == 1

    rows = {r["name"]: r for r in store.list("downloaded_file")}
    assert rows["a.bin"]["status"] == "downloaded"
    assert rows["b.bin"]["status"] == "failed"

    # Retry with the same selection: re-acquires only the failed file and
    # never retransfers completed bytes.
    second = await jobs.download_files(job["id"], REPO, SHA, complete_ids(manifest))
    assert second["downloaded"] == 1 and second["skipped"] == 1
    rows = {r["name"]: r for r in store.list("downloaded_file")}
    assert rows["a.bin"]["status"] == "downloaded"
    assert rows["b.bin"]["status"] == "downloaded"
    assert calls.count("a.bin") == 1  # a.bin exactly once
    assert calls.count("b.bin") == 2  # b.bin: failed, then succeeded on retry


@pytest.mark.asyncio
async def test_download_files_deterministic_id_no_duplicates(tmp_path, monkeypatch):
    files = [hf_file("x.bin", verified=False)]
    jobs, store = make_jobs(tmp_path, files, monkeypatch)
    monkeypatch.setattr(
        jobs_module, "hf_hub_download", lambda **kw: f"{CACHE}{kw['filename']}"
    )

    manifest = manifests.build_manifest(REPO, SHA, files)
    gid = complete_ids(manifest)[0]
    job = store.put("job", {"id": "df4", "name": "df", "state": "QUEUED"})
    for _ in range(3):
        await jobs.download_files(job["id"], REPO, SHA, [gid])

    rows = store.list("downloaded_file")
    # Three re-acquisitions -> still exactly one row (deterministic id).
    assert len(rows) == 1
    assert rows[0]["status"] == "downloaded"
    assert rows[0]["id"] == jobs_module.downloaded_file_id(REPO, SHA, "x.bin")


@pytest.mark.asyncio
async def test_download_files_stale_selection_rejected(tmp_path, monkeypatch):
    files = [hf_file("x.bin", verified=False)]
    jobs, store = make_jobs(tmp_path, files, monkeypatch)
    job = store.put("job", {"id": "df5", "name": "df", "state": "QUEUED"})
    # A selection referencing a file/bundle absent at this revision is rejected.
    with pytest.raises(ValueError, match="not present at this revision"):
        await jobs.download_files(job["id"], REPO, SHA, ["bundle-ghost"])


# ---------------------------------------------------------------------------
# Repository manifest endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manifest_endpoint_groups_files_status_and_selection(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)
    store = app.state.store
    files = [
        hf_file("model.safetensors"),
        {"name": "model.safetensors.index.json", "size": 50, "sha256": None},
        hf_file("config.json", verified=False),
    ]
    monkeypatch.setattr(jobs_module.Jobs, "hf_files", hf_files_factory(files))
    # Seed one acquired file so per-file local status surfaces.
    seed = manifests.downloaded_file_record(
        REPO, SHA, "config.json", status="downloaded"
    )
    seed["id"] = jobs_module.downloaded_file_id(REPO, SHA, "config.json")
    store.put("downloaded_file", seed)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        token = (await c.get("/api/status")).json()["csrf_token"]
        headers = {"X-Menagerie-Token": token}
        bundle_map = {"BundleA": ["model.safetensors"]}
        manifest = manifests.build_manifest(REPO, SHA, files, bundle_map)
        bundle_gid = [
            g["id"] for g in manifest["groups"] if g["kind"] == "safetensors"
        ][0]

        # No selection: file list and groups carry per-file local status.
        r = await c.post(
            "/api/downloads/manifest",
            json={"repo": REPO, "bundle_map": bundle_map},
            headers=headers,
        )
        body = r.json()
        assert r.status_code == 200
        assert body["revision"] == SHA
        assert {f["name"] for f in body["files"]} == {
            "model.safetensors",
            "model.safetensors.index.json",
            "config.json",
        }
        assert body["groups"]
        assert any(
            g["id"] == bundle_gid and g["kind"] == "safetensors" for g in body["groups"]
        )
        by_name = {f["name"]: f for f in body["files"]}
        assert by_name["config.json"]["status"] == "downloaded"
        assert by_name["model.safetensors"]["status"] == "not_downloaded"
        # The seeded file's local path/error surface through the row.
        assert by_name["config.json"]["local_path"] is None
        assert by_name["config.json"]["error"] is None

        # With a selection: required / pending / retry computed server-side.
        r2 = await c.post(
            "/api/downloads/manifest",
            json={
                "repo": REPO,
                "bundle_map": bundle_map,
                "selected": [bundle_gid, "config.json"],
            },
            headers=headers,
        )
        body2 = r2.json()
        assert sorted(body2["required_files"]) == ["config.json", "model.safetensors"]
        # config.json already acquired -> only model.safetensors is pending.
        assert body2["pending"] == ["model.safetensors"]
        assert body2["retry_targets"] == []
        # Selection is validated and echoed order-preserving.
        assert body2["selected"] == [bundle_gid, "config.json"]


@pytest.mark.asyncio
async def test_manifest_endpoint_stale_selection_conflict(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    monkeypatch.setattr(
        jobs_module.Jobs,
        "hf_files",
        hf_files_factory([hf_file("x.bin", verified=False)]),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        token = (await c.get("/api/status")).json()["csrf_token"]
        r = await c.post(
            "/api/downloads/manifest",
            json={"repo": REPO, "selected": ["bundle-ghost"]},
            headers={"X-Menagerie-Token": token},
        )
        assert r.status_code == 409


@pytest.mark.asyncio
async def test_manifest_endpoint_requires_token(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    monkeypatch.setattr(
        jobs_module.Jobs,
        "hf_files",
        hf_files_factory([hf_file("x.bin", verified=False)]),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        r = await c.post("/api/downloads/manifest", json={"repo": REPO})
        assert r.status_code == 403


@pytest.mark.asyncio
async def test_download_files_endpoint_requires_selection_and_sha(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)
    monkeypatch.setattr(
        jobs_module.Jobs,
        "hf_files",
        hf_files_factory([hf_file("x.bin", verified=False)]),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        token = (await c.get("/api/status")).json()["csrf_token"]
        headers = {"X-Menagerie-Token": token}
        # Empty selection -> 400.
        r = await c.post(
            "/api/downloads/files",
            json={"repo": REPO, "revision": SHA, "selected": []},
            headers=headers,
        )
        assert r.status_code == 400
        # Non-sha revision -> 400 (must be the resolved sha from the manifest).
        r = await c.post(
            "/api/downloads/files",
            json={"repo": REPO, "revision": "main", "selected": ["x.bin"]},
            headers=headers,
        )
        assert r.status_code == 400
