"""Installable engine sources and artifact-specific guidance.

``protocol`` is the adapter family Menagerie drives. A supplier or fork is
installation provenance: it ships the same protocol from a different
repository with different asset names, so it never becomes a separate engine
family. Asset patterns are matched against exact release tags; a build without
its required runtime companion is never offered. Recommendations are not
compatibility proof.
"""

import re

ARCHITECTURES = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}

SOURCES = [
    {
        "id": "vllm",
        "name": "vLLM",
        "description": "GPU serving for supported safetensors architectures and quantizations",
        "protocol": "vllm",
        "repository": "vllm-project/vllm",
        "install": "pypi",
        "package": "vllm",
        "systems": {"Linux": {}},
    },
    {
        "id": "llama.cpp",
        "name": "llama.cpp",
        "description": "GGUF inference on CPU and GPU",
        "protocol": "llama.cpp",
        "repository": "ggml-org/llama.cpp",
        "install": "release",
        "tags": r"b\d+",
        # llama.cpp publishes its numbered builds as GitHub prereleases.
        "prerelease": True,
        "systems": {
            "Linux": {
                "archive_format": "tar.gz",
                "assets": [
                    {
                        "pattern": r"llama-{tag}-bin-ubuntu-cuda-12\.8-{arch}\.tar\.gz",
                        "backend": "cuda",
                        "companion": r"cudart-{name}",
                    },
                    {
                        "pattern": r"llama-{tag}-bin-(?:ubuntu|linux)-{arch}\.tar\.gz",
                        "backend": "cpu",
                    },
                ],
            },
            "Windows": {
                "archive_format": "zip",
                "arches": ["x64"],
                "assets": [
                    {
                        "pattern": r"llama-{tag}-bin-win-cuda-(?P<cuda>12\.8|13\.\d+)-{arch}\.zip",
                        "backend": "cuda",
                        "companion": r"cudart-llama-bin-win-cuda-{cuda}-{arch}.zip",
                    },
                    {
                        "pattern": r"llama-{tag}-bin-win-cpu-{arch}\.zip",
                        "backend": "cpu",
                    },
                ],
            },
        },
    },
    {
        "id": "prism",
        "name": "llama.cpp · Prism",
        "description": "Prism's llama.cpp builds: ternary Bonsai PQ2_0/PTQ1_0 support and tensor-core flash attention for quantized KV caches",
        "protocol": "llama.cpp",
        "repository": "PrismML-Eng/llama.cpp",
        "install": "release",
        "tags": r"prism-b\d+-[0-9a-f]+",
        "systems": {
            "Linux": {
                "archive_format": "tar.gz",
                "assets": [
                    # Prism links CUDA statically on Linux and publishes no
                    # separate cudart companion for it.
                    {
                        "pattern": r"llama-{tag}-bin-linux-cuda-(?P<cuda>12\.8)-{arch}\.tar\.gz",
                        "backend": "cuda",
                    },
                    {
                        "pattern": r"llama-{tag}-bin-ubuntu-{arch}\.tar\.gz",
                        "backend": "cpu",
                    },
                ],
            },
            "Windows": {
                "archive_format": "zip",
                "arches": ["x64"],
                "assets": [
                    {
                        "pattern": r"llama-{tag}-bin-win-cuda-(?P<cuda>12\.8|13\.\d+)-{arch}\.zip",
                        "backend": "cuda",
                        "companion": r"cudart-llama-bin-win-cuda-{cuda}-{arch}.zip",
                    },
                    {
                        "pattern": r"llama-{tag}-bin-win-cpu-{arch}\.zip",
                        "backend": "cpu",
                    },
                ],
            },
        },
    },
]

TERNARY = re.compile(r"(?:PTQ1_0|PQ2_0)|ternary[-_ ]bonsai", re.I)


def source(ident):
    """Return a declared source by id, or None."""
    return next((s for s in SOURCES if s["id"] == ident), None)


def sources(system=None):
    """Public source summaries; asset mechanics stay server-side."""
    return [
        {
            "id": item["id"],
            "name": item["name"],
            "description": item["description"],
            "protocol": item["protocol"],
            "repository": item.get("repository"),
        }
        for item in SOURCES
        if system is None or system in item["systems"]
    ]


def recommend(artifact):
    names = " ".join(str(artifact.get(k, "")) for k in ("name", "repo", "local_path"))
    format = artifact.get("format", "unknown").lower()
    # A format alone cannot prove architecture/backend compatibility. These are
    # recommendations; unrecognized artifacts retain manual engine selection.
    if format == "gguf" and TERNARY.search(names):
        return {
            "engine": "llama.cpp",
            "source": "prism",
            "reason": "Ternary artifacts such as PQ2_0 and PTQ1_0 rely on folding and kernels that a stock llama.cpp build may not carry. Prism's builds are the installable source; architecture and version support still require verification.",
            "manual": True,
        }
    if format == "gguf":
        return {
            "engine": "llama.cpp",
            "reason": "Recommended for GGUF. Architecture and tensor support depend on the installed engine version.",
            "manual": True,
        }
    if format == "safetensors":
        return {
            "engine": "vllm",
            "reason": "Recommended for supported safetensors models. Check architecture, quantization, and GPU compatibility.",
            "manual": True,
        }
    return {
        "engine": None,
        "reason": "Engine could not be identified. Choose an engine manually.",
        "manual": True,
    }
