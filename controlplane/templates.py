"""First-class chat templates: discovery, persistence and effective selection.

Template assets are the *evidence* for a template: the content of a publisher's
published template, an embedded GGUF ``tokenizer.chat_template``, or a user
authoring custom template. They are immutable evidence that the model-default
and deployment override reference by id.

Selections are stored separately from the evidence so a capability refresh
re-downloads template files but never overwrites a user's chosen source or
custom content.
"""

import hashlib
from pathlib import Path

from .store import uid

TEMPLATE_KINDS = ("published", "embedded", "custom")
TEMPLATE_SOURCES = ("automatic", "embedded", "published", "custom")
TEMPLATE_MAX_SIZE = 4 * 1024 * 1024  # 4 MiB per template body
TEMPLATE_DIR = "chat_templates"


def is_template_file(filename: str) -> bool:
    return bool(filename) and filename.lower().endswith(".jinja")


def template_name(filename: str) -> str:
    """A readable label for a template file path."""
    parts = filename.split("/")
    if len(parts) == 2 and parts[0].lower() == TEMPLATE_DIR:
        return Path(filename).name
    return Path(filename).stem or "chat template"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract_template_files(files: list[dict]) -> list[str]:
    """Template file paths present in a repository file listing."""
    result = []
    for f in files or []:
        name = f.get("name") or ""
        if not name or name.endswith("/") or not is_template_file(name):
            continue
        parts = name.split("/")
        if parts[-1] == "chat_template.jinja" or (
            len(parts) == 2 and parts[0].lower() == TEMPLATE_DIR
        ):
            result.append(name)
    return result


def template_from_gguf(metadata: dict, local_path: str) -> dict | None:
    """The embedded ``tokenizer.chat_template`` in a GGUF artifact, if any.

    Read-only evidence; the string is never written back to the file.
    """
    raw = metadata.get("tokenizer.chat_template")
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode("utf-8", errors="replace")
        elif isinstance(raw, (list, tuple)):
            raw = "".join(str(part) for part in raw)
        else:
            raw = str(raw)
    if not raw:
        return None
    return {
        "kind": "embedded",
        "name": "embedded",
        "file_path": local_path,
        "relative_path": None,
        "content": raw,
        "size_bytes": len(raw.encode("utf-8")),
        "status": "available",
        "error": None,
    }


def template_from_tokenizer_config(metadata: dict) -> dict | None:
    """The ``chat_template`` string in a safetensors ``tokenizer_config.json``.

    Returns None when there is no template string.
    """
    tokenizer = metadata.get("tokenizer_config")
    if not isinstance(tokenizer, dict):
        return None
    raw = tokenizer.get("chat_template")
    if not isinstance(raw, str) or not raw:
        return None
    return {
        "kind": "embedded",
        "name": "tokenizer.chat_template",
        "file_path": "tokenizer_config.json",
        "relative_path": "tokenizer_config.json",
        "content": raw,
        "size_bytes": len(raw.encode("utf-8")),
        "status": "available",
        "error": None,
    }


def collect_template_drafts(artifact: dict, hf_files: dict | None) -> list[dict]:
    """Normalize template drafts from embedded metadata and the HF listing.

    hf_files is the output of Jobs.hf_files and may carry ``contents`` mapped by
    relative path. Returns drafts (no ids yet).
    """
    drafts = []
    meta = artifact.get("metadata", {})
    if artifact.get("format") == "gguf":
        embedded = template_from_gguf(meta, artifact.get("local_path", ""))
        if embedded:
            drafts.append(embedded)
    if artifact.get("format") == "safetensors":
        embedded = template_from_tokenizer_config(meta)
        if embedded:
            drafts.append(embedded)
    files = hf_files or {}
    repo = files.get("repo")
    revision = files.get("revision")
    for filename in extract_template_files(files.get("files", [])):
        content = (files.get("contents") or {}).get(filename)
        size = len(content.encode("utf-8")) if content is not None else None
        if content is not None and size > TEMPLATE_MAX_SIZE:
            size = None
            content = None
        drafts.append(
            {
                "kind": "published",
                "name": template_name(filename),
                "repo": repo,
                "revision": revision,
                "file_path": filename,
                "relative_path": filename,
                "content": content,
                "size_bytes": size,
                "status": "missing" if content is None else "available",
                "error": None,
            }
        )
    return drafts


