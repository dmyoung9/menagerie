"""First-class chat templates; no live runtime or installed service required."""

from pathlib import Path

import httpx

from controlplane import templates
from controlplane.api import create_app
from controlplane.store import Store

# ---------------------------------------------------------------------------
# Discovery helpers
# ---------------------------------------------------------------------------


def test_is_template_file():
    assert templates.is_template_file("chat_template.jinja")
    assert templates.is_template_file("chat.template.JINJA")
    assert not templates.is_template_file("tokenizer.json")
    assert not templates.is_template_file("")


def test_extract_template_files_ignores_non_templates_and_dirs():
    files = [
        {"name": "chat_template.jinja"},
        {"name": "chat.template.JINJA"},
        {"name": "tokenizer.json"},
        {"name": "models/"},
        {"name": "subdir/chat_template.jinja", "size": 1},
        {"name": "chat_template.txt"},
        {"name": "chat_template.jinja.bak"},
    ]
    assert templates.extract_template_files(files) == [
        "chat_template.jinja",
        "subdir/chat_template.jinja",
    ]


def test_extract_template_files_honors_chat_templates_dir():
    files = [
        {"name": "chat_templates/custom.jinja"},
        {"name": "CHAT_TEMPLATES/other.jinja"},
        {"name": "chat_template.jinja"},
        {"name": "chat_templates/readme"},
    ]
    assert templates.extract_template_files(files) == [
        "chat_templates/custom.jinja",
        "CHAT_TEMPLATES/other.jinja",
        "chat_template.jinja",
    ]


def test_template_name_labels():
    assert templates.template_name("chat_template.jinja") == "chat_template"
    assert templates.template_name("chat_templates/custom.jinja") == "custom.jinja"
    assert templates.template_name("CHAT_TEMPLATES/other.jinja") == "other.jinja"
    assert templates.template_name("") == "chat template"


def test_sha256_text_is_stable_and_unique():
    a = templates.sha256_text("x")
    assert templates.sha256_text("x") == a
    assert templates.sha256_text("x") != templates.sha256_text("y")
    assert len(a) == 64


# ---------------------------------------------------------------------------
# Embedded extraction
# ---------------------------------------------------------------------------


def test_template_from_gguf_reads_embedded_string():
    meta = {"tokenizer.chat_template": " {{ prompt }}"}
    asset = templates.template_from_gguf(meta, "/models/a.gguf")
    assert asset["kind"] == "embedded"
    assert asset["name"] == "embedded"
    assert asset["file_path"] == "/models/a.gguf"
    assert asset["content"] == " {{ prompt }}"
    assert asset["status"] == "available"
    assert asset["relative_path"] is None
    assert asset["size_bytes"] == len(" {{ prompt }}".encode("utf-8"))


def test_template_from_gguf_rejects_empty_and_non_string():
    assert templates.template_from_gguf({"tokenizer.chat_template": ""}, "/a") is None
    assert templates.template_from_gguf({}, "/a") is None
    assert templates.template_from_gguf({"tokenizer.chat_template": None}, "/a") is None


def test_template_from_tokenizer_config_reads_chat_template():
    meta = {"tokenizer_config": {"chat_template": "{{ prompt }}"}}
    asset = templates.template_from_tokenizer_config(meta)
    assert asset["kind"] == "embedded"
    assert asset["name"] == "tokenizer.chat_template"
    assert asset["file_path"] == "tokenizer_config.json"
    assert asset["relative_path"] == "tokenizer_config.json"
    assert templates.template_from_tokenizer_config({}) is None
    assert templates.template_from_tokenizer_config({"tokenizer_config": {}}) is None
    assert (
        templates.template_from_tokenizer_config(
            {"tokenizer_config": {"chat_template": ""}}
        )
        is None
    )


# ---------------------------------------------------------------------------
# Draft collection
# ---------------------------------------------------------------------------


def test_collect_drafts_gguf_embedded():
    artifact = {
        "id": "model",
        "format": "gguf",
        "local_path": "/models/a.gguf",
        "metadata": {"tokenizer.chat_template": " {{ prompt }}"},
    }
    drafts = templates.collect_template_drafts(artifact, None)
    assert len(drafts) == 1
    assert drafts[0]["kind"] == "embedded"
    assert drafts[0]["content"] == " {{ prompt }}"


