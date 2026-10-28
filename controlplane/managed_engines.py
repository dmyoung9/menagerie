"""Versioned user-space engine installs from upstream release assets."""

import asyncio
import hashlib
import platform
import re
import shutil
import sys
import tarfile
from pathlib import Path

from . import adapters
from .engine_catalog import ENGINES
from .store import identity


def release_recipes(engine, releases, machine):
    """Select concrete assets, never the moving GitHub /latest download URL."""
    arch = {"x86_64": "x64", "aarch64": "arm64"}.get(machine)
    if not arch:
        return []
    recipes = {}
    for release in releases:
        # llama.cpp publishes its normal numbered builds as GitHub prereleases.
        if release.get("draft") or (
            release.get("prerelease")
            and not (
                engine == "llama.cpp"
                and re.fullmatch(r"b\d+", release.get("tag_name", ""))
            )
        ):
            continue
        tag = release["tag_name"]
        assets = release.get("assets", [])
        for asset in assets:
            name = asset["name"]
            if not name.startswith("llama-") or not name.endswith(f"-{arch}.tar.gz"):
                continue
            if "-bin-ubuntu-" not in name and "-bin-linux-" not in name:
                continue
            if "-cuda-12.8-" in name:
                backend = "cuda"
            elif re.search(rf"-bin-(?:ubuntu|linux)-{arch}\.tar\.gz$", name):
                backend = "cpu"
            else:
                continue
            if backend in recipes:
                continue
            selected = [asset]
            if engine == "llama.cpp" and backend == "cuda":
                companion = next(
                    (a for a in assets if a["name"] == "cudart-" + name), None
                )
                if not companion:
                    continue
                selected.append(companion)
            if any(
                not re.fullmatch(r"sha256:[0-9a-f]{64}", a.get("digest") or "")
                for a in selected
            ):
                continue
            recipes[backend] = {
                "engine": engine,
                "version": tag,
                "backend": backend,
                "kind": "archive",
                "assets": [
                    {
                        "url": a["browser_download_url"],
                        "sha256": a["digest"][7:],
                        "size": a["size"],
                    }
                    for a in selected
                ],
                "requirements": "Linux; NVIDIA driver supporting CUDA 12.8"
                if backend == "cuda"
                else "Linux CPU",
            }
    return list(recipes.values())


async def catalog(client, store):
    if platform.system() != "Linux":
        return {
            "engines": [],
            "note": "Managed engines currently support Linux. Register an existing engine on other platforms.",
        }

    async def discover(engine):
        try:
            if engine["id"] == "vllm":
                response = await client.get(
                    "https://pypi.org/pypi/vllm/json", timeout=30
                )
                response.raise_for_status()
                version = response.json()["info"]["version"]
                if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.post\d+)?", version):
                    raise ValueError("No stable vLLM release found")
                recipes = [
                    {
                        "engine": "vllm",
                        "version": version,
                        "backend": "cuda",
                        "kind": "venv",
                        "requirements": "Linux NVIDIA GPU; compatible driver and Python wheel. Isolated environment; several GB download.",
                    }
                ]
            else:
                response = await client.get(
                    f"https://api.github.com/repos/{engine['repository']}/releases",
                    params={"per_page": 10},
                    timeout=30,
                )
                response.raise_for_status()
                recipes = release_recipes(
                    engine["id"], response.json(), platform.machine()
                )
            for recipe in recipes:
                recipe["repository"] = engine["repository"]
                recipe["id"] = identity(recipe)
                store.put("engine_recipe", recipe, historical=False)
            return engine | {
                "releases": recipes,
                "note": ""
                if recipes
                else "No matching checksummed Linux binary found for this platform.",
            }
        except (ValueError, KeyError, OSError) as exc:
            return engine | {"releases": [], "note": str(exc)}
        except Exception as exc:
            # One unavailable supplier must not hide the other engines.
            return engine | {"releases": [], "note": f"Release discovery failed: {exc}"}

    return {"engines": await asyncio.gather(*(discover(e) for e in ENGINES))}


def unpack(archive, destination):
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if sum(m.size for m in members) > 12 * 1024**3:
            raise ValueError("Engine archive exceeds the 12 GiB extraction limit")
        # data_filter rejects escapes, special files and links outside destination.
        bundle.extractall(destination, members=members, filter="data")


