"""Ordinary tests own their state and may connect only to loopback fixtures."""

import ipaddress
import os
import socket

import pytest
from huggingface_hub import constants as hub_constants

from controlplane import telemetry
from scripts.check_support import isolated_environment


@pytest.fixture(autouse=True)
def isolated_host(tmp_path, monkeypatch):
    env = isolated_environment(tmp_path / "environment")
    for key in tuple(os.environ):
        if key not in env:
            monkeypatch.delenv(key)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    # The SDK may have been imported during test collection, before env isolation.
    for key, value in {
        "HF_HOME": env["HF_HOME"],
        "HF_HUB_CACHE": str(tmp_path / "environment/cache/huggingface/hub"),
        "HF_ASSETS_CACHE": str(tmp_path / "environment/cache/huggingface/assets"),
        "HF_TOKEN_PATH": str(tmp_path / "environment/cache/huggingface/token"),
        "HF_STORED_TOKENS_PATH": str(
            tmp_path / "environment/cache/huggingface/stored_tokens"
        ),
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": True,
    }.items():
        monkeypatch.setattr(hub_constants, key, value)
    monkeypatch.setattr(
        telemetry,
        "sample",
        lambda: {
            "ts": 1,
            "cpu_count": 8,
            "cpu_percent": 0,
            "ram_total_mib": 32768,
            "ram_available_mib": 24000,
            "gpus": [],
            "processes": [],
            "errors": [],
        },
    )

    def permitted(address):
        if isinstance(address, tuple):
            host = address[0]
            if host == "localhost":
                return
            try:
                if ipaddress.ip_address(host).is_loopback:
                    return
            except ValueError:
                pass
        else:
            # asyncio uses local socket pairs; no network destination is involved.
            return
        raise AssertionError("External network access is forbidden in ordinary tests")

    for name in ("connect", "connect_ex", "bind", "sendto"):
        original = getattr(socket.socket, name)

        def guarded(sock, *args, _original=original, **kwargs):
            address = args[-1] if _original.__name__ == "sendto" else args[0]
            permitted(address)
            return _original(sock, *args, **kwargs)

        monkeypatch.setattr(socket.socket, name, guarded)

    resolve = socket.getaddrinfo

    def local_resolution(host, *args, **kwargs):
        permitted((host, 0))
        return resolve(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", local_resolution)