def test_collect_drafts_safetensors_embedded():
    artifact = {
        "id": "model",
        "format": "safetensors",
        "metadata": {
            "tokenizer_config": {"chat_template": " {{ prompt }}"},
            "config": {},
        },
    }
    drafts = templates.collect_template_drafts(artifact, None)
    assert len(drafts) == 1
    assert drafts[0]["kind"] == "embedded"
    assert drafts[0]["name"] == "tokenizer.chat_template"


def test_collect_drafts_published_from_hf_listing():
    hf = {
        "repo": "org/repo",
        "revision": "abc",
        "files": [
            {"name": "chat_template.jinja"},
            {"name": "chat_templates/alt.jinja"},
            {"name": "model.safetensors"},
        ],
        "contents": {
            "chat_template.jinja": " {{ prompt }}",
            "chat_templates/alt.jinja": "{{ alt }}",
        },
    }
    artifact = {"id": "model", "format": "safetensors"}
    drafts = templates.collect_template_drafts(artifact, hf)
    assert len(drafts) == 2
    kinds = {d["kind"] for d in drafts}
    assert kinds == {"published"}
    by_name = {d["name"]: d for d in drafts}
    assert by_name["chat_template"]["repo"] == "org/repo"
    assert by_name["chat_template"]["revision"] == "abc"
    assert by_name["chat_template"]["status"] == "available"
    assert by_name["alt.jinja"]["file_path"] == "chat_templates/alt.jinja"


def test_collect_drafts_published_missing_content_is_marked_missing():
    hf = {
        "repo": "org/repo",
        "revision": "abc",
        "files": [{"name": "chat_template.jinja"}],
        "contents": {},
    }
    drafts = templates.collect_template_drafts({"id": "model"}, hf)
    assert drafts[0]["status"] == "missing"
    assert drafts[0]["content"] is None


def test_collect_drafts_rejects_oversized_content():
    hf = {
        "repo": "org/repo",
        "revision": "abc",
        "files": [{"name": "chat_template.jinja"}],
        "contents": {"chat_template.jinja": "x" * (templates.TEMPLATE_MAX_SIZE + 1)},
    }
    drafts = templates.collect_template_drafts({"id": "model"}, hf)
    assert drafts[0]["content"] is None
    assert drafts[0]["size_bytes"] is None
    assert drafts[0]["status"] == "missing"


# ---------------------------------------------------------------------------
# Asset creation
# ---------------------------------------------------------------------------


def test_create_template_assets_persists_and_dedupes(tmp_path):
    store = Store(tmp_path)
    drafts = [
        {
            "kind": "published",
            "name": "chat_template",
            "content": "a",
            "status": "available",
        },
        {
            "kind": "published",
            "name": "chat_template",
            "content": "a",
            "status": "available",
        },
        {
            "kind": "published",
            "name": "chat_template",
            "content": "b",
            "status": "available",
        },
    ]
    saved = templates.create_template_assets(store, "model", drafts)
    assert len(saved) == 2  # identical content is deduped
    rows = templates.list_template_assets(store, "model")
    assert {r["sha256"] for r in rows} == {
        templates.sha256_text("a"),
        templates.sha256_text("b"),
    }
    assert all(
        r["name"] == "chat_template"
        and r["artifact_id"] == "model"
        and r["sha256"] == templates.sha256_text(r["content"])
        for r in rows
    )
    for asset in saved:
        assert store.get("template", asset["id"])["sha256"] == asset["sha256"]


def _store(tmp_path):
    return Store(tmp_path)


def test_create_template_assets_dedupes_identical_content(tmp_path):
    store = _store(tmp_path)
    drafts = [
        {
            "kind": "published",
            "name": "chat_template",
            "content": "a",
            "status": "available",
        },
        {
            "kind": "published",
            "name": "chat_template",
            "content": "a",
            "status": "available",
        },
        {"kind": "published", "name": "alt", "content": "b", "status": "available"},
    ]
    saved = templates.create_template_assets(store, "model", drafts)
    assert len(saved) == 2
    names = {d["name"] for d in saved}
    assert names == {"chat_template", "alt"}
    # Both published assets are stored with correct sha.
    all_rows = templates.list_template_assets(store, "model")
    assert {r["sha256"] for r in all_rows} == {
        templates.sha256_text("a"),
        templates.sha256_text("b"),
    }
    assert all(r["artifact_id"] == "model" for r in all_rows)
    assert all(r["status"] == "available" for r in all_rows)


