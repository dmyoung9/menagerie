"""Bounded frozen-payload review, including Menagerie's embedded Python code."""

import argparse
import marshal
import types
from pathlib import Path

from PyInstaller.archive.readers import CArchiveReader

from scripts.check_distribution import (
    PATTERNS,
    PRIVATE_PARTS,
    TEXT_SUFFIXES,
    inspect_archive,
)


def inspect_payload(root):
    findings = set()
    budget = 512 * 1024**2

    def text_check(text):
        for category, pattern in PATTERNS.items():
            if pattern.search(text):
                findings.add(category)

    def code_check(code):
        if not isinstance(code, types.CodeType):
            return
        text_check(code.co_filename)
        for constant in code.co_consts:
            if isinstance(constant, str):
                text_check(constant)
            elif isinstance(constant, types.CodeType):
                code_check(constant)

    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if (
            path.is_symlink()
            or PRIVATE_PARTS.intersection(relative.parts)
            or path.suffix
            in {".sqlite", ".sqlite3", ".log", ".gguf", ".safetensors", ".har"}
        ):
            findings.add("private/generated payload member")
        size = path.stat().st_size
        budget -= size
        if budget < 0 or size > 128 * 1024**2:
            raise ValueError("Frozen payload exceeds bounded inspection size")
        if path.suffix in TEXT_SUFFIXES:
            text_check(path.read_text(encoding="utf-8", errors="replace"))
        if path.suffix in {".zip", ".whl"}:
            findings.update(inspect_archive(path))
    for name in ("Menagerie.exe", "menagerie-cli.exe"):
        archive = CArchiveReader(str(root / name))
        for entry, metadata in archive.toc.items():
            if metadata[-1] == "s" and entry in {"launcher_entry", "cli_entry"}:
                code_check(marshal.loads(archive.extract(entry)))
            elif metadata[-1] == "z":
                pyz = archive.open_embedded_archive(entry)
                for module in pyz.toc:
                    if module == "controlplane" or module.startswith("controlplane."):
                        code_check(pyz.extract(module))
    return sorted(findings)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", type=Path)
    args = parser.parse_args()
    results = inspect_payload(args.payload)
    if results:
        raise SystemExit("\n".join(results))
    print(
        "PASS: bounded frozen payload, nested archives and embedded Menagerie code inspection; human/license review still required"
    )
