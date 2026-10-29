"""Installed Windows uninstaller consent and category checks; synthetic data only."""

import ctypes
import subprocess
import time
from ctypes import wintypes

import psutil

from controlplane.store import Store


def check_dialog_defaults(app, root, env):
    user = ctypes.WinDLL("user32", use_last_error=True)
    callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user.FindWindowW.restype = wintypes.HWND
    user.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.EnumChildWindows.argtypes = [wintypes.HWND, callback, wintypes.LPARAM]
    user.SendMessageW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user.SendMessageW.restype = wintypes.LPARAM
    process = subprocess.Popen([str(app / "unins000.exe")], env=env, cwd=root)
    window = None
    verified_window = False
    try:
        for _ in range(100):
            window = user.FindWindowW(None, "Menagerie data removal")
            if window:
                break
            time.sleep(0.1)
        assert window, "Optional data-removal dialog did not appear"
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(window, ctypes.byref(pid))
        assert psutil.Process(pid.value).exe()
        from pathlib import Path

        assert (
            Path(psutil.Process(pid.value).exe())
            .resolve()
            .is_relative_to(root.resolve())
        )
        verified_window = True
        controls = {}

        @callback
        def collect(handle, parameter):
            title = ctypes.create_unicode_buffer(512)
            user.GetWindowTextW(handle, title, len(title))
            if title.value:
                controls[title.value] = handle
            return True

        user.EnumChildWindows(window, collect, 0)
        labels = (
            "Settings, model/engine references, history and registry backups",
            "Menagerie-managed engines and source-build installations",
            "Downloaded models (only Menagerie models\\hf)",
            "Engine/application caches (separate from model downloads)",
            "Application and runtime logs",
        )
        for label in labels:
            assert label in controls, "Missing granular removal option"
            assert user.SendMessageW(controls[label], 0x00F0, 0, 0) == 0, (
                "Data removal was selected by default"
            )
        user.SendMessageW(controls["Cancel"], 0x00F5, 0, 0)
        window = None
        process.wait(timeout=20)
        assert (app / "Menagerie.exe").exists(), (
            "Cancelling removal uninstalled the app"
        )
    finally:
        if window and verified_window:
            user.SendMessageW(window, 0x0010, 0, 0)
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


def check_removal_options(app, state, root, env, install, execute):
    check_dialog_defaults(app, root, env)
    uninstaller = [
        app / "unins000.exe",
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
    ]
    execute(uninstaller + ["/REMOVEMODELS=1"], success=False)
    assert (app / "Menagerie.exe").exists(), (
        "Unconfirmed destructive flags uninstalled the app"
    )
    assert (state / "registry.sqlite3").exists()
    fixtures = {
        "engines": "engines/removal-fixture/worker.bin",
        "models": "models/hf/removal-fixture/weights.bin",
        "cache": "cache/removal-fixture.bin",
        "logs": "deployments/removal-fixture/runtime.log",
        "settings": "registry-backup-123.sqlite3",
    }
    external = root / "external-import.gguf"
    external.write_bytes(b"synthetic external model")
    unfamiliar = state / "unfamiliar.txt"
    unfamiliar.write_bytes(b"synthetic user-owned file")

    def seed():
        Store(state).put(
            "artifact",
            {"id": "cleanup-external", "source": "local", "local_path": str(external)},
        )
        for relative in fixtures.values():
            path = state / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic selected data")

    for selected in [*[[category] for category in fixtures], list(fixtures)]:
        seed()
        arguments = [f"/REMOVE{category.upper()}=1" for category in selected]
        execute(uninstaller + arguments + ["/CONFIRMDATAREMOVAL=1"])
        assert not (app / "Menagerie.exe").exists()
        for category, relative in fixtures.items():
            assert (state / relative).exists() == (category not in selected), (
                f"Incorrect cleanup category: {category}"
            )
        assert (state / "registry.sqlite3").exists() == ("settings" not in selected)
        assert external.read_bytes() == b"synthetic external model"
        assert unfamiliar.read_bytes() == b"synthetic user-owned file"
        install()

    # Reject a shared cache junction without touching its external target.
    Store(state)
    outside = root / "shared-model-cache"
    outside.mkdir()
    (outside / "keep.gguf").write_bytes(b"synthetic shared model")
    junction = state / "models/hf"
    junction.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["cmd.exe", "/c", "mklink", "/J", str(junction), str(outside)],
        env=env,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, (
        "Could not create synthetic junction for safety check"
    )
    try:
        result = execute(
            [
                app / "menagerie-cli.exe",
                "remove-data",
                "--state",
                str(state),
                "--remove",
                "models",
                "--confirm",
            ],
            success=False,
        )
        assert result.returncode != 0
        assert (outside / "keep.gguf").read_bytes() == b"synthetic shared model"
        assert (state / "registry.sqlite3").exists()
    finally:
        junction.rmdir()  # Remove only the junction, never its target.
    print(
        "PASS: interactive unchecked/cancel defaults, silent confirmation, five independent cleanup categories/all, external/unknown-file retention, junction refusal"
    )
