"""Private environments for opt-in checks; not a sandbox for runtime code."""

import argparse
import asyncio
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def isolated_environment(root: Path) -> dict[str, str]:
    """Pass tool discovery/locale only, never the caller's credentials or config."""
    env = {
        key: os.environ[key]
        for key in (
            "PATH",
            "LANG",
            "LC_ALL",
            "TZ",
            "SYSTEMROOT",
            "SystemRoot",
            "WINDIR",
            "PATHEXT",
        )
        if key in os.environ
    }
    paths = {
        "HOME": "home",
        "XDG_CONFIG_HOME": "config",
        "XDG_DATA_HOME": "data",
        "XDG_STATE_HOME": "state",
        "XDG_CACHE_HOME": "cache",
        "TMPDIR": "tmp",
        "HF_HOME": "cache/huggingface",
        "UV_CACHE_DIR": "cache/uv",
        "UV_PYTHON_INSTALL_DIR": "data/python",
        "USERPROFILE": "home",
        "LOCALAPPDATA": "local",
        "APPDATA": "roaming",
        "TEMP": "tmp",
        "TMP": "tmp",
    }
    for key, relative in paths.items():
        path = root / relative
        path.mkdir(parents=True, exist_ok=True)
        env[key] = str(path)
    env["UV_NO_CONFIG"] = "1"
    env["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    return env


def run_live_check(main, module: str):
    """Require consent and re-exec before SDKs can use personal caches/tokens."""
    parser = argparse.ArgumentParser(description="Opt-in isolated live inference check")
    parser.add_argument(
        "--approve",
        action="store_true",
        required=True,
        help="Approve engine/model downloads and real inference",
    )
    parser.parse_args()
    if os.environ.get("MENAGERIE_CHECK_CHILD") == module:
        asyncio.run(main())
        return
    with tempfile.TemporaryDirectory(prefix="menagerie-live-") as directory:
        env = isolated_environment(Path(directory))
        env["MENAGERIE_CHECK_CHILD"] = module
        # Keep child logs private and disposable; never forward raw SDK events,
        # exception tracebacks, runtime logs, or host details to the caller.
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(
                [sys.executable, "-m", module, "--approve"],
                cwd=Path(__file__).resolve().parents[1],
                env=env,
                stdout=output,
                stderr=output,
            )
        if result.returncode:
            raise SystemExit("Isolated live check failed; raw output withheld")
        print("PASS: isolated live inference check")
