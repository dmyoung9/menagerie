"""Read-only public catalog adapters, independent of locally running engines."""
from html.parser import HTMLParser
import re


class CatalogLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.href = None
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.href = dict(attrs).get("href")
            self.parts = []

    def handle_data(self, data):
        if self.href:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self.href:
            self.rows.append((self.href, " ".join(" ".join(self.parts).split())))
            self.href = None


def ollama_links(html, model=None):
    parser = CatalogLinks()
    parser.feed(html)
    found = {}
    for href, text in parser.rows:
        pattern = r"/library/([a-zA-Z0-9][a-zA-Z0-9_.-]*)" if model is None else r"/library/(" + re.escape(model) + r":[a-zA-Z0-9_.-]+)"
        match = re.fullmatch(pattern, href)
        if match:
            name = match[1]
            if name not in found or len(text) > len(found[name]["description"]):
                found[name] = {"name": name, "description": text, "url": "https://ollama.com" + href}
    return list(found.values())


async def ollama_catalog(client, query="", model=None):
    if model is not None and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}", model):
        raise ValueError("Invalid Ollama library model name")
    url = f"https://ollama.com/library/{model}/tags" if model else "https://ollama.com/search"
    try:
        response = await client.get(url, params=None if model else {"q": query}, timeout=25)
        response.raise_for_status()
        rows = ollama_links(response.text, model)
        if model and not rows:
            raise ValueError("No variants found; the upstream catalog may have changed")
        return {"models": rows, "source": "Ollama public library", "model": model}
    except Exception as exc:
        raise ValueError("Ollama public catalog unavailable; retry or check the model name") from exc
