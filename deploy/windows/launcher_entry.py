"""Frozen GUI entrypoint; keep console-less startup errors observable."""

import multiprocessing
import sys

from controlplane.host import state_path
from controlplane.launcher import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    if sys.stdout is None or sys.stderr is None:
        root = state_path()
        root.mkdir(parents=True, exist_ok=True)
        stream = (root / "launcher.log").open("a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
    main()
