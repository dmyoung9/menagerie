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

from . import adapters, engine_catalog, host
from .store import identity


def _fill(template, values):
    """Substitute declared placeholders without raising on a source typo."""
    return re.sub(
        r"\{(\w+)\}",
        lambda match: str(values.get(match.group(1), match.group(0))),
        template,
    )


def repository_url(repository):
    """Turn a GitHub owner/repo slug into the provenance URL we record."""
    if not repository or "://" in repository:
        return repository
    return "https://github.com/" + repository


def release_recipes(source, releases, machine, system="Linux"):
    """Select concrete assets for a source; never the moving GitHub /latest URL.

    ``source`` is a declared source dictionary or its id, so upstream and fork
    builds share one selection path. Patterns match the exact release tag, and
    a build whose required runtime companion is absent is not offered.
    """
    if isinstance(source, str):
        source = engine_catalog.source(source)
    arch = engine_catalog.ARCHITECTURES.get((machine or "").lower())
    if not source or source.get("install") != "release" or not arch:
        return []
    target = source["systems"].get(system) or {}
    if arch not in target.get("arches", list(engine_catalog.ARCHITECTURES.values())):
        return []
    tags = re.compile(source.get("tags") or r".+")
    recipes = {}
    order = {}
    for release in releases:
        tag = release.get("tag_name", "")
        if release.get("draft") or not tags.fullmatch(tag):
            continue
        if release.get("prerelease") and not source.get("prerelease"):
            continue
        assets = release.get("assets", [])
        for spec in target.get("assets", []):
            backend = spec["backend"]
            if backend in recipes:
                continue
            pattern = re.compile(
                spec["pattern"]
                .replace("{tag}", re.escape(tag))
                .replace("{arch}", re.escape(arch))
            )
            matched = None
            for asset in assets:
                match = pattern.fullmatch(asset["name"])
                if match:
                    matched = asset, match
                    break
            if matched is None:
                continue
            chosen, match = matched
            selected = [chosen]
            if spec.get("companion"):
                wanted = _fill(
                    spec["companion"],
                    {
                        "name": chosen["name"],
                        "tag": tag,
                        "arch": arch,
                        **match.groupdict(),
                    },
                )
                companion = next((a for a in assets if a["name"] == wanted), None)
                if not companion:
                    continue
                selected.append(companion)
            if any(
                not re.fullmatch(r"sha256:[0-9a-f]{64}", a.get("digest") or "")
                for a in selected
            ):
                continue
            cuda = match.groupdict().get("cuda")
            if backend == "cuda":
                requirements = (
                    f"{system}; CUDA {cuda} runtime; NVIDIA driver compatible "
                    "with it; installed executable probe required"
                    if cuda
                    else f"{system}; NVIDIA driver compatible with the selected "
                    "CUDA build; installed executable probe required"
                )
            else:
                requirements = f"{system} CPU"
            recipes[backend] = {
                "engine": source["protocol"],
                "source": source["id"],
                "source_name": source["name"],
                "repository": source.get("repository"),
                "version": tag,
                "backend": backend,
                "kind": "archive",
                "system": system,
                "archive_format": target["archive_format"],
                "assets": [
                    {
                        "url": a["browser_download_url"],
                        "sha256": a["digest"][7:],
                        "size": a["size"],
                    }
                    for a in selected
                ],
                "requirements": requirements,
            }
            # Present builds in the order upstream published them.
            order[backend] = assets.index(chosen)
    return [recipes[backend] for backend in sorted(recipes, key=order.get)]


async def catalog(client, store):
    system = platform.system()
    if system not in {"Linux", "Windows"}:
        return {
            "engines": [],
            "note": "Managed engines support Linux and Windows x64. Register an existing engine on other platforms.",
        }

    async def discover(item):
        try:
            if item.get("install") == "pypi":
                response = await client.get(
                    "https://pypi.org/pypi/"
                    + item.get("package", item["id"])
                    + "/json",
                    timeout=30,
                )
                response.raise_for_status()
                version = response.json()["info"]["version"]
                if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.post\d+)?", version):
                    raise ValueError("No stable vLLM release found")
                recipes = [
                    {
                        "engine": item["protocol"],
                        "source": item["id"],
                        "source_name": item["name"],
                        "repository": item.get("repository"),
                        "version": version,
                        "backend": "cuda",
                        "kind": "venv",
                        "requirements": "Linux NVIDIA GPU; compatible driver and Python wheel. Isolated environment; several GB download.",
                    }
                ]
            else:
                response = await client.get(
                    f"https://api.github.com/repos/{item['repository']}/releases",
                    params={"per_page": 10},
                    timeout=30,
                )
                response.raise_for_status()
                recipes = release_recipes(
                    item, response.json(), platform.machine(), system
                )
            for recipe in recipes:
                recipe["id"] = identity(recipe)
                store.put("engine_recipe", recipe, historical=False)
            return {
                "id": item["id"],
                "name": item["name"],
                "description": item["description"],
                "protocol": item["protocol"],
                "repository": item.get("repository"),
                "releases": recipes,
                "note": ""
                if recipes
                else "No matching checksummed binary found for this platform.",
            }
        except (ValueError, KeyError, OSError) as exc:
            return _unavailable(item, str(exc))
        except Exception as exc:
            # One unavailable supplier must not hide the other engines.
            return _unavailable(item, f"Release discovery failed: {exc}")

    supported = [item for item in engine_catalog.SOURCES if system in item["systems"]]
    return {"engines": await asyncio.gather(*(discover(e) for e in supported))}


def _unavailable(item, note):
    return {
        "id": item["id"],
        "name": item["name"],
        "description": item["description"],
        "protocol": item["protocol"],
        "repository": item.get("repository"),
        "releases": [],
        "note": note,
    }


def unpack(archive, destination):
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as bundle:
            members = bundle.infolist()
            if sum(m.file_size for m in members) > 12 * 1024**3 or len(members) > 20000:
                raise ValueError("Engine archive exceeds extraction limits")
            seen = set()
            for member in members:
                # ZipInfo.filename is normalized/truncated by Python on some
                # hosts. Validate the original archive spelling, including NULs.
                name = member.orig_filename
                parts = PurePosixPath(name).parts
                if (
                    not parts
                    or name.startswith("/")
                    or "\\" in name
                    or re.search(r'[\x00-\x1f<>"|?*]', name)
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
                key = "/".join(parts).casefold()
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
            "name": f"{recipe.get('source_name') or recipe['engine']} {recipe['version']} · {recipe['backend']}",
            "engine": recipe["engine"],
            "version": recipe["version"],
            "fork_url": repository_url(recipe.get("repository")),
            "execution_kind": "native",
            "executable": str(executable),
            "env": env,
            "trust": True,
            "command_template": [],
            "managed": {
                "root": str(root),
                "recipe_id": recipe_id,
                "source": recipe.get("source") or recipe["engine"],
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