def test_create_template_assets_preserves_custom_on_refresh(tmp_path):
    store = _store(tmp_path)
    # A user-authored custom template must survive a re-collect of published drafts.
    store.put(
        "template",
        {
            "id": "custom-1",
            "kind": "custom",
            "artifact_id": "model",
            "name": "chat_template (custom)",
            "file_path": "/custom/jinja",
            "sha256": templates.sha256_text("CUSTOM"),
            "content": "CUSTOM",
            "size_bytes": 6,
            "status": "available",
            "error": None,
        },
    )
    drafts = [
        {
            "kind": "published",
            "name": "chat_template",
            "content": "a",
            "status": "available",
        }
    ]
    saved = templates.create_template_assets(store, "model", drafts)
    # Custom preserved, published added.
    ids = [r["id"] for r in saved]
    assert "custom-1" in ids
    assert any(r["kind"] == "published" for r in saved)


def test_persist_embedded_assets_creates_drafts_from_metadata(tmp_path):
    store = _store(tmp_path)
    artifact = {
        "id": "model",
        "format": "safetensors",
        "metadata": {"tokenizer_config": {"chat_template": " {{ p }}"}, "config": {}},
    }
    saved = templates.persist_embedded_assets(store, artifact)
    assert len(saved) == 1
    assert saved[0]["kind"] == "embedded"
    assert artifact["template_default"] == {"source": "automatic", "asset_id": None}
    assert len(templates.list_template_assets(store, "model")) == 1


# ---------------------------------------------------------------------------
# Effective selection
# ---------------------------------------------------------------------------


def _asset(store, kind="published", name="chat_template", content="x", **kw):
    asset = {
        "id": "a1",
        "kind": kind,
        "artifact_id": "model",
        "name": name,
        "sha256": templates.sha256_text(content),
        "content": content,
        "size_bytes": 0,
        "status": "available",
        "error": None,
        **kw,
    }
    store.put("template", asset)
    return asset


def test_effective_selection_prefers_override(tmp_path):
    store = _store(tmp_path)
    default = _asset(store, name="a")
    override = _asset(store, id="a2", name="b")
    artifact = {
        "id": "model",
        "template_default": {"source": "published", "asset_id": default["id"]},
    }
    deployment = {
        "id": "d1",
        "template_override": {"source": "published", "asset_id": override["id"]},
    }
    result = templates.effective_selection(deployment, artifact, store)
    assert result["source"] == "published"
    assert result["asset"]["name"] == "b"


def test_effective_selection_falls_back_to_model_default(tmp_path):
    store = _store(tmp_path)
    a = _asset(store, name="a")
    artifact = {
        "id": "model",
        "template_default": {"source": "published", "asset_id": a["id"]},
    }
    deployment = {"id": "d1", "template_override": None}
    result = templates.effective_selection(deployment, artifact, store)
    assert result["source"] == "published"
    assert result["asset"]["name"] == "a"


def test_effective_selection_defaults_to_engine_default(tmp_path):
    store = _store(tmp_path)
    artifact = {
        "id": "model",
        "template_default": {"source": "automatic", "asset_id": None},
    }
    deployment = {"id": "d1", "template_override": None}
    result = templates.effective_selection(deployment, artifact, store)
    assert result["source"] == "automatic"
    assert result["asset"] is None
    assert result["description"] == "No template (engine default)"


def test_effective_selection_reports_missing_asset(tmp_path):
    store = _store(tmp_path)
    artifact = {
        "id": "model",
        "template_default": {"source": "published", "asset_id": "missing"},
    }
    deployment = {"id": "d1"}
    result = templates.effective_selection(deployment, artifact, store)
    assert result["source"] == "published"
    assert result["asset"] is None
    assert result["description"] == "published template missing"


def test_effective_selection_ignores_stale_override_kind(tmp_path):
    store = _store(tmp_path)
    a = _asset(store, name="a")
    artifact = {
        "id": "model",
        "template_default": {"source": "published", "asset_id": a["id"]},
    }
    deployment = {
        "id": "d1",
        "template_override": {"source": "published", "asset_id": a["id"]},
    }
    result = templates.effective_selection(deployment, artifact, store)
    assert result["asset"]["name"] == "a"


# ---------------------------------------------------------------------------
# Flag support and conflict detection
# ---------------------------------------------------------------------------


