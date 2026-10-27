import hashlib
import io
import tarfile
from types import SimpleNamespace

import httpx
import pytest

from controlplane import managed_engines as engines
from controlplane.store import Store
from controlplane import adapters


def asset(name, content=b"binary"):
    return {"name": name, "browser_download_url": "https://example.test/" + name,
            "digest": "sha256:" + hashlib.sha256(content).hexdigest(), "size": len(content)}


def test_release_selection_skips_marker_release_and_requires_cuda_libraries():
    cuda = asset("llama-b123-bin-ubuntu-cuda-12.8-x64.tar.gz")
    cpu = asset("llama-b123-bin-ubuntu-x64.tar.gz")
    releases = [{"tag_name": "v1", "assets": [asset("nightly-tag.txt")]},
                {"tag_name": "b123", "prerelease": True, "assets": [cuda, cpu]}]
    assert [r["backend"] for r in engines.release_recipes("llama.cpp", releases, "x86_64")] == ["cpu"]
    releases[1]["assets"].append(asset("cudart-" + cuda["name"]))
    recipes = engines.release_recipes("llama.cpp", releases, "x86_64")
    assert recipes[0]["version"] == "b123"
    assert len(recipes[0]["assets"]) == 2
    assert engines.release_recipes("llama.cpp", releases, "unsupported") == []
    cpu.pop("digest")
    assert len(engines.release_recipes("llama.cpp", releases, "x86_64")) == 1


def archive(name="bin/llama-server", link=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        entry = tarfile.TarInfo(name)
        content = b"#!/bin/sh\necho 'test-engine --ctx-size --parallel'\n"
        entry.mode = 0o755
        if link:
            entry.type, entry.linkname = tarfile.SYMTYPE, link
        else:
            entry.size = len(content)
        tar.addfile(entry, None if link else io.BytesIO(content))
    return output.getvalue()


@pytest.mark.parametrize("name,link", [("../escape", None), ("bin/link", "/tmp/outside")])
def test_archive_rejects_path_and_link_escapes(tmp_path, name, link):
    path = tmp_path / "test.tar.gz"
    path.write_bytes(archive(name, link))
    with pytest.raises(tarfile.FilterError):
        engines.unpack(path, tmp_path / "engine")
    assert not (tmp_path / "escape").exists()


@pytest.mark.asyncio
async def test_vllm_probe_reads_full_serve_help(tmp_path):
    executable = tmp_path / "vllm"
    executable.write_text('#!/bin/sh\nif [ "$1" = serve ] && [ "$2" = --help=all ]; then\n echo "--max-model-len --gpu-memory-utilization"\nelse\n echo "--help --version"\nfi\n')
    executable.chmod(0o700)
    result = await adapters.probe({"engine": "vllm", "execution_kind": "native", "executable": str(executable), "trust": True})
    assert "max-model-len" in result["flags"]
    assert "gpu-memory-utilization" in result["flags"]


@pytest.mark.asyncio
async def test_install_verifies_probes_and_preserves_existing_install(tmp_path):
    store = Store(tmp_path)
    content = archive()
    recipe = {"id": "test-recipe", "engine": "llama.cpp", "version": "test", "backend": "cpu",
              "kind": "archive", "assets": [{"url": "https://example.test/engine.tar.gz",
              "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}]}
    store.put("engine_recipe", recipe)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content))) as client:
        jobs = SimpleNamespace(store=store, manager=SimpleNamespace(client=client), progress=lambda *args: None)
        runtime = await engines.install(jobs, "job", recipe["id"])
        assert "ctx-size" in runtime["capabilities"]["flags"]
        assert runtime["managed"]["recipe_id"] == recipe["id"]
        with pytest.raises(FileExistsError):
            await engines.install(jobs, "job", recipe["id"])
        assert (tmp_path / "engines/test-recipe/bin/llama-server").exists()
        engines.remove(store, runtime)
        assert not (tmp_path / "engines/test-recipe").exists()
        recipe["assets"][0]["sha256"] = "0" * 64
        store.put("engine_recipe", recipe)
        with pytest.raises(ValueError, match="verification"):
            await engines.install(jobs, "job", recipe["id"])
        assert not (tmp_path / "engines/test-recipe").exists()
