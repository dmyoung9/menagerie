"""Build a native installer from the installed wheel, never from a user's state."""

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("dist/windows"))
    parser.add_argument(
        "--baseline-for-check",
        action="store_true",
        help="Also build a synthetic older installer for upgrade checks; never publish it",
    )
    args = parser.parse_args()
    if sys.platform != "win32":
        raise SystemExit("Windows installers must be built on native Windows")
    root = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    version = importlib.metadata.version("menagerie")
    work = root / "build/windows"
    # Absolute installed-package paths prevent accidental checkout imports.
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(work / "payload"),
            "--workpath",
            str(work / "work"),
            str(root / "deploy/windows/menagerie.spec"),
        ],
        cwd=output,
        check=True,
    )
    payload = work / "payload/Menagerie"
    shutil.copyfile(root / "LICENSE", payload / "LICENSE.txt")
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if python_license.is_file():
        shutil.copyfile(python_license, payload / "PYTHON-LICENSE.txt")
    else:
        # Some uv-managed Python distributions omit this text. Acquire only
        # the license, from the exact CPython release, not a moving branch.
        url = f"https://raw.githubusercontent.com/python/cpython/v{platform.python_version()}/LICENSE"
        with urllib.request.urlopen(url, timeout=60) as response:
            text = response.read(128 * 1024 + 1)
        if len(text) > 128 * 1024 or b"PYTHON SOFTWARE FOUNDATION" not in text:
            raise RuntimeError(
                "Cannot verify the Python license text; refusing to distribute"
            )
        (payload / "PYTHON-LICENSE.txt").write_bytes(text)
    notices = []
    for distribution in importlib.metadata.distributions():
        if distribution.metadata["Name"].lower() in {
            "menagerie",
            "pip",
            "pyinstaller",
            "setuptools",
            "altgraph",
            "pyinstaller-hooks-contrib",
        }:
            continue
        notices.append(
            {
                "name": distribution.metadata["Name"],
                "version": distribution.version,
                "license": distribution.metadata.get("License-Expression")
                or distribution.metadata.get(
                    "License", "See bundled distribution metadata"
                ),
            }
        )
    (payload / "THIRD-PARTY.json").write_text(
        json.dumps(notices, indent=2), encoding="utf-8"
    )
    compiler = shutil.which("ISCC") or str(
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        / "Inno Setup 6/ISCC.exe"
    )
    manifest = payload / "build.json"
    if args.baseline_for_check:
        baseline = work / "baseline"
        baseline.mkdir(parents=True, exist_ok=True)
        manifest.write_text(
            json.dumps({"version": "0.0.0", "kind": "synthetic-upgrade-baseline"}),
            encoding="utf-8",
        )
        subprocess.run(
            [
                compiler,
                "/DAppVersion=0.0.0",
                f"/DPayloadDir={payload}",
                f"/O{baseline}",
                str(root / "deploy/windows/menagerie.iss"),
            ],
            check=True,
        )
    manifest.write_text(
        json.dumps({"version": version, "kind": "release"}), encoding="utf-8"
    )
    subprocess.run(
        [
            compiler,
            f"/DAppVersion={version}",
            f"/DPayloadDir={payload}",
            f"/O{output}",
            str(root / "deploy/windows/menagerie.iss"),
        ],
        check=True,
    )
    installer = output / f"menagerie-{version}-windows-x64-setup.exe"
    checksum = hashlib.sha256(installer.read_bytes()).hexdigest()
    (output / (installer.name + ".sha256")).write_text(
        f"{checksum}  {installer.name}\n", encoding="utf-8"
    )
    # This is an inspection input, not a second user distribution format.
    shutil.make_archive(str(work / "payload-inspection"), "zip", payload)
    print(
        f"Built Windows x64 installer {version}; hardware acceptance remains separate"
    )


if __name__ == "__main__":
    main()
