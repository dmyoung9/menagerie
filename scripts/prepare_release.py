"""Validate a release version and prepare bounded, checksummed publication inputs."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path


def validate_version(root: Path, tag: str | None = None) -> str:
    version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Release version must be MAJOR.MINOR.PATCH")
    if tag is not None and tag != "v" + version:
        raise ValueError("Tag does not match project version")
    for directory in ("frontend", "plugins/opencode"):
        package = json.loads((root / directory / "package.json").read_text())
        lock = json.loads((root / directory / "package-lock.json").read_text())
        if any(
            v != version
            for v in (
                package["version"],
                lock["version"],
                lock["packages"][""]["version"],
            )
        ):
            raise ValueError(f"Version mismatch in {directory}")
    runtime = (root / "controlplane/version.py").read_text()
    if f'VERSION = "{version}"' not in runtime:
        raise ValueError("Runtime version mismatch")
    installer = (root / "install.sh").read_text()
    if (
        not re.search(r"^version=" + re.escape(version) + r"$", installer, re.MULTILINE)
        or f"default: {version}" not in installer
    ):
        raise ValueError("Installer version mismatch")
    template = ET.parse(root / "deploy/unraid/menagerie.xml").getroot()
    if template.findtext("Repository") != f"ghcr.io/dmyoung9/menagerie:{version}":
        raise ValueError("Unraid image version mismatch")
    return version


def prepare(root: Path, directory: Path, tag: str | None = None):
    version = validate_version(root, tag)
    wheel = directory / f"menagerie-{version}-py3-none-any.whl"
    source = directory / f"menagerie-{version}.tar.gz"
    if not wheel.is_file() or not source.is_file():
        raise ValueError("Build matching wheel and source distribution first")
    requirements = directory / f"menagerie-{version}-requirements.txt"
    subprocess.run(
        [
            "uv",
            "export",
            "--locked",
            "--no-dev",
            "--no-emit-project",
            "--no-hashes",
            "--output-file",
            str(requirements.resolve()),
        ],
        cwd=root,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    shutil.copyfile(root / "install.sh", directory / "install.sh")
    shutil.copyfile(
        root / "deploy/unraid/menagerie.xml", directory / "menagerie-unraid.xml"
    )
    assets = [
        wheel,
        source,
        requirements,
        directory / "install.sh",
        directory / "menagerie-unraid.xml",
    ]
    lines = []
    for asset in assets:
        line = f"{hashlib.sha256(asset.read_bytes()).hexdigest()}  {asset.name}\n"
        (directory / (asset.name + ".sha256")).write_text(line)
        lines.append(line)
    (directory / "SHA256SUMS").write_text("".join(lines))
    print(
        f"Prepared release {version}: version alignment, dependency constraints and checksums"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("dist"))
    parser.add_argument("--tag")
    args = parser.parse_args()
    prepare(Path(__file__).resolve().parents[1], args.directory, args.tag)