def test_supports_template_flag_by_engine():
    llama = {"engine": "llama.cpp", "capabilities": {"flags": ["chat-template-file"]}}
    prism = {"engine": "prism", "capabilities": {"flags": ["chat-template-file"]}}
    vllm = {"engine": "vllm", "capabilities": {"flags": ["chat-template"]}}
    assert templates.supports_template_flag(llama)
    assert templates.supports_template_flag(prism)
    assert templates.supports_template_flag(vllm)
    assert not templates.supports_template_flag({"engine": "sglang"})
    assert not templates.supports_template_flag(
        {"engine": "llama.cpp", "capabilities": {"flags": ["ctx-size"]}}
    )


def test_template_flag_name_by_engine():
    assert templates.template_flag_name({"engine": "llama.cpp"}) == "chat-template-file"
    assert templates.template_flag_name({"engine": "prism"}) == "chat-template-file"
    assert templates.template_flag_name({"engine": "vllm"}) == "chat-template"


def test_detect_conflict_manual_flags():
    assert templates.detect_conflict({"config": {"chat-template-file": "/x"}})
    assert templates.detect_conflict({"raw_args": ["--chat-template-file /x"]})
    assert templates.detect_conflict({"raw_args": ["--chat-template-file=/x"]})
    assert templates.detect_conflict({"raw_args": ["--chat-template /x"]})
    assert templates.detect_conflict({"raw_args": ["--chat-template=/x"]})
    assert templates.detect_conflict({"config": {}, "raw_args": []}) is None
    assert (
        templates.detect_conflict({"raw_args": ["--chat-template-file=/x"]}) is not None
    )
    assert templates.detect_conflict({}) is None


# ---------------------------------------------------------------------------
# Custom template persistence and display truncation
# ---------------------------------------------------------------------------


def test_write_custom_template_creates_file(tmp_path):
    store = _store(tmp_path)
    path = templates.write_custom_template(store, "x {{ p }}")
    assert path.is_file()
    assert path.read_bytes() == b"x {{ p }}"
    assert path.suffix == ".jinja"
    assert path.is_relative_to(store.root)
    assert path.name != ""
    assert path.parent == store.root / "templates"


def test_truncate_for_display():
    assert templates.truncate_for_display("short") == "short"
    long = "x" * 5000
    out = templates.truncate_for_display(long, limit=40)
    assert out.startswith("x")
    assert out.endswith(" characters omitted")


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


async def _client(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    )


async def test_models_endpoint_exposes_content_stripped_templates(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put(
        "artifact",
        {
            "id": "model",
            "name": "M",
            "format": "safetensors",
            "template_default": {"source": "automatic", "asset_id": None},
        },
    )
    store.put(
        "template",
        {
            "id": "a1",
            "kind": "published",
            "artifact_id": "model",
            "name": "chat_template",
            "sha256": "sha",
            "content": "secret-content",
            "size_bytes": 0,
            "status": "available",
            "error": None,
        },
    )
    async with await _client(app) as client:
        models = (await client.get("/api/models")).json()
        model = next(m for m in models if m["id"] == "model")
        assert "templates" in model
        assert model["templates"][0]["name"] == "chat_template"
        assert "content" not in model["templates"][0]
        assert model["template_default"] == {"source": "automatic", "asset_id": None}
        templates_list = (await client.get("/api/models/model/templates")).json()
        assert templates_list[0]["name"] == "chat_template"
        assert "content" not in templates_list[0]
        assert (await client.get("/api/templates/a1")).json()[
            "content"
        ] == "secret-content"


async def test_set_model_default_automatic_and_specific(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "M", "format": "gguf"})
    a = _asset(store, name="a")
    other = _asset(store, id="a2", name="b", artifact_id="other")
    async with await _client(app) as client:
        headers = {
            "X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]
        }
        r = await client.post(
            "/api/models/model/template-default",
            json={"source": "automatic"},
            headers=headers,
        )
        assert r.status_code == 200, r.text
        assert store.get("artifact", "model")["template_default"] == {
            "source": "automatic",
            "asset_id": None,
        }
        r = await client.post(
            "/api/models/model/template-default",
            json={"source": "published", "asset_id": a["id"]},
            headers=headers,
        )
        assert r.status_code == 200, r.text
        assert store.get("artifact", "model")["template_default"] == {
            "source": "published",
            "asset_id": a["id"],
        }
        # Asset from a different artifact is rejected.
        r = await client.post(
            "/api/models/model/template-default",
            json={"source": "published", "asset_id": other["id"]},
            headers=headers,
        )
        assert r.status_code == 400
        assert "belong" in r.text or "missing" in r.text or r.status_code == 400
        # Invalid source rejected.
        r = await client.post(
            "/api/models/model/template-default",
            json={"source": "bogus"},
            headers=headers,
        )
        assert r.status_code == 400


