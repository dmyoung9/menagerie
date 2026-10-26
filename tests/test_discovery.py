import httpx
import pytest
from controlplane.discovery import ollama_links, ollama_catalog


def test_public_catalog_deduplicates_tags_and_rejects_external_links():
    html = '''<a href="/library/llama3.2:3b"><span>3b</span> 2.0GB &amp; tools</a>
    <a href="/library/llama3.2:3b">3b</a>
    <a href="https://evil.test/library/llama3.2:3b">wrong</a>
    <a href="/library/other:3b">other</a>'''
    rows = ollama_links(html, "llama3.2")
    assert len(rows) == 1
    assert rows[0]["name"] == "llama3.2:3b"
    assert "2.0GB & tools" in rows[0]["description"]


@pytest.mark.asyncio
async def test_public_catalog_does_not_require_local_ollama():
    def handle(request):
        assert request.url.host == "ollama.com"
        assert request.url.params["q"] == "qwen & llama"
        return httpx.Response(200, text='<a href="/library/qwen3">Qwen 3</a>')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        result = await ollama_catalog(client, query="qwen & llama")
        assert result["models"][0]["name"] == "qwen3"
        with pytest.raises(ValueError, match="Invalid"):
            await ollama_catalog(client, model="../../api")


@pytest.mark.asyncio
async def test_upstream_failure_is_actionable():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(503))) as client:
        with pytest.raises(ValueError, match="catalog unavailable"):
            await ollama_catalog(client, model="llama3.2")
