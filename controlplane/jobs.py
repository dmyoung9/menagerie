"""Visible background work with pinned sources and explicit install plans."""

import asyncio
import io
import json
import re
import shutil
import time
from pathlib import Path
from urllib.parse import quote

import httpx
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from tqdm.auto import tqdm

from . import adapters
from .manager import redact
from .store import identity, uid

SPLIT_GGUF = re.compile(
    r"^(?P<stem>.+)-(?P<index>\d{5})-of-(?P<total>\d{5})\.gguf$", re.IGNORECASE
)


def selected_download(files, filename):
    """Resolve a GGUF selection to every shard required to load it."""
    match = SPLIT_GGUF.match(filename)
    if not match:
        file = next((f for f in files if f["name"] == filename), None)
        if not file:
            raise ValueError("Selected file is not present in the pinned revision")
        return [file]
    total = int(match.group("total"))
    if total < 1:
        raise ValueError("Invalid split GGUF shard count")
    shards = []
    for file in files:
        part = SPLIT_GGUF.match(file["name"])
        if (
            part
            and part.group("stem") == match.group("stem")
            and int(part.group("total")) == total
        ):
            shards.append(file)
    shards.sort(key=lambda f: int(SPLIT_GGUF.match(f["name"]).group("index")))
    indexes = [int(SPLIT_GGUF.match(f["name"]).group("index")) for f in shards]
    if indexes != list(range(1, total + 1)):
        raise ValueError(
            f"Split GGUF is incomplete upstream: found {len(shards)} of {total} shards"
        )
    return shards