async def test_set_model_default_requires_asset_id_for_named_source(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "M", "format": "gguf"})
    async with await _client(app) as client:
        headers = {
            "X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]
        }
        r = await client.post(
            "/api/models/model/template-default",
            json={"source": "custom"},
            headers=headers,
        )
        assert r.status_code == 400
        assert "asset" in r.text.lower()
        r = await client.post(
            "/api/models/model/template-default",
            json={"source": "custom", "asset_id": ""},
            headers=headers,
        )
        assert r.status_code == 400


async def test_create_and_update_custom_template(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "M", "format": "gguf"})
    async with await _client(app) as client:
        headers = {
            "X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]
        }
        r = await client.post(
            "/api/templates",
            json={"artifact_id": "model", "content": " {{ p }}"},
            headers=headers,
        )
        assert r.status_code == 200, r.text
        asset = r.json()
        assert asset["kind"] == "custom"
        assert asset["artifact_id"] == "model"
        assert asset["content"] == " {{ p }}"
        assert asset["sha256"] == templates.sha256_text(" {{ p }}")
        # Updating a custom template works.
        r2 = await client.put(
            f"/api/templates/{asset['id']}",
            json={"content": " changed"},
            headers=headers,
        )
        assert r2.status_code == 200
        assert r2.json()["content"] == " changed"
        assert r2.json()["sha256"] == templates.sha256_text(" changed")
        # Updating a published template is forbidden.
        pub = _asset(store, name="pub")
        r3 = await client.put(
            f"/api/templates/{pub['id']}", json={"content": "x"}, headers=headers
        )
        assert r3.status_code == 409


async def test_delete_custom_template_and_guard_non_custom(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "M", "format": "gguf"})
    async with await _client(app) as client:
        headers = {
            "X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]
        }
        r = await client.post(
            "/api/templates",
            json={"artifact_id": "model", "content": "{{ p }}"},
            headers=headers,
        )
        asset = r.json()
        path = Path(asset["file_path"])
        r2 = await client.post(f"/api/templates/{asset['id']}/delete", headers=headers)
        assert r2.status_code == 200
        assert r2.json()["disk_files_removed"] is True
        assert not path.exists()
        assert asset["id"] not in {t["id"] for t in store.list("template")}
        pub = _asset(store, name="pub")
        r3 = await client.post(f"/api/templates/{pub['id']}/delete", headers=headers)
        assert r3.status_code == 409


