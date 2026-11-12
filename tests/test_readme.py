"""Stage 3: independent repository acquisition — README fetch and manifest
wiring. No live runtime, no network; HF and HTTP calls are faked at the client
boundary."""

import httpx
import pytest

from controlplane import jobs as jobs_module
from controlplane.api import create_app

Jobs = jobs_module.Jobs


def _fake_client(bodies):
    """Stand-in for ``httpx.AsyncClient``. Mirrors the real client's ``stream``
    shape: ``client.stream(...)`` returns a context-manager object, and the
    yielded ``response`` exposes ``raise_for_status`` and ``aiter_bytes``.
    Each entry is ``(status, bytes)``; a status of 400+ makes
    ``raise_for_status`` raise so the caller's fallback path runs."""

    class FakeStream:
        def __init__(self, status, body):
            self._status = status
            self._body = body
            self._closed = False

        def raise_for_status(self):
            if self._status >= 400:
                raise httpx.HTTPError(f"HTTP {self._status}")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            self._closed = True
            return False

        def aclose(self):
            self._closed = True

        async def aiter_bytes(self):
            yield self._body

    class FakeClient:
        def __init__(self, responses):
            self._responses = list(responses)
            self.urls = []

        # Sync method returning a context-manager object, matching the
        # ``@asynccontextmanager``-wrapped real httpx ``stream``.
        def stream(self, method, url, **kwargs):
            self.urls.append(url)
            status, body = self._responses.pop(0)
            return FakeStream(status, body)

        async def aclose(self):
            pass

    return FakeClient(bodies)


def _fake_hf_files(sha="a" * 40, files=None):
    """Build a ``Jobs.hf_files`` stand-in for a resolved revision."""

    async def fake_hf_files(self, repo, revision="main"):
        return {
            "repo": repo,
            "revision": sha,
            "files": files or [{"name": "config.json", "size": 12, "sha256": None}],
        }

    return fake_hf_files


@pytest.mark.asyncio
async def test_readme_endpoint_serves_pinned_revision_content(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)
    sha = "a" * 40

    monkeypatch.setattr(Jobs, "hf_files", _fake_hf_files(sha))
    client = _fake_client([(200, b"# Menagerie\n\nREADME body"), (404, b""), (404, b"")])
    app.state.manager.client = client

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        response = await c.get(
            "/api/catalog/hf/readme", params={"repo": "org/model", "revision": "main"}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["repo"] == "org/model"
    assert body["revision"] == "main"
    assert body["content"] == "# Menagerie\n\nREADME body"
    # Only the successful candidate was consumed; the 404 fallbacks stayed queued.
    assert len(client._responses) == 2
    # The pinned revision (sha) is in the fetch URL, not "main".
    assert f"/resolve/{sha}/README.md" in client.urls[0]


@pytest.mark.asyncio
async def test_readme_falls_back_to_alternative_filenames(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)

    monkeypatch.setattr(Jobs, "hf_files", _fake_hf_files())
    # README.md 404, README 200.
    client = _fake_client([(404, b""), (200, b"Alt readme"), (404, b"")])
    app.state.manager.client = client

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        response = await c.get("/api/catalog/hf/readme", params={"repo": "org/model"})

    assert response.status_code == 200
    assert response.json()["content"] == "Alt readme"
    # First candidate was a 404; the second (README) was the hit.
    assert client.urls[0].endswith("README.md")
    assert client.urls[1].endswith("/README")


@pytest.mark.asyncio
async def test_readme_returns_none_when_all_candidates_missing(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)

    monkeypatch.setattr(Jobs, "hf_files", _fake_hf_files())
    client = _fake_client([(404, b""), (404, b""), (404, b"")])
    app.state.manager.client = client

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        response = await c.get("/api/catalog/hf/readme", params={"repo": "org/model"})

    assert response.status_code == 200
    assert response.json()["content"] is None


@pytest.mark.asyncio
async def test_readme_caps_huge_readmes(tmp_path, monkeypatch):
    app = create_app(tmp_path)

    monkeypatch.setattr(Jobs, "hf_files", _fake_hf_files(files=[]))
    client = _fake_client([(200, b"x" * 3_000_000), (404, b""), (404, b"")])
    app.state.manager.client = client

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        response = await c.get("/api/catalog/hf/readme", params={"repo": "org/model"})

    # Over-limit fetch raised and was swallowed by the candidate loop -> None.
    assert response.status_code == 200
    assert response.json()["content"] is None


@pytest.mark.asyncio
async def test_readme_endpoint_is_public_get_no_token(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)

    monkeypatch.setattr(Jobs, "hf_files", _fake_hf_files())
    client = _fake_client([(200, b"ok"), (404, b""), (404, b"")])
    app.state.manager.client = client

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as c:
        response = await c.get("/api/catalog/hf/readme", params={"repo": "org/model"})
        # No X-Menagerie-Token header supplied — a public read.
        assert response.status_code == 200
