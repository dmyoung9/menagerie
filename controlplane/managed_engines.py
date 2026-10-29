"""Versioned user-space engine installs from upstream release assets."""

import asyncio
import contextlib
import hashlib
import platform
import re
import shutil
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

from . import adapters, host
from .engine_catalog import ENGINES
from .store import identity


def release_recipes(engine, releases, machine, system="Linux"):
    """Select concrete assets, never the moving GitHub /latest download URL."""
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine.lower())
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
            if system == "Windows":
                # CUDA 12.4 builds do not establish Blackwell support. Select
                # a modern toolkit build and still require a driver/probe check.
                match = re.fullmatch(
                    rf"llama-{re.escape(tag)}-bin-win-(cpu|cuda-(?:12\.8|13\.\d+))-{arch}\.zip",
                    name,
                )
                if not match or arch != "x64":
                    continue
                backend = "cpu" if match[1] == "cpu" else "cuda"
            elif system == "Linux":
                if not name.startswith("llama-") or not name.endswith(
                    f"-{arch}.tar.gz"
                ):
                    continue
                if "-cuda-12.8-" in name and "-bin-ubuntu-" in name:
                    backend = "cuda"
                elif re.search(rf"-bin-(?:ubuntu|linux)-{arch}\.tar\.gz$", name):
                    backend = "cpu"
                else:
                    continue
            else:
                continue
            if backend in recipes:
                continue
            selected = [asset]
            if engine == "llama.cpp" and backend == "cuda":
                companion_name = (
                    "cudart-" + name.replace(f"-{tag}-", "-")
                    if system == "Windows"
                    else "cudart-" + name
                )
                companion = next(
                    (a for a in assets if a["name"] == companion_name), None
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
                "system": system,
                "archive_format": "zip" if system == "Windows" else "tar.gz",
                "assets": [
                    {
                        "url": a["browser_download_url"],
                        "sha256": a["digest"][7:],
                        "size": a["size"],
                    }
                    for a in selected
                ],
                "requirements": f"{system}; NVIDIA driver compatible with the selected CUDA build; installed executable probe required"
                if backend == "cuda"
                else f"{system} CPU",
            }
    return list(recipes.values())


async def catalog(client, store):
    system = platform.system()
    if system not in {"Linux", "Windows"}:
        return {
            "engines": [],
            "note": "Managed engines support Linux and Windows x64. Register an existing engine on other platforms.",
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
                    engine["id"], response.json(), platform.machine(), system
                )
            for recipe in recipes:
                recipe["repository"] = engine["repository"]
                recipe["id"] = identity(recipe)
                store.put("engine_recipe", recipe, historical=False)
            return engine | {
                "releases": recipes,
                "note": ""
                if recipes
                else "No matching checksummed binary found for this platform.",
            }
        except (ValueError, KeyError, OSError) as exc:
            return engine | {"releases": [], "note": str(exc)}
        except Exception as exc:
            # One unavailable supplier must not hide the other engines.
            return engine | {"releases": [], "note": f"Release discovery failed: {exc}"}

    supported = [e for e in ENGINES if system == "Linux" or e["id"] == "llama.cpp"]
    return {"engines": await asyncio.gather(*(discover(e) for e in supported))}


def unpack(archive, destination):
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as bundle:
            members = bundle.infolist()
            if sum(m.file_size for m in members) > 12 * 1024**3 or len(members) > 20000:
                raise ValueError("Engine archive exceeds extraction limits")
            seen = set()
            for member in members:
                name = member.filename
                parts = PurePosixPath(name).parts
                if (
                    not parts
                    or name.startswith("/")
                    or "\\" in name
                    or any(
                        p in {".", ".."}
                        or ":" in p
                        or p.endswith((" ", "."))
                        or re.fullmatch(
                            r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", p, re.I
                        )
                        for p in parts
                    )
                    or (member.external_attr >> 16) & 0o170000 == 0o120000
                ):
                    raise ValueError("Unsafe Windows engine archive member")
                key = name.rstrip("/").casefold()
                target = destination.joinpath(*parts)
                if key in seen or (
                    target.exists() and not (member.is_dir() and target.is_dir())
                ):
                    raise ValueError("Engine archive contains colliding paths")
                seen.add(key)
            bundle.extractall(destination)
        return
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if sum(m.size for m in members) > 12 * 1024**3:
            raise ValueError("Engine archive exceeds the 12 GiB extraction limit")
        # data_filter rejects escapes, special files and links outside destination.
        bundle.extractall(destination, members=members, filter="data")


async def install(jobs, ident, recipe_id):
    recipe = jobs.store.get("engine_recipe", recipe_id)
    if recipe.get("system", "Linux") != platform.system():
        raise ValueError(
            "Engine recipe targets a different operating system; refresh the engine catalog"
        )
    root = jobs.store.root / "engines" / recipe_id
    root.parent.mkdir(parents=True, exist_ok=True)
    install_lock = host.lock_file(root.parent / (recipe_id + ".lock"))
    pending = root / ".menagerie-install"
    fingerprint = identity({k: v for k, v in recipe.items() if k != "revision"})
    try:
        # Only a provably incomplete, unregistered install may be retried in
        # place. Completed installations and unfamiliar directories are retained.
        if (
            root.is_dir()
            and not root.is_symlink()
            and pending.is_file()
            and pending.read_text(encoding="utf-8") == fingerprint
            and not any(
                r.get("managed", {}).get("root") == str(root)
                for r in jobs.store.list("runtime")
            )
        ):
            shutil.rmtree(root)
        root.mkdir()
    except BaseException:
        install_lock.close()
        raise
    try:
        pending.write_text(fingerprint, encoding="utf-8")
        if recipe["kind"] == "archive":
            for index, asset in enumerate(recipe["assets"]):
                archive = (
                    root / f"download-{index}.{recipe.get('archive_format', 'tar.gz')}"
                )
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
            windows = platform.system() == "Windows"
            binaries = list(
                root.rglob("llama-server.exe" if windows else "llama-server")
            )
            if len(binaries) != 1:
                raise ValueError("Release must contain exactly one llama-server")
            executable = binaries[0]
            if not windows:
                executable.chmod(executable.stat().st_mode | 0o100)
            libraries = sorted(
                {str(p.parent) for p in root.rglob("*.so*") if p.is_file()}
            )
            env = (
                {"LD_LIBRARY_PATH": ":".join(libraries)}
                if libraries and not windows
                else {}
            )
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
                "dll_dirs": sorted({str(p.parent) for p in root.rglob("*.dll")})
                if platform.system() == "Windows"
                else [],
            },
        }
        runtime["capabilities"] = await adapters.probe(runtime)
        saved = jobs.store.put("runtime", runtime)
        with contextlib.suppress(OSError):
            pending.unlink()
        return saved
    except BaseException:
        shutil.rmtree(root)
        raise
    finally:
        install_lock.close()


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
