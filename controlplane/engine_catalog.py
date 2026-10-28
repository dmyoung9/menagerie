"""Artifact-specific engine guidance. Recommendations are not compatibility proof."""

import re

ENGINES = [
    {
        "id": "llama.cpp",
        "name": "llama.cpp",
        "description": "GGUF inference on CPU and GPU",
        "repository": "ggml-org/llama.cpp",
    },
    {
        "id": "vllm",
        "name": "vLLM",
        "description": "GPU serving for supported safetensors architectures and quantizations",
        "repository": "vllm-project/vllm",
    },
    {
        "id": "prism",
        "name": "llama.cpp · Prism",
        "description": "Prism's llama.cpp build for supported ternary Bonsai artifacts",
        "repository": "PrismML-Eng/llama.cpp",
    },
]


def recommend(artifact):
    names = " ".join(str(artifact.get(k, "")) for k in ("name", "repo", "local_path"))
    format = artifact.get("format", "unknown").lower()
    # A format alone cannot prove architecture/backend compatibility. These are
    # recommendations; unrecognized artifacts retain manual engine selection.
    if format == "gguf" and (
        re.search(r"(?:PTQ1_0|PQ2_0)", names, re.I)
        or re.search(r"ternary[-_ ]bonsai", names, re.I)
    ):
        return {
            "engine": "prism",
            "reason": "This ternary artifact needs specialized kernels; use the Prism build rather than stock llama.cpp.",
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