async def install(jobs, ident, recipe_id):
    recipe = jobs.store.get("engine_recipe", recipe_id)
    root = jobs.store.root / "engines" / recipe_id
    root.parent.mkdir(parents=True, exist_ok=True)
    # mkdir is the cross-job exclusion: an install never overwrites another one.
    root.mkdir()
    try:
        if recipe["kind"] == "archive":
            for index, asset in enumerate(recipe["assets"]):
                archive = root / f"download-{index}.tar.gz"
                digest, received = hashlib.sha256(), 0
                jobs.progress(
                    ident, f"Downloading {recipe['engine']} {recipe['version']}"
                )
                async with jobs.manager.client.stream(
                    "GET", asset["url"], follow_redirects=True, timeout=120
                ) as response:
                    response.raise_for_status()
                    with archive.open("xb") as output:
                        async for block in response.aiter_bytes(1024 * 1024):
                            received += len(block)
                            if received > asset["size"]:
                                raise ValueError(
                                    "Engine download exceeds published asset size"
                                )
                            output.write(block)
                            digest.update(block)
                            jobs.progress(
                                ident,
                                f"Downloading · {received:,} / {asset['size']:,} bytes",
                            )
                if received != asset["size"] or digest.hexdigest() != asset["sha256"]:
                    raise ValueError("Engine download failed SHA-256/size verification")
                jobs.progress(ident, "Verified SHA-256; extracting engine")
                # Keep cleanup sequential with extraction even on task cancellation.
                unpack(archive, root)
                archive.unlink()
            binaries = list(root.rglob("llama-server"))
            if len(binaries) != 1:
                raise ValueError("Release must contain exactly one llama-server")
            executable = binaries[0]
            executable.chmod(executable.stat().st_mode | 0o100)
            libraries = sorted(
                {str(p.parent) for p in root.rglob("*.so*") if p.is_file()}
            )
            env = {"LD_LIBRARY_PATH": ":".join(libraries)} if libraries else {}
        else:
            jobs.progress(ident, "Creating isolated vLLM environment")
            await adapters.command(
                [sys.executable, "-m", "venv", str(root)], timeout=120
            )
            jobs.progress(
                ident,
                f"Installing vLLM {recipe['version']} and binary dependencies; this can take several minutes",
            )
            await adapters.command(
                [
                    str(root / "bin/python"),
                    "-m",
                    "pip",
                    "--isolated",
                    "install",
                    "--index-url",
                    "https://pypi.org/simple",
                    "--only-binary=:all:",
                    "--disable-pip-version-check",
                    "--no-cache-dir",
                    f"vllm=={recipe['version']}",
                ],
                timeout=3600,
            )
            executable, env = root / "bin/vllm", {}
        jobs.progress(ident, "Checking installed engine")
        env |= {
            "HF_HOME": str(jobs.store.root / "cache/huggingface"),
            "XDG_CACHE_HOME": str(jobs.store.root / "cache"),
        }
        if recipe["engine"] == "vllm":
            env |= {
                "TRITON_CACHE_DIR": str(jobs.store.root / "cache/triton"),
                "CUDA_CACHE_PATH": str(jobs.store.root / "cache/cuda"),
                "VLLM_CACHE_ROOT": str(jobs.store.root / "cache/vllm"),
            }
        runtime = {
            "id": "managed-" + recipe_id[:32],
            "name": f"{recipe['engine']} {recipe['version']} · {recipe['backend']}",
            "engine": recipe["engine"],
            "version": recipe["version"],
            "execution_kind": "native",
            "executable": str(executable),
            "env": env,
            "trust": True,
            "command_template": [],
            "managed": {
                "root": str(root),
                "recipe_id": recipe_id,
                "backend": recipe["backend"],
            },
        }
        runtime["capabilities"] = await adapters.probe(runtime)
        return jobs.store.put("runtime", runtime)
    except BaseException:
        shutil.rmtree(root)
        raise


def remove(store, runtime):
    managed = runtime.get("managed")
    if not managed:
        raise ValueError("Only Menagerie-managed engine files can be removed")
    root = Path(managed["root"])
    expected = store.root / "engines" / managed["recipe_id"]
    if (
        root != expected
        or root.is_symlink()
        or root.resolve().parent != (store.root / "engines").resolve()
    ):
        raise ValueError("Engine installation path does not match its managed location")
    if any(
        r["id"] != runtime["id"]
        and Path(r["executable"]).resolve().is_relative_to(root.resolve())
        for r in store.list("runtime")
    ):
        raise ValueError("Another registered engine still uses this installation")
    if root.exists():
        shutil.rmtree(root)
