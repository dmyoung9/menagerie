"""Download selection manifests and the acquired-file contract (Stage 1).

This module specifies the *contract* that Stage 3's download jobs and the
repository UI build on. It operates on plain structures so the rules are
unit-testable without a network, a runtime, or a live registry.

Identity model
---------------
A repository snapshot download is described by a **manifest**: the resolved
revision, every file at that revision, and the *group structure* that turns
indistinguishable bytes into coherent bundles. A manifest is a derived view
(reshaped from the pinned revision's file list and local acquisition state);
the *persistent* acquired-file records are :class:`DownloadedFile`, which are
deliberately separate from the deployable :class:`Artifact` and from
deployment configuration. Acquiring bytes does not create or enable a model,
and reusing bytes for another deployment copies nothing.

Groups
------
Files that must be acquired together are **groups** (expandable bundles). The
group's main row is the only selectable row; its members are inspectable and are
pulled in when the row is selected. A group is usable (selectable) only while
it is *complete* — every required file is present at the selected revision.
Incomplete groups remain visible so the UI can explain exactly which bytes
are missing; they are never presented as deployable.

Selection rules
---------------
A selection is a list of group ids. ``required_files`` resolves it to the flat
set of repository-relative file paths that must all be present. Every selected
id must name a group present in the manifest; otherwise the selection is
rejected (a hidden or stale selection must not become a silent whole-repository
download).

Partial failure and retry
-------------------------
``pending`` lists every required file not yet downloaded (for progress display).
``retry_targets`` lists only files whose status is ``failed`` or ``missing``
— the set a "Retry failed files" action re-acquires — without retransferring
anything already ``downloaded``.

Revision safety
---------------
Selections are keyed to a resolved revision. :func:`clear_selection` returns
an empty selection whenever the target revision differs from the manifest's,
because changing revisions must never apply an old selection to new bytes.
Downloaded bytes persist as separate ``DownloadedFile`` records keyed by
(repo, revision, path), so they survive a revision change.
"""

from __future__ import annotations

import re

from .schema import AcquisitionStatus, DownloadedFile

# Split-GGUF shard naming, matching controlplane.jobs.SPLIT_GGUF.
SPLIT_GGUF = re.compile(
    r"^(?P<stem>.+)-(?P<index>\d{5})-of-(?P<total>\d{5})\.gguf$", re.IGNORECASE
)
# File names that count as downloadable companions (projectors / drafting heads).
COMPANION = re.compile(r"mmproj", re.IGNORECASE)
COMPANION_EXT = ".gguf"


def downloaded_file_key(repo: str, revision: str, name: str) -> tuple[str, str, str]:
    """The identity key for an acquired file. Two files collide only when they
    come from the same repository, same resolved revision, same path."""
    return (repo, revision, name)


def build_manifest(
    repo: str,
    revision: str,
    files: list[dict],
    bundle_map: dict | None = None,
) -> dict:
    """Build a manifest from the pinned revision's file list.

    ``files`` is the shape returned by :meth:`Jobs.hf_files` (``{"name", "size",
    "sha256"}`` per file). ``bundle_map`` optionally maps a human bundle name
    to the exact set of file paths it comprises; this is how *identified*
    safetensors bundles are grouped without ever assuming every ``.safetensors``
    file belongs together. Split GGUFs are always auto-detected.

    Returns ``{"repo", "revision", "files", "groups"}`` where each group is
    ``{"id", "name", "kind", "required", "complete"}``.
    """
    return {
        "repo": repo,
        "revision": revision,
        "files": list(files),
        "groups": list(detect_groups(files, bundle_map)),
    }


