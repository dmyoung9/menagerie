"""Small host differences; lifecycle policy remains in Manager."""

import os
from pathlib import Path


def state_path(value=None):
    default = (
        Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
        / "Menagerie"
        if os.name == "nt"
        else Path.home() / ".local/state/menagerie"
    )
    return (
        Path(value or os.environ.get("MENAGERIE_STATE") or default)
        .expanduser()
        .resolve()
    )


def lock_file(path):
    """Nonblocking, process-lifetime exclusive lock. Never unlink lock files."""
    handle = open(path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt

            if not path.stat().st_size:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RuntimeError(
            "Another Menagerie process owns this state directory"
        ) from None
    return handle


def executable(name):
    """Discover NVIDIA's utility even when its installer did not update PATH."""
    import shutil

    found = shutil.which(name)
    if found or os.name != "nt" or name != "nvidia-smi":
        return found
    for directory in (
        Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        / "NVIDIA Corporation/NVSMI",
    ):
        candidate = directory / "nvidia-smi.exe"
        if candidate.is_file():
            return str(candidate)
    return None
