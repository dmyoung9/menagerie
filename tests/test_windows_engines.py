"""Windows recipes and safe ZIP acquisition without network or real engines."""

import hashlib
import io
import zipfile
from types import SimpleNamespace

import httpx
import pytest

from controlplane import managed_engines as engines
from controlplane.store import Store


def asset(name, content=b"synthetic"):
    return {
        "name": name,
        "browser_download_url": "https://example.test/" + name,
        "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
        "size": len(content),
    }


def test_windows_cuda_companion_and_architecture():
    cpu = asset("llama-b123-bin-win-cpu-x64.zip")
    old = asset("llama-b123-bin-win-cuda-12.4-x64.zip")
    cuda = asset("llama-b123-bin-win-cuda-13.4-x64.zip")
    releases = [{"tag_name": "b123", "prerelease": True, "assets": [cpu, old, cuda]}]
    assert [
        r["backend"]
        for r in engines.release_recipes("llama.cpp", releases, "AMD64", "Windows")
    ] == ["cpu"]
    releases[0]["assets"].append(asset("cudart-llama-bin-win-cuda-13.4-x64.zip"))
    recipes = engines.release_recipes("llama.cpp", releases, "AMD64", "Windows")
    assert [r["backend"] for r in recipes] == ["cpu", "cuda"]
    assert recipes[1]["system"] == "Windows"
    assert recipes[1]["archive_format"] == "zip"
    assert len(recipes[1]["assets"]) == 2
    assert engines.release_recipes("llama.cpp", releases, "aarch64", "Windows") == []
    releases[0]["assets"][-1].pop("digest")
    assert len(engines.release_recipes("llama.cpp", releases, "AMD64", "Windows")) == 1


def bundle(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, value in entries:
            if isinstance(name, str):
                # ZipInfo normalizes backslashes when constructed on Windows.
                # Preserve the actual unsafe archive name for this fixture.
                entry = zipfile.ZipInfo("fixture")
                entry.filename = entry.orig_filename = name
            else:
                entry = name
            archive.writestr(entry, value)
    return output.getvalue()


@pytest.mark.parametrize(
    "names",
    [
        ["../escape"],
        ["/escape"],
        ["C:/escape"],
        ["folder\\escape"],
        ["NUL.txt"],
        ["COM1"],
        ["folder./escape"],
        ["file:stream"],
        ["a.dll", "A.dll"],
    ],
)
def test_zip_rejects_unsafe_windows_paths(tmp_path, names):
    archive = tmp_path / "fixture.zip"
    archive.write_bytes(bundle([(name, b"fixture") for name in names]))
    with pytest.raises(ValueError):
        engines.unpack(archive, tmp_path / "engine")
    assert not (tmp_path / "escape").exists()


def test_zip_rejects_symlinks_and_companion_overwrite(tmp_path):
    archive = tmp_path / "fixture.zip"
    link = zipfile.ZipInfo("link")
    link.create_system = 3
    link.external_attr = 0o120777 << 16
    archive.write_bytes(bundle([(link, b"outside")]))
    with pytest.raises(ValueError):
        engines.unpack(archive, tmp_path / "engine")
    archive.write_bytes(bundle([("engine.dll", b"one")]))
    engines.unpack(archive, tmp_path / "engine")
    with pytest.raises(ValueError, match="colliding"):
        engines.unpack(archive, tmp_path / "engine")


@pytest.mark.asyncio
async def test_windows_zip_install_probe_and_failed_download_cleanup(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(engines.platform, "system", lambda: "Windows")
    store = Store(tmp_path / "state")
    content = bundle(
        [
            ("llama-server.exe", b"synthetic executable"),
            ("ggml.dll", b"synthetic library"),
        ]
    )
    recipe = {
        "id": "fixture",
        "engine": "llama.cpp",
        "version": "b123",
        "backend": "cuda",
        "kind": "archive",
        "system": "Windows",
        "archive_format": "zip",
        "assets": [
            {
                "url": "https://example.test/fixture.zip",
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        ],
    }
    store.put("engine_recipe", recipe)

    async def probe(runtime):
        assert runtime["executable"].endswith("llama-server.exe")
        assert "LD_LIBRARY_PATH" not in runtime["env"]
        assert runtime["managed"]["dll_dirs"]
        return {"version": "synthetic", "flags": []}

    monkeypatch.setattr(engines.adapters, "probe", probe)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=content)
        )
    ) as client:
        jobs = SimpleNamespace(
            store=store,
            manager=SimpleNamespace(client=client),
            progress=lambda *args: None,
        )
        runtime = await engines.install(jobs, "job", "fixture")
        assert runtime["managed"]["backend"] == "cuda"
        with pytest.raises(FileExistsError):
            await engines.install(jobs, "job", "fixture")
        engines.remove(store, runtime)
        recipe["assets"][0]["sha256"] = "0" * 64
        store.put("engine_recipe", recipe)
        with pytest.raises(ValueError, match="verification"):
            await engines.install(jobs, "job", "fixture")
        assert not (store.root / "engines/fixture").exists()
        # A marked interrupted install may be retried; an unfamiliar directory
        # or a registered installation is never overwritten.
        recipe["assets"][0]["sha256"] = hashlib.sha256(content).hexdigest()
        store.put("engine_recipe", recipe)
        with store.connect() as connection:
            connection.execute("DELETE FROM objects WHERE kind='runtime'")
        interrupted = store.root / "engines/fixture"
        interrupted.mkdir()
        (interrupted / ".menagerie-install").write_text(
            engines.identity(recipe), encoding="utf-8"
        )
        (interrupted / "partial-download").write_bytes(b"synthetic interrupted data")
        runtime = await engines.install(jobs, "job", "fixture")
        assert not (interrupted / "partial-download").exists()
        assert runtime["executable"].endswith("llama-server.exe")
        assert runtime["revision"] == 2
        assert len(store.history("runtime", runtime["id"])) == 2


@pytest.mark.asyncio
async def test_windows_catalog_does_not_advertise_linux_vllm(tmp_path, monkeypatch):
    monkeypatch.setattr(engines.platform, "system", lambda: "Windows")
    monkeypatch.setattr(engines.platform, "machine", lambda: "AMD64")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[]))
    ) as client:
        catalog = await engines.catalog(client, Store(tmp_path / "state"))
    assert [e["id"] for e in catalog["engines"]] == ["llama.cpp"]
