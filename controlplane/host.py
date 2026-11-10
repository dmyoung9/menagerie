"""Small host differences; lifecycle policy remains in Manager."""

import os
from pathlib import Path


def state_path(value=None, *, resolve=True):
    default = (
        Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
        / "Menagerie"
        if os.name == "nt"
        else Path.home() / ".local/state/menagerie"
    )
    path = Path(value or os.environ.get("MENAGERIE_STATE") or default).expanduser()
    return path.resolve() if resolve else path.absolute()


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
        candidate = directory / f"{name}.exe"
        if candidate.is_file():
            return str(candidate)
    return None


def cuda_release(output):
    """Parse nvcc's ``release X.Y`` line."""
    import re

    match = re.search(r"release (\d+)\.(\d+)", output or "")
    return (int(match[1]), int(match[2])) if match else None


def compute_capabilities(output):
    """Parse ``nvidia-smi --query-gpu=compute_cap`` CSV output."""
    import re

    found = set()
    for line in (output or "").splitlines():
        match = re.fullmatch(r"\s*(\d+)\.(\d+)\s*", line)
        if match:
            found.add((int(match[1]), int(match[2])))
    return sorted(found)


def cuda_toolkit():
    """Return the CUDA toolkit version nvcc reports, or None."""
    import subprocess

    tool = executable("nvcc")
    if not tool:
        return None
    try:
        output = subprocess.run(
            [tool, "--version"], capture_output=True, text=True, timeout=30
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return cuda_release(output)


def gpu_capabilities():
    """Return the compute capabilities nvidia-smi reports, ascending."""
    import subprocess

    tool = executable("nvidia-smi")
    if not tool:
        return []
    try:
        output = subprocess.run(
            [tool, "--query-gpu=compute_cap", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return compute_capabilities(output)