def create_template_assets(store, artifact_id, drafts):
    """Persist draft template assets, preserving existing user-owned custom
    assets and deduplicating identical content. Returns the stored assets
    for the artifact."""
    for draft in drafts:
        key = f"{draft['kind']}:{draft['name']}"
        existing = [
            t
            for t in store.list("template")
            if t.get("artifact_id") == artifact_id and f"{t['kind']}:{t['name']}" == key
        ]
        if existing:
            current = existing[0]
            if current.get("kind") == "custom":
                # A user's custom template is never shadowed by a re-collected
                # published or embedded draft.
                continue
            if current.get("sha256") == sha256_text(draft.get("content") or ""):
                # Identical content; nothing to persist.
                continue
        asset = dict(draft)
        if asset.get("content") is None:
            asset["content"] = ""
        asset["artifact_id"] = artifact_id
        if not asset.get("sha256"):
            asset["sha256"] = sha256_text(asset["content"])
        if not asset.get("id"):
            asset["id"] = (
                "template-"
                + asset["sha256"][:12]
                + f"{len(store.list('template')):06d}"
            )
        store.put("template", asset)
    return list_template_assets(store, artifact_id)


def list_template_assets(store, artifact_id: str | None = None):
    rows = store.list("template")
    if artifact_id:
        rows = [t for t in rows if t.get("artifact_id") == artifact_id]
    return sorted(rows, key=lambda t: (t.get("repo") or "", t.get("name") or ""))


def effective_selection(deployment, artifact, store):
    """Resolve {source, asset, description} from deployment override >
    model default > engine default."""
    override = deployment.get("template_override")
    default = artifact.get("template_default")
    if isinstance(override, dict) and override.get("source"):
        source, asset_id = override.get("source"), override.get("asset_id")
    elif isinstance(default, dict) and default.get("source"):
        source, asset_id = default.get("source"), default.get("asset_id")
    else:
        return {
            "source": "automatic",
            "asset": None,
            "description": "No template (engine default)",
        }
    if source not in TEMPLATE_SOURCES:
        return {
            "source": "automatic",
            "asset": None,
            "description": "No template (engine default)",
        }
    if source == "automatic":
        return {
            "source": source,
            "asset": None,
            "description": "No template (engine default)",
        }
    rows = list_template_assets(store, artifact.get("id")) if store else []
    asset = next((t for t in rows if t.get("id") == asset_id), None)
    return {
        "source": source,
        "asset": asset,
        "description": asset["name"] if asset else f"{source} template missing",
    }


def supports_template_flag(runtime) -> bool:
    flags = (runtime.get("capabilities") or {}).get("flags") or []
    if runtime.get("engine") in ("llama.cpp", "prism"):
        return "chat-template-file" in flags
    if runtime.get("engine") == "vllm":
        return "chat-template" in flags or "chat-template-file" in flags
    return False


def template_flag_name(runtime) -> str:
    if runtime.get("engine") in ("llama.cpp", "prism"):
        return "chat-template-file"
    if runtime.get("engine") == "vllm":
        return "chat-template"
    return "chat-template-file"


def detect_conflict(profile) -> str | None:
    """Detect a manual chat-template flag that conflicts with a structured selection."""
    config = profile.get("config", {})
    if isinstance(config, dict) and "chat-template-file" in config:
        return "config chat-template-file conflicts with the template selector"
    flags = ("--chat-template-file", "--chat-template")
    for arg in profile.get("raw_args", []):
        if not isinstance(arg, str):
            continue
        for flag in flags:
            if (
                arg == flag
                or arg.startswith(flag + "=")
                or (
                    arg.startswith(flag)
                    and len(arg) > len(flag)
                    and arg[len(flag)] in (" ", "\t", "\n")
                )
            ):
                return f"manual {arg} conflicts with the template selector"
    return None


def ensure_defaults(artifact: dict) -> None:
    """Backwards-compatible: an artifact without an explicit selection defaults
    to Automatic (no template override)."""
    artifact.setdefault("template_default", {"source": "automatic", "asset_id": None})


def persist_embedded_assets(store, artifact) -> list[dict]:
    """Create embedded template assets (GGUF tokenizer / safetensors
    tokenizer_config) from an artifact's already-parsed metadata."""
    ensure_defaults(artifact)
    return create_template_assets(
        store, artifact["id"], collect_template_drafts(artifact, {})
    )


def write_custom_template(store, content: str) -> Path:
    path = store.root / "templates"
    path.mkdir(parents=True, exist_ok=True)
    dest = path / f"custom-{uid()[:12]}.jinja"
    dest.write_bytes(content.encode("utf-8"))
    return dest


def truncate_for_display(text: str, limit=4000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… {len(text) - limit} characters omitted"