class Jobs:
    def __init__(self, manager):
        self.manager = manager
        self.store = manager.store

    def submit(self, name, action):
        job = self.store.put(
            "job",
            {
                "id": uid(),
                "name": name,
                "state": "QUEUED",
                "created_at": time.time(),
                "progress": "Queued",
            },
        )

        async def run():
            current = job | {"state": "RUNNING"}
            self.store.put("job", current, historical=False)
            try:
                result = await action(job["id"])
                current.update(state="SUCCEEDED", result=result, progress="Complete")
            except asyncio.CancelledError:
                current.update(
                    state="FAILED", error="Daemon interrupted the job; retry explicitly"
                )
                raise
            except Exception as exc:
                current.update(state="FAILED", error=redact(str(exc)))
            finally:
                current["ended_at"] = time.time()
                self.store.put("job", current, historical=False)
                self.store.event("job", {"id": job["id"], "state": current["state"]})

        self.manager.spawn(run())
        return job

    def progress(self, ident, text):
        job = self.store.get("job", ident)
        job["progress"] = text
        self.store.put("job", job, historical=False)

    async def hf_search(self, query):
        def search():
            return [
                {"id": m.id, "downloads": m.downloads, "gated": m.gated, "tags": m.tags}
                for m in HfApi().list_models(search=query, limit=30, sort="downloads")
            ]

        try:
            return await asyncio.to_thread(search)
        except Exception as exc:
            raise ValueError(
                "Model catalog unavailable: " + redact(str(exc))[:500]
            ) from exc

    async def hf_files(self, repo, revision="main"):
        def inspect():
            info = HfApi().model_info(repo, revision=revision, files_metadata=True)
            return {
                "repo": repo,
                "revision": info.sha,
                "files": [
                    {
                        "name": f.rfilename,
                        "size": f.size,
                        "sha256": f.lfs.sha256 if f.lfs else None,
                    }
                    for f in info.siblings
                ],
            }

        try:
            result = await asyncio.to_thread(inspect)
            from .capabilities import inspect as inspect_capabilities

            small = {}
            warnings = []
            for filename, key in (
                ("config.json", "config"),
                ("tokenizer_config.json", "tokenizer_config"),
                ("chat_template.jinja", "chat_template"),
            ):
                file = next((f for f in result["files"] if f["name"] == filename), None)
                if not file or file.get("size") is None or file["size"] > 1024 * 1024:
                    continue
                try:
                    url = f"https://huggingface.co/{quote(repo, safe='/')}/resolve/{result['revision']}/{filename}"
                    async with self.manager.client.stream(
                        "GET", url, follow_redirects=True, timeout=10
                    ) as response:
                        response.raise_for_status()
                        raw = bytearray()
                        async for chunk in response.aiter_bytes():
                            raw.extend(chunk)
                            if len(raw) > 1024 * 1024:
                                raise ValueError("Metadata exceeds inspection limit")
                    value = raw.decode()
                    small[key] = value if key == "chat_template" else json.loads(value)
                    if key != "chat_template" and not isinstance(small[key], dict):
                        small[key] = {}
                except (ValueError, OSError, httpx.HTTPError):
                    warnings.append(f"Could not inspect {filename}")
            result["capabilities"] = inspect_capabilities(small)
            result["capabilities"]["dependencies"] = [
                {
                    "name": f["name"],
                    "size": f["size"],
                    "status": "candidate",
                    "kind": "projector",
                }
                for f in result["files"]
                if "mmproj" in f["name"].lower() and f["name"].lower().endswith(".gguf")
            ]
            result["capabilities"]["warnings"] = warnings
            return result
        except Exception as exc:
            raise ValueError(
                "Repository metadata unavailable: " + redact(str(exc))[:500]
            ) from exc

    async def hf_revisions(self, repo):
        def inspect():
            refs = HfApi().list_repo_refs(repo)
            return [
                {"name": ref.name, "revision": ref.target_commit, "kind": kind}
                for kind, rows in (("branch", refs.branches), ("tag", refs.tags))
                for ref in rows
            ]

        try:
            return await asyncio.to_thread(inspect)
        except Exception as exc:
            raise ValueError(
                "Repository revisions unavailable: " + redact(str(exc))[:500]
            ) from exc

    async def hf_quantizations(self, repo):
        def search():
            return [
                {"id": m.id, "downloads": m.downloads, "tags": m.tags}
                for m in HfApi().list_models(
                    filter="base_model:quantized:" + repo, limit=50, sort="downloads"
                )
            ]

        try:
            return await asyncio.to_thread(search)
        except Exception as exc:
            raise ValueError(
                "Quantization catalog unavailable: " + redact(str(exc))[:500]
            ) from exc

    async def download(self, ident, repo, revision, filename, projector=None):
        owner = self

        class Progress(tqdm):
            def __init__(self, *args, **kwargs):
                kwargs["file"] = io.StringIO()
                kwargs["disable"] = False
                self.last_report = 0
                super().__init__(*args, **kwargs)

            def update(self, n=1):
                result = super().update(n)
                if time.monotonic() - self.last_report > 1:
                    owner.progress(
                        ident,
                        f"{self.desc or 'Downloading'}: {self.n:,} / {self.total or '?'} {self.unit}",
                    )
                    self.last_report = time.monotonic()
                return result

        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise ValueError("Select a resolved 40-character model revision")
        metadata = await self.hf_files(repo, revision)
        companion = None
        if projector:
            companion = next(
                (
                    f
                    for f in metadata["files"]
                    if f["name"] == projector
                    and "mmproj" in f["name"].lower()
                    and f["name"].lower().endswith(".gguf")
                ),
                None,
            )
            if (
                not companion
                or not companion.get("size")
                or projector == filename
                or filename == "__safetensors__"
            ):
                raise ValueError(
                    "Choose a distinct GGUF projector from the pinned repository"
                )

        async def attach_projector(artifact):
            if companion:
                self.progress(ident, f"Downloading selected projector: {projector}")
                path = await asyncio.to_thread(
                    hf_hub_download,
                    repo_id=repo,
                    filename=projector,
                    revision=revision,
                    cache_dir=str(destination / "hf"),
                    tqdm_class=Progress,
                )
                digest = await asyncio.to_thread(adapters.file_hash, path)
                if companion["sha256"] and digest != companion["sha256"]:
                    raise ValueError("Projector checksum mismatch")
                artifact["metadata"]["projector"] = {
                    "name": projector,
                    "path": str(path),
                    "sha256": digest,
                    "size": companion["size"],
                }
            return self.store.put("artifact", artifact)

        if filename == "__safetensors__":
            allowed = (".safetensors", ".json", ".model", ".tiktoken", ".txt", ".jinja")
            files = [f for f in metadata["files"] if f["name"].endswith(allowed)]
            if not any(f["name"].endswith(".safetensors") for f in files) or any(
                f["size"] is None for f in files
            ):
                raise ValueError(
                    "A safetensors snapshot with known file sizes is required"
                )
            size = sum(f["size"] for f in files)
            destination = self.store.root / "models"
            destination.mkdir(exist_ok=True)
            if shutil.disk_usage(destination).free < size + 1024**3:
                raise ValueError("Insufficient disk capacity for repository snapshot")
            self.progress(
                ident,
                f"Downloading {len(files)} files · {size:,} bytes; no repository Python code",
            )
            path = await asyncio.to_thread(
                snapshot_download,
                repo_id=repo,
                revision=revision,
                allow_patterns=[f["name"] for f in files],
                cache_dir=str(destination / "hf"),
                tqdm_class=Progress,
            )
            self.progress(ident, "Verifying repository file checksums")
            artifact = await asyncio.to_thread(adapters.inspect_artifact, path, True)
            for file in files:
                if (
                    file["sha256"]
                    and artifact["metadata"]["file_sha256"].get(file["name"])
                    != file["sha256"]
                ):
                    raise ValueError(f"Checksum mismatch: {file['name']}")
            artifact.update(
                id="artifact-" + artifact["sha256"][:20],
                name=repo,
                source="huggingface",
                repo=repo,
                source_revision=revision,
            )
            artifact["metadata"]["discovery"] = metadata.get("capabilities", {})
            return self.store.put("artifact", artifact)
        if not filename.lower().endswith(".gguf"):
            raise ValueError("Select a GGUF file or safetensors snapshot")
        shards = selected_download(metadata["files"], filename)
        if any(not f.get("size") for f in shards):
            raise ValueError("Download requires known file sizes")
        size = sum(f["size"] for f in shards)
        destination = self.store.root / "models"
        destination.mkdir(exist_ok=True)
        if (
            shutil.disk_usage(destination).free
            < size + (companion["size"] if companion else 0) + 1024**3
        ):
            raise ValueError("Insufficient disk capacity (1 GiB reserve required)")
        if len(shards) > 1:
            paths = []
            for position, shard in enumerate(shards, 1):
                self.progress(
                    ident,
                    f"Downloading {shard['name']} ({position}/{len(shards)}) · {shard['size']:,} bytes · resumes from HF cache",
                )
                paths.append(
                    await asyncio.to_thread(
                        hf_hub_download,
                        repo_id=repo,
                        filename=shard["name"],
                        revision=revision,
                        cache_dir=str(destination / "hf"),
                        tqdm_class=Progress,
                    )
                )
            self.progress(ident, f"Verifying checksums for {len(shards)} shards")
            digests = []
            for shard, path in zip(shards, paths):
                digest = await asyncio.to_thread(adapters.file_hash, path)
                if shard["sha256"] and digest != shard["sha256"]:
                    raise ValueError(
                        f"Downloaded checksum does not match repository metadata: {shard['name']}"
                    )
                digests.append(digest)
            artifact = await asyncio.to_thread(
                adapters.inspect_artifact, paths[0], False
            )
            artifact.update(
                id="artifact-" + digests[0][:20],
                name=SPLIT_GGUF.match(filename).group("stem").split("/")[-1],
                size_bytes=size,
                sha256=digests[0],
                source="huggingface",
                repo=repo,
                source_revision=revision,
            )
            artifact["metadata"]["shards"] = [
                {"name": f["name"], "path": str(p), "size": f["size"], "sha256": d}
                for f, p, d in zip(shards, paths, digests)
            ]
            artifact["metadata"]["discovery"] = metadata.get("capabilities", {})
            return await attach_projector(artifact)
        file = shards[0]
        self.progress(
            ident,
            f"Downloading {filename} · {file['size']:,} bytes · resumes from HF cache",
        )
        path = await asyncio.to_thread(
            hf_hub_download,
            repo_id=repo,
            filename=filename,
            revision=revision,
            cache_dir=str(destination / "hf"),
            tqdm_class=Progress,
        )
        self.progress(ident, "Verifying SHA-256 and reading metadata")
        artifact = await asyncio.to_thread(adapters.inspect_artifact, path, True)
        if file["sha256"] and artifact["sha256"] != file["sha256"]:
            raise ValueError("Downloaded checksum does not match repository metadata")
        artifact.update(
            id="artifact-" + artifact["sha256"][:20],
            source="huggingface",
            repo=repo,
            source_revision=revision,
        )
        artifact["metadata"]["discovery"] = metadata.get("capabilities", {})
        return await attach_projector(artifact)

    def install_plan(self, source):
        engine = source.get("engine")
        if engine not in {"llama.cpp", "prism"}:
            raise ValueError(
                "Native source builds currently support llama.cpp/Prism; register isolated vLLM/SGLang binaries or pinned OCI images"
            )
        url, commit = source.get("url", ""), source.get("commit", "")
        if not re.fullmatch(
            r"https://[A-Za-z0-9.-]+/[A-Za-z0-9_./-]+", url
        ) or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Supply an HTTPS repository and exact 40-character commit")
        root = (
            self.store.root
            / "runtimes"
            / (engine.replace(".", "-") + "-" + commit[:12])
        )
        commands = [
            [
                "git",
                "clone",
                "--no-checkout",
                "--filter=blob:none",
                "--",
                url,
                str(root),
            ],
            ["git", "-C", str(root), "checkout", "--detach", commit],
            [
                "cmake",
                "-S",
                str(root),
                "-B",
                str(root / "build"),
                "-DGGML_CUDA=ON",
                "-DLLAMA_CURL=OFF",
                "-DCMAKE_BUILD_TYPE=Release",
            ],
            [
                "cmake",
                "--build",
                str(root / "build"),
                "--target",
                "llama-server",
                "-j",
                "4",
            ],
        ]
        plan = {
            "engine": engine,
            "url": url,
            "commit": commit,
            "root": str(root),
            "commands": commands,
            "warning": "This executes third-party CMake/build code as your user. Review and trust the pinned source. No sudo or downloaded install scripts.",
        }
        return plan | {"token": identity(plan)}

    async def install(self, ident, source, token):
        plan = self.install_plan(source)
        if token != plan["token"]:
            raise ValueError("Installation plan changed")
        if Path(plan["root"]).exists():
            raise ValueError(
                "Installation directory exists; preserve it and register its binary or choose another version"
            )
        Path(plan["root"]).parent.mkdir(parents=True, exist_ok=True)
        for argv in plan["commands"]:
            self.progress(ident, " ".join(argv))
            output = await adapters.command(argv, timeout=3600)
            self.store.event(
                "install",
                {"job": ident, "command": argv, "output_tail": redact(output[-3000:])},
            )
        runtime = {
            "name": f"{plan['engine']} {plan['commit'][:12]}",
            "engine": plan["engine"],
            "execution_kind": "native",
            "executable": str(Path(plan["root"]) / "build/bin/llama-server"),
            "commit": plan["commit"],
            "fork_url": plan["url"],
            "env": {},
            "trust": True,
            "command_template": [],
        }
        runtime["capabilities"] = await adapters.probe(runtime)
        return self.store.put("runtime", runtime)