async def test_deployment_override_validation(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "M", "format": "gguf"})
    a = _asset(store, name="a")
    other = _asset(store, id="a2", name="b", artifact_id="other")
    store.put(
        "runtime",
        {
            "id": "r1",
            "name": "Engine",
            "engine": "llama.cpp",
            "execution_kind": "native",
            "executable": "/not/executed",
            "capabilities": {"formats": ["gguf"]},
        },
    )
    async with await _client(app) as client:
        headers = {
            "X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]
        }
        # Valid override accepted.
        r = await client.post(
            "/api/deployments",
            json={
                "name": "D",
                "profile_id": "p1",
                "alias": "d1",
                "port": 8120,
                "residency": "on-demand",
                "configuration": {
                    "id": "p1",
                    "name": "P",
                    "artifact_id": "model",
                    "runtime_id": "r1",
                    "config": {},
                    "raw_args": [],
                    "catalog": {"catalog_id": "c"},
                },
                "template_override": {"source": "published", "asset_id": a["id"]},
            },
            headers=headers,
        )
        assert r.status_code == 200, r.text
        stored = store.get("deployment", r.json()["id"])
        assert stored["template_override"] == {
            "source": "published",
            "asset_id": a["id"],
        }
        # Override from a different artifact rejected.
        r2 = await client.post(
            "/api/deployments",
            json={
                "name": "D2",
                "profile_id": "p1",
                "alias": "d2",
                "port": 8121,
                "residency": "on-demand",
                "configuration": {
                    "id": "p1",
                    "name": "P",
                    "artifact_id": "model",
                    "runtime_id": "r1",
                    "config": {},
                    "raw_args": [],
                    "catalog": {"catalog_id": "c"},
                },
                "template_override": {"source": "published", "asset_id": other["id"]},
            },
            headers=headers,
        )
        assert r2.status_code == 400
        # Invalid source rejected.
        r3 = await client.post(
            "/api/deployments",
            json={
                "name": "D3",
                "profile_id": "p1",
                "alias": "d3",
                "port": 8122,
                "residency": "on-demand",
                "configuration": {
                    "id": "p1",
                    "name": "P",
                    "artifact_id": "model",
                    "runtime_id": "r1",
                    "config": {},
                    "raw_args": [],
                    "catalog": {"catalog_id": "c"},
                },
                "template_override": {"source": "bogus", "asset_id": a["id"]},
            },
            headers=headers,
        )
        assert r3.status_code == 400
        # Missing asset rejected.
        r4 = await client.post(
            "/api/deployments",
            json={
                "name": "D4",
                "profile_id": "p1",
                "alias": "d4",
                "port": 8123,
                "residency": "on-demand",
                "configuration": {
                    "id": "p1",
                    "name": "P",
                    "artifact_id": "model",
                    "runtime_id": "r1",
                    "config": {},
                    "raw_args": [],
                    "catalog": {"catalog_id": "c"},
                },
                "template_override": {"source": "published", "asset_id": "none"},
            },
            headers=headers,
        )
        assert r4.status_code == 400
        # Override omitted => no override stored.
        r5 = await client.post(
            "/api/deployments",
            json={
                "name": "D5",
                "profile_id": "p1",
                "alias": "d5",
                "port": 8124,
                "residency": "on-demand",
                "configuration": {
                    "id": "p1",
                    "name": "P",
                    "artifact_id": "model",
                    "runtime_id": "r1",
                    "config": {},
                    "raw_args": [],
                    "catalog": {"catalog_id": "c"},
                },
            },
            headers=headers,
        )
        assert r5.status_code == 200
        stored5 = store.get("deployment", r5.json()["id"])
        assert stored5.get("template_override") is None


async def test_deployment_override_null_and_empty_source_rejected(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "M", "format": "gguf"})
    store.put(
        "runtime",
        {
            "id": "r1",
            "name": "Engine",
            "engine": "llama.cpp",
            "execution_kind": "native",
            "executable": "/not/executed",
            "capabilities": {"formats": ["gguf"]},
        },
    )
    a = _asset(store, name="a")
    async with await _client(app) as client:
        headers = {
            "X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]
        }
        r = await client.post(
            "/api/deployments",
            json={
                "name": "DN",
                "profile_id": "p1",
                "alias": "dn",
                "port": 8125,
                "residency": "on-demand",
                "configuration": {
                    "id": "p1",
                    "name": "P",
                    "artifact_id": "model",
                    "runtime_id": "r1",
                    "config": {},
                    "raw_args": [],
                    "catalog": {"catalog_id": "c"},
                },
                "template_override": {"source": "published", "asset_id": a["id"]},
            },
            headers=headers,
        )
        assert r.status_code == 200
        # Empty source rejected.
        r2 = await client.post(
            "/api/deployments",
            json={
                "name": "DE",
                "profile_id": "p1",
                "alias": "de",
                "port": 8126,
                "residency": "on-demand",
                "configuration": {
                    "id": "p1",
                    "name": "P",
                    "artifact_id": "model",
                    "runtime_id": "r1",
                    "config": {},
                    "raw_args": [],
                    "catalog": {"catalog_id": "c"},
                },
                "template_override": {"asset_id": a["id"]},
            },
            headers=headers,
        )
        assert r2.status_code == 400


async def test_refresh_templates_endpoint(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("artifact", {"id": "model", "name": "M", "format": "gguf"})
    store.put(
        "template",
        {
            "id": "a1",
            "kind": "published",
            "artifact_id": "model",
            "name": "a",
            "sha256": "x",
            "content": "x",
            "size_bytes": 0,
            "status": "available",
            "error": None,
        },
    )
    async with await _client(app) as client:
        headers = {
            "X-Menagerie-Token": (await client.get("/api/status")).json()["csrf_token"]
        }
        r = await client.post("/api/models/model/refresh-templates", headers=headers)
        assert r.status_code == 200, r.text
