"""Additive presentation contracts must not become saved engine configuration."""

from copy import deepcopy

import pytest
from pydantic import ValidationError

from controlplane import adapters
from controlplane.catalog import normalize
from controlplane.schema import Capability, Profile


@pytest.mark.parametrize(
    "config",
    [{}, {"ctx-size": 0, "parallel": -1}, {"temp": 0, "vendor-option": "custom"}],
)
def test_profile_round_trip_preserves_omission_and_engine_extensions(config):
    profile = Profile(
        name="Synthetic model",
        artifact_id="artifact",
        runtime_id="engine",
        config=config,
    )
    assert Profile.model_validate_json(profile.model_dump_json()).config == config


def test_schema_annotations_do_not_mutate_fields_or_seed_defaults():
    before = deepcopy(adapters.FIELDS)
    runtime = {"engine": "llama.cpp"}
    schema = adapters.option_schema(runtime, ["ctx-size", "parallel", "temp", "mmproj"])
    assert schema["ctx-size"]["presentation"]["automatic_value"] == 0
    assert schema["parallel"]["presentation"]["automatic_value"] == -1
    assert "automatic_value" not in schema["temp"]["presentation"]
    assert "default" not in schema["mmproj"]
    assert schema["temp"]["presentation"]["request_overridable"]
    assert schema["ctx-size"]["presentation"]["owner_by_mode"] == {
        "standalone": "runtime-process",
        "native-pool": "model-deployment",
    }
    assert adapters.FIELDS == before


def test_vllm_does_not_inherit_llama_automatic_or_pool_semantics():
    schema = adapters.option_schema({"engine": "vllm"})
    field = schema["max-model-len"]["presentation"]
    assert field["owner_by_mode"] == {}
    assert "automatic_value" not in field
    assert field["inheritable"]


@pytest.mark.parametrize(
    "config", [{}, {"ctx-size": 0}, {"ctx-size": 32768, "parallel": -1}]
)
def test_automatic_sizing_never_becomes_zero_or_negative_client_capacity(config):
    profile = {"name": "Synthetic", "config": config, "catalog": {}}
    before = deepcopy(profile)
    result = normalize(profile)
    assert result["model"]["limit"]["context"] > 0
    assert result["model"]["limit"]["output"] > 0
    assert profile == before


def test_capabilities_preserve_unknown_and_conflicting_evidence():
    assert Capability[bool]().status == "unknown"
    finding = Capability[bool](
        status="unknown",
        evidence=[
            {
                "source": "artifact",
                "detail": "Image architecture",
                "confidence": "high",
            },
            {"source": "runtime", "detail": "Missing projector", "confidence": "high"},
        ],
    )
    assert (
        len(Capability[bool].model_validate_json(finding.model_dump_json()).evidence)
        == 2
    )
    with pytest.raises(ValidationError):
        Capability[bool](status="probably")
