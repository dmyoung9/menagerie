"""Contract tests for the deterministic API-identifier (alias) rules.

These are the executable specification for slug generation: normalization,
non-Latin/empty-slug fallback, length limits, and collision suffixing. The
same rules must hold for the stored value, the server-side suggest endpoint,
and any client-side preview.
"""

import hashlib
import re
import unicodedata

import httpx

from controlplane.api import create_app
from controlplane.slug import (
    BASE_MAX,
    MAX_ALIAS_LEN,
    is_valid_alias,
    resolve_alias,
    slug,
)

ALIAS_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,159}$")


# ---------------------------------------------------------------- slug -----


def test_slug_folds_case_and_spaces():
    assert slug("Example 8B") == "example-8b"
    assert slug("Writing  Assistant") == "writing-assistant"


def test_slug_treats_punctuation_and_separators_as_hyphens():
    assert slug("Writing- Assistant / Test") == "writing-assistant-test"
    assert slug("Model_8B--Q4") == "model-8b-q4"
    assert slug("Model  8B") == "model-8b"  # collapses double separator


def test_slug_preserves_digits():
    assert slug("8B Model") == "8b-model"
    assert slug("Llama-3-8B-Instruct") == "llama-3-8b-instruct"


def test_slug_uses_stable_nonlatin_fallback():
    name = "日本語モデル"
    expected = (
        "model-"
        + (hashlib.sha256(unicodedata.normalize("NFKC", name).encode()).hexdigest()[:8])
    )
    assert slug(name) == expected
    assert is_valid_alias(slug(name))


def test_slug_nonlatin_is_deterministic():
    # Never a random changing identifier: same name always yields the same slug.
    name = "中文模型 中文模型"
    for _ in range(5):
        assert slug(name) == slug(name)


def test_slug_empty_name_raises():
    try:
        slug("")
        assert False, "expected ValueError for empty name"
    except ValueError:
        pass


def test_slug_whitespace_only_name_raises():
    try:
        slug("   \t  ")
        assert False, "expected ValueError for whitespace-only name"
    except ValueError:
        pass


def test_slug_truncates_long_names():
    long_name = "a" * 400
    base = slug(long_name)
    assert len(base) <= BASE_MAX
    assert is_valid_alias(base)


def test_slug_never_exceeds_alias_length():
    for _ in range(10):
        base = slug("model-" * 300)
        assert len(base) <= MAX_ALIAS_LEN
        assert is_valid_alias(base)


def test_slug_never_starts_with_separator():
    for name in ("Example", "8B Model", "日本語モデル", "a" * 20 + " b"):
        base = slug(name)
        assert re.match(r"^[a-z0-9]", base)


# ------------------------------------------------- resolve_alias -----------


def test_resolve_alias_no_collision_is_plain_slug():
    assert resolve_alias("Example 8B", []) == "example-8b"
    assert resolve_alias("Example 8B", ["unrelated"]) == "example-8b"


def test_resolve_alias_adds_increasing_suffix():
    assert resolve_alias("Example 8B", ["example-8b"]) == "example-8b-1"
    assert resolve_alias("Example 8B", ["example-8b", "example-8b-1"]) == "example-8b-2"
    assert (
        resolve_alias("Example 8B", ["example-8b", "example-8b-1", "example-8b-2"])
        == "example-8b-3"
    )


def test_resolve_alias_is_deterministic():
    taken = {"example-8b", "example-8b-1"}
    first = resolve_alias("Example 8B", taken)
    for _ in range(5):
        assert resolve_alias("Example 8B", taken) == first
    assert first == "example-8b-2"


def test_resolve_alias_avoids_every_entry_in_taken():
    taken = {"example-8b", "example-8b-1", "example-8b-2", "x"}
    result = resolve_alias("Example 8B", taken)
    assert result == "example-8b-3"
    assert result not in taken
    assert is_valid_alias(result)


def test_resolve_alias_never_exceeds_length_cap():
    taken = {"a" * 150}
    result = resolve_alias("a" * 150, taken)
    assert len(result) <= MAX_ALIAS_LEN
    assert is_valid_alias(result)


def test_resolve_alias_respects_unicode_input():
    result = resolve_alias("日本語モデル", [])
    assert result.startswith("model-")
    assert is_valid_alias(result)
    assert result == resolve_alias("日本語モデル", [])


def test_is_valid_alias_accepts_pattern():
    assert is_valid_alias("example-8b")
    assert is_valid_alias("8b-example")
    assert is_valid_alias("a.b-c_d/e")


def test_is_valid_alias_rejects_invalid():
    assert not is_valid_alias("")
    assert not is_valid_alias("-leading")
    assert not is_valid_alias("has space")
    assert not is_valid_alias("has space")
    assert not is_valid_alias("日本語")
    assert not is_valid_alias("a" * 161)


def test_all_generated_values_match_alias_pattern():
    names = [
        "Example 8B",
        "Writing Assistant",
        "Llama-3-8B-Instruct",
        "日本語モデル",
        "中文模型",
        "   spaced out   ",
        "a" * 300,
        "emoji 测试 🚀",
    ]
    taken = set()
    for name in names:
        alias = resolve_alias(name, taken)
        assert is_valid_alias(alias)
        taken.add(alias)
    assert len(set(taken)) == len(taken)


# ---------------------------------------------------- endpoint --------------


async def _suggest(client, name=None):
    params = {} if name is None else {"name": name}
    return await client.get("/api/deployments/alias/suggest", params=params)


async def test_suggest_alias_endpoint_returns_deterministic_alias(tmp_path):
    app = create_app(tmp_path)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        body = (await _suggest(client, "Example 8B")).json()
        assert body["mode"] == "generated"
        assert body["base"] == "example-8b"
        assert body["alias"] == "example-8b"
        # GET preview is token-free and idempotent.
        assert (await _suggest(client, "Example 8B")).status_code == 200


async def test_suggest_alias_endpoint_suggests_without_token(tmp_path):
    app = create_app(tmp_path)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        # No X-Menagerie-Token header: a read preview must not demand it.
        response = await _suggest(client, "Writing Assistant")
        assert response.status_code == 200
        assert response.json()["base"] == "writing-assistant"


async def test_suggest_alias_endpoint_sees_registry_collisions(tmp_path):
    app = create_app(tmp_path)
    store = app.state.store
    store.put("deployment", {"id": "d1", "name": "Example", "alias": "example-8b"})
    store.put("deployment", {"id": "d2", "name": "Example 2", "alias": "example-8b-1"})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        body = (await _suggest(client, "Example 8B")).json()
        assert body["base"] == "example-8b"
        assert body["alias"] == "example-8b-2"


async def test_suggest_alias_endpoint_rejects_empty_name(tmp_path):
    app = create_app(tmp_path)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await _suggest(client)
        assert response.status_code == 422
        # A whitespace-only name is a bad request with a helpful message.
        response = await _suggest(client, "   ")
        assert response.status_code == 400
        assert "name" in response.json()["error"].lower()
