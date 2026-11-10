from controlplane.engine_catalog import recommend, sources


def test_artifact_specific_recommendations():
    assert (
        recommend({"format": "gguf", "name": "Ternary-Bonsai-2-27B-PTQ1_0.gguf"})[
            "engine"
        ]
        == "llama.cpp"
    )
    assert (
        recommend({"format": "gguf", "name": "model-PQ2_0.gguf"})["engine"]
        == "llama.cpp"
    )
    assert (
        recommend({"format": "gguf", "name": "model-Q4_K_M.gguf"})["engine"]
        == "llama.cpp"
    )
    assert recommend({"format": "safetensors"})["engine"] == "vllm"
    assert recommend({"format": "unknown"})["engine"] is None
    assert recommend({"format": "unknown"})["manual"]


def test_ternary_artifacts_point_at_the_prism_source_under_one_protocol():
    hint = recommend({"format": "gguf", "name": "Ternary-Bonsai-2-27B-PQ2_0.gguf"})
    assert hint["engine"] == "llama.cpp"
    assert hint["source"] == "prism"
    assert "source" not in recommend({"format": "gguf", "name": "model-Q4_K_M.gguf"})


def test_publisher_alone_does_not_force_fork():
    hint = recommend({"format": "gguf", "repo": "prism-ml/ordinary-model"})
    assert hint["engine"] == "llama.cpp"
    assert "source" not in hint


def test_sources_share_protocols_and_declare_supported_systems():
    by_id = {source["id"]: source for source in sources()}
    assert by_id["prism"]["protocol"] == "llama.cpp"
    assert by_id["llama.cpp"]["repository"] == "ggml-org/llama.cpp"
    assert "vllm" not in {source["id"] for source in sources("Windows")}