def detect_groups(files: list[dict], bundle_map: dict | None = list) -> list[dict]:
    names = {f["name"] for f in files}
    groups: list[dict] = []
    consumed: set[str] = set()
    bundle_map = dict(bundle_map or {})

    # 1. Explicitly identified bundles (e.g. safetensors). Never group files
    #    together unless a bundle is declared; that is how we honour "a
    #    repository can contain more than one bundle".
    for group_name, members in bundle_map.items():
        required = sorted(set(str(m) for m in members))
        if not required:
            continue
        complete = all(n in names for n in required)
        groups.append(
            {
                "id": f"bundle-{group_name}",
                "name": group_name,
                "kind": "safetensors",
                "required": required,
                "complete": complete,
            }
        )
        consumed.update(required)

    # 2. Split GGUF bundles, auto-detected. The full required set is the full
    #    1..total index series; a group is complete only when all shards are
    #    present at this revision.
    shards: dict[tuple[str, str], set[str]] = {}
    for name in names:
        m = SPLIT_GGUF.match(name)
        if m:
            shards.setdefault((m.group("stem"), m.group("total")), set()).add(name)
    for (stem, total), members in shards.items():
        count = int(total)
        if count < 1:
            continue
        expected = [f"{stem}-{i:05d}-of-{total}.gguf" for i in range(1, count + 1)]
        required = sorted(expected)
        if not (members & set(required)):
            continue
        complete = members >= set(required)
        groups.append(
            {
                "id": f"gguf-{stem.replace('/', '_')}-{total}",
                "name": stem,
                "kind": "gguf_split",
                "required": required,
                "complete": complete,
            }
        )
        consumed.update(required)

    # 3. Everything else is its own selectable group: companions (projectors,
    #    drafting heads) and standalone files. Unknown/unclassified files stay
    #    selectable (never hidden).
    for name in sorted(names):
        if name in consumed:
            continue
        is_companion = (
            name.lower().endswith(COMPANION_EXT)
            and COMPANION.search(name.lower()) is not None
        )
        groups.append(
            {
                "id": name,
                "name": name,
                "kind": "companion" if is_companion else "standalone",
                "required": [name],
                "complete": True,
            }
        )

    return groups


def validate_selection(manifest: dict, selected: list[str] | None) -> list[str]:
    """Return a de-duplicated, order-preserving selection whose ids all exist.

    Raises ``ValueError`` if any id names a file or bundle that is not present
    in this manifest, so a stale or out-of-scope selection can never expand into
    an unintended whole-repository download."""
    ids = {g["id"] for g in manifest["groups"]}
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in selected or []:
        if item not in ids:
            raise ValueError(
                f"Selection references a file or bundle not present at this "
                f"revision: {item!r}"
            )
        if item not in seen:
            seen.add(item)
            cleaned.append(item)
    return cleaned


def required_files(manifest: dict, selected: list[str] | None) -> list[str]:
    """Resolve a selection to the flat, sorted set of file paths it requires.

    Group ids expand to their ``required`` members; standalone ids resolve to
    themselves. The union is what a "Download selected" action transfers."""
    resolved = validate_selection(manifest, selected)
    by_id = {g["id"]: g for g in manifest["groups"]}
    needed: set[str] = set()
    for group_id in resolved:
        needed.update(by_id[group_id]["required"])
    return sorted(needed)


def _status(statuses: dict | None, name: str) -> str:
    if not statuses:
        return "not_downloaded"
    return str(statuses.get(name, "not_downloaded"))


def pending(
    manifest: dict, selected: list[str] | None, statuses: dict | None
) -> list[str]:
    """Required files not yet ``downloaded`` — the set a batch is still
    acquiring. Used for download progress; never retransfers completed bytes
    when the caller only wants to retry."""
    return [
        name
        for name in required_files(manifest, selected)
        if _status(statuses, name) != "downloaded"
    ]


def retry_targets(
    manifest: dict, selected: list[str] | None, statuses: dict | None
) -> list[str]:
    """Files the 'Retry failed files' action must re-acquire.

    Exactly the ``failed`` and ``missing`` required files. Already ``downloaded``
    bytes are never retransferred, and in-flight ``downloading`` files are left
    to the current job rather than double-acquired."""
    return [
        name
        for name in required_files(manifest, selected)
        if _status(statuses, name) in ("failed", "missing")
    ]


def clear_selection(
    manifest: dict,
    selected: list[str] | None,
    new_revision: str,
) -> tuple[list[str], bool]:
    """If the target revision differs from the manifest's, the selection is
    cleared (new bytes must not inherit old selections). Returns the resulting
    selection and whether it was cleared."""
    if manifest.get("revision") == new_revision:
        return list(selected or []), False
    return [], True


def downloaded_file_record(
    repo: str,
    source_revision: str,
    name: str,
    *,
    group_id: str | None = None,
    size_bytes: int | None = None,
    sha256: str | None = None,
    status: AcquisitionStatus = "not_downloaded",
    local_path: str | None = None,
    error: str | None = None,
) -> dict:
    """Build the raw dict for a :class:`DownloadedFile` record (no store-
    injected row ``revision``). The caller passes this to ``store.put``.
    Validation against the model must strip any injected row ``revision`` first."""
    return {
        "repo": repo,
        "source_revision": source_revision,
        "name": name,
        "group_id": group_id,
        "size_bytes": size_bytes,
        "sha256": sha256,
        "status": status,
        "local_path": local_path,
        "error": error,
    }


def validate_downloaded_file(record: dict) -> dict:
    """Validate a DownloadedFile payload. If the record carries a store-injected
    row ``revision`` it is dropped before model validation, matching the rest of
    the registry."""
    payload = dict(record)
    payload.pop("revision", None)
    return DownloadedFile.model_validate(payload)
