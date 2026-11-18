"""Deterministic API-identifier generation for model deployments.

A deployment's API identifier (its ``alias``) must be non-empty, ASCII,
start with a letter or digit, use only ``[a-z0-9]`` plus ``[_.-/]``,
and be at most ``MAX_ALIAS_LEN`` characters long. This module is the
single source of truth for that contract.

The identifier is a deterministic function of the display name: it is
never random, so it follows renames, stays stable across server restarts
and renderings, and matches the preview the dashboard shows before save.
The same pure functions drive the server-side suggest endpoint and every
stored value.

The functions here are stateless and fully unit-testable. Registry
collision resolution is the only place that depends on external state,
and it is passed in explicitly (``taken``) so the pure slug rules stay
testable in isolation.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Iterable

# Mirrors the schema alias pattern exactly: one leading alnum plus up to
# 159 of alnum/_./-, i.e. 160 total characters.
MAX_ALIAS_LEN = 160
# Keep the base short enough that the "-<n>" collision suffix always fits
# inside MAX_ALIAS_LEN for a realistic collision count; ``resolve_alias``
# additionally truncates defensively if a collision runs long.
BASE_MAX = 150
# Stable prefix for names with no transliteratable (ASCII) content.
_FALLBACK_PREFIX = "model"
_DIGEST_LEN = 8

_ALIAS_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,159}$")


def _nfc(name: str) -> str:
    """Normalize and trim the display name before any transformation."""
    return unicodedata.normalize("NFKC", name or "").strip()


def _fold(name: str) -> str:
    """Reduce a display name to its pure-ASCII slug base.

    ASCII letters and digits survive (lowercased); every other character
    — whitespace, punctuation, and all non-ASCII code points — becomes a
    separator. The result is collapsed to single hyphens with no leading
    or trailing separators.

    This is intentionally lossy for non-Latin scripts: a name made entirely
    of non-ASCII characters folds to the empty string, which the caller
    routes to a stable fallback.
    """
    out: list[str] = []
    for ch in _nfc(name):
        if ch.isascii():
            out.append(ch.lower() if ch.isalnum() else "-")
        else:
            out.append("-")
    return re.sub(r"[-_]+", "-", "".join(out)).strip("-")


def _digest(name: str) -> str:
    """Stable, non-random fragment for a name with no ASCII content.

    Deterministic (same name always yields the same fragment), so it does
    not become a random changing identifier. Used only when a display name
    has no transliteratable content.
    """
    return hashlib.sha256(_nfc(name).encode("utf-8")).hexdigest()[:_DIGEST_LEN]


def slug(name: str) -> str:
    """Return the deterministic identifier *base* for a display name.

    Always returns a non-empty string matching the alias pattern.

    Raises:
        ValueError: if the display name is empty or whitespace-only. A
            deployment must have a readable name before an identifier can
            be derived from it.
    """
    name = _nfc(name)
    if not name:
        raise ValueError("Model name is required")
    base = _fold(name)
    if not base:
        base = f"{_FALLBACK_PREFIX}-{_digest(name)}"
    if len(base) > BASE_MAX:
        cut = base[:BASE_MAX]
        sep = cut.rfind("-")
        if sep:
            cut = cut[:sep]
        base = cut.strip("-")
    if not base:
        base = f"{_FALLBACK_PREFIX}-{_digest(name)}"
    return base


def is_valid_alias(value: str) -> bool:
    """True when ``value`` matches the deployment alias pattern."""
    return bool(_ALIAS_PATTERN.match(value))


def _with_suffix(base: str, n: int) -> str:
    """Append a zero-padded collision suffix, guaranteeing the length cap.

    ``n == 0`` means no suffix. If appending would exceed the hard cap, the
    base is truncated to make room for the suffix rather than dropping it.
    """
    if n == 0:
        return base
    suffix = f"-{n}"
    if len(base) + len(suffix) <= MAX_ALIAS_LEN:
        return base + suffix
    room = MAX_ALIAS_LEN - len(suffix)
    if room < 1:
        raise ValueError("Identifier cannot fit for this display name")
    return base[:room] + suffix


def resolve_alias(name: str, taken: Iterable[str]) -> str:
    """Return a collision-free, pattern-valid identifier for a display name.

    The result is the deterministic ``slug`` of ``name``, with the shortest
    ``-<n>`` suffix that avoids every entry in ``taken``. The same display
    name and taken set always produce the same identifier (no randomness).
    """
    taken = set(taken)
    base = slug(name)
    n = 0
    while True:
        candidate = _with_suffix(base, n)
        if candidate and is_valid_alias(candidate) and candidate not in taken:
            return candidate
        n += 1
