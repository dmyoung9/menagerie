"""Artifact-specific engine guidance. Recommendations are not compatibility proof."""

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
]


def recommend(artifact):
    format = artifact.get("format", "unknown").lower()
    # A format alone cannot prove architecture/backend compatibility. These are
    # recommendations; unrecognized artifacts retain manual engine selection.
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
