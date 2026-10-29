"""Frozen GUI entrypoint; keep console-less startup errors observable."""

import multiprocessing
import os
import sys

from controlplane.host import state_path
from controlplane.launcher import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    if sys.stdout is None or sys.stderr is None:
        root = state_path()
        if "stop" in sys.argv[1:] and not root.exists():
            stream = open(os.devnull, "w", encoding="utf-8")
        else:
            root.mkdir(parents=True, exist_ok=True)
            stream = (root / "launcher.log").open("a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
    main()
