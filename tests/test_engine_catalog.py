from controlplane.engine_catalog import recommend


def test_artifact_specific_recommendations():
    assert (
        recommend({"format": "gguf", "name": "Ternary-Bonsai-2-27B-PTQ1_0.gguf"})[
            "engine"
        ]
        == "prism"
    )
    assert (
        recommend({"format": "gguf", "name": "model-PQ2_0.gguf"})["engine"] == "prism"
    )
    assert (
        recommend({"format": "gguf", "name": "model-Q4_K_M.gguf"})["engine"]
        == "llama.cpp"
    )
    assert recommend({"format": "safetensors"})["engine"] == "vllm"
    assert recommend({"format": "unknown"})["engine"] is None
    assert recommend({"format": "unknown"})["manual"]


def test_publisher_alone_does_not_force_fork():
    assert (
        recommend({"format": "gguf", "repo": "prism-ml/ordinary-model"})["engine"]
        == "llama.cpp"
    )
