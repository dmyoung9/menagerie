import pytest
from test_resources import fixture

from controlplane.adapters import validate_profile
from controlplane.resources import estimate, validate_budget


def test_known_invalid_combinations_and_manual_unknown_engine():
    runtime = {
        "engine": "llama.cpp",
        "execution_kind": "native",
        "capabilities": {
            "formats": ["gguf"],
            "flags": [
                "ctx-size",
                "parallel",
                "batch-size",
                "ubatch-size",
                "gpu-layers",
                "cache-type-v",
                "flash-attn",
            ],
        },
    }
    artifact = {
        "format": "gguf",
        "architecture": "llama",
        "local_path": "/small.gguf",
        "metadata": {"llama.context_length": 128, "llama.block_count": 6},
    }
    profile = {
        "config": {"ctx-size": 128, "parallel": 1, "gpu-layers": "0"},
        "raw_args": [],
    }
    assert not validate_profile(profile, artifact, runtime)
    assert any(
        "context limit" in e
        for e in validate_profile(
            profile | {"config": {"ctx-size": 256}}, artifact, runtime
        )
    )
    assert any(
        "layer count" in e
        for e in validate_profile(
            profile | {"config": {"gpu-layers": "7"}}, artifact, runtime
        )
    )
    assert any(
        "batch size" in e
        for e in validate_profile(
            profile | {"config": {"batch-size": 32, "ubatch-size": 64}},
            artifact,
            runtime,
        )
    )
    assert any(
        "flash attention" in e
        for e in validate_profile(
            profile | {"config": {"flash-attn": "off", "cache-type-v": "q8_0"}},
            artifact,
            runtime,
        )
    )
    assert not validate_profile(profile, artifact | {"format": "unknown"}, runtime)
    assert any(
        "typed configuration" in e
        for e in validate_profile(
            profile | {"raw_args": ["--ctx-size=100000"]}, artifact, runtime
        )
    )


def test_offload_is_explicit_and_ram_budget_is_enforced(tmp_path):
    _, manager, draft = fixture(tmp_path)
    artifact = manager.store.get("artifact", "weights")
    config = draft["configuration"]["config"]
    gpu = estimate(artifact, config)
    cpu = estimate(artifact, config | {"gpu-layers": "0"})
    assert gpu["ram_mib"] == 0 and gpu["peak_mib"] > 0
    assert cpu["peak_mib"] == 0 and cpu["ram_mib"] > artifact["size_bytes"] / 1048576
    draft["configuration"]["config"]["gpu-layers"] = "0"
    manager.host["ram_available_mib"] = 5000
    with pytest.raises(ValueError, match="system memory"):
        validate_budget(manager, [draft])


def test_budget_rejection_preserves_selected_settings(tmp_path):
    from copy import deepcopy

    _, manager, draft = fixture(tmp_path)
    draft["configuration"]["config"]["ctx-size"] = 1048576
    before = deepcopy(draft)
    with pytest.raises(ValueError, match="memory budget"):
        validate_budget(manager, [draft])
    assert draft == before
