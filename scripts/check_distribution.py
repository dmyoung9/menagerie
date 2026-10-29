"""Bounded privacy checks for release archives; complements human review."""

import argparse
import io
import re
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

TEXT_SUFFIXES = {
    ".md",
    ".py",
    ".js",
    ".mjs",
    ".ts",
    ".tsx",
    ".json",
    ".yml",
    ".yaml",
    ".sh",
    ".toml",
    ".txt",
    ".cfg",
    ".ini",
    ".html",
    ".css",
    ".map",
    ".csv",
    ".xml",
}
PRIVATE_PARTS = {
    ".git",
    ".venv",
    "node_modules",
    "test-results",
    "playwright-report",
    "__pycache__",
}
PATTERNS = {
    "personal home path": re.compile(r"/(?:home|Users)/[^/\s\"']+"),
    "credential-like literal": re.compile(
        r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)"
    ),
    "development-host report": re.compile(r"^Host:.*(?:kernel|driver)", re.MULTILINE),
}


def inspect_archive(path: Path) -> list[str]:
    """Return category/location only, never matching values or raw metadata."""
    findings = []
    budget = 64 * 1024 * 1024
    if path.stat().st_size > budget:
        raise ValueError("Archive exceeds bounded review size")

    def inspect(data: bytes, label: str, depth=0):
        nonlocal budget
        if depth > 2:
            raise ValueError("Archive nesting exceeds review limit")
        if zipfile.is_zipfile(io.BytesIO(data)):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = [
                    (m.filename, m.file_size, lambda m=m: archive.read(m))
                    for m in archive.infolist()
                    if not m.is_dir()
                ]
                check(entries, label, depth)
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                if any(m.issym() or m.islnk() for m in archive.getmembers()):
                    findings.append(f"{label}: archive links require manual review")
                entries = [
                    (m.name, m.size, lambda m=m: archive.extractfile(m).read())
                    for m in archive.getmembers()
                    if m.isfile()
                ]
                check(entries, label, depth)

    def check(entries, label, depth):
        nonlocal budget
        for name, size, read in entries:
            member = PurePosixPath(name)
            if member.is_absolute() or ".." in member.parts or "\\" in name:
                findings.append(f"{label}: unsafe archive path")
                continue
            if (
                PRIVATE_PARTS.intersection(member.parts)
                or member.name.startswith(".env")
                or member.suffix
                in {".log", ".sqlite", ".sqlite3", ".har", ".gguf", ".safetensors"}
                or member.name in {"auth.json", "credentials", "id_rsa", "id_ed25519"}
            ):
                findings.append(f"{label}: private/generated member")
            budget -= size
            if size > 16 * 1024 * 1024 or budget < 0:
                raise ValueError("Archive exceeds bounded review size")
            content = read()
            if name.endswith((".whl", ".zip", ".tar.gz")):
                inspect(content, f"{label}/nested archive", depth + 1)
            elif member.suffix in TEXT_SUFFIXES or member.name in {
                "METADATA",
                "PKG-INFO",
                "AGENTS.md",
            }:
                text = content.decode("utf-8", errors="replace")
                for category, pattern in PATTERNS.items():
                    if pattern.search(text):
                        # Do not echo member names, which can themselves be private.
                        findings.append(f"{label}: {category}")

    inspect(path.read_bytes(), "distribution")
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archives", type=Path, nargs="+")
    args = parser.parse_args()
    try:
        findings = [
            finding for path in args.archives for finding in inspect_archive(path)
        ]
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile):
        raise SystemExit(
            "Distribution inspection failed; archive requires manual review"
        ) from None
    if findings:
        raise SystemExit("\n".join(sorted(set(findings))))
    print("PASS: bounded distribution privacy checks (human review still required)")


if __name__ == "__main__":
    main()
