import os
import socket
import subprocess
from pathlib import Path

import pytest

from controlplane import telemetry
from scripts.check_support import isolated_environment, run_live_check


def test_check_environment_excludes_credentials_and_personal_configuration(
    tmp_path, monkeypatch
):
    for key in (
        "HF_TOKEN",
        "OPENAI_API_KEY",
        "OPENCODE_CONFIG_DIR",
        "HTTP_PROXY",
        "PYTHONPATH",
        "VITE_PRIVATE_VALUE",
    ):
        monkeypatch.setenv(key, "synthetic-private-value")
    env = isolated_environment(tmp_path / "child")
    assert "synthetic-private-value" not in env.values()
    assert env["HF_HUB_DISABLE_IMPLICIT_TOKEN"] == "1"
    for key in (
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "HF_HOME",
        "TMPDIR",
    ):
        assert Path(env[key]).is_relative_to(tmp_path / "child")
        assert Path(env[key]).is_dir()


def test_ordinary_suite_uses_synthetic_host_and_private_home(tmp_path):
    assert Path(os.environ["HOME"]).is_relative_to(tmp_path)
    assert telemetry.sample()["processes"] == []
    assert telemetry.sample()["gpus"] == []


def test_ordinary_suite_blocks_egress_and_non_loopback_bind():
    with pytest.raises(AssertionError, match="External network"):
        socket.getaddrinfo("example.test", 443)
    with socket.socket() as sock:
        for address in (("example.test", 443), ("192.0.2.1", 80)):
            with pytest.raises(AssertionError, match="External network"):
                sock.connect(address)
        with pytest.raises(AssertionError, match="External network"):
            sock.bind(("0.0.0.0", 0))
        sock.bind(("127.0.0.1", 0))


def test_live_check_requires_approval_before_launch(monkeypatch):
    monkeypatch.setattr("sys.argv", ["check"])
    with pytest.raises(SystemExit) as exc:
        run_live_check(None, "scripts.synthetic")
    assert exc.value.code == 2


@pytest.mark.parametrize("code", [0, 1])
def test_live_check_withholds_child_output(code, monkeypatch, capsys):
    monkeypatch.setenv("HF_TOKEN", "synthetic-private-value")
    monkeypatch.setattr("sys.argv", ["check", "--approve"])

    def run(command, *, env, stdout, stderr, cwd):
        assert "HF_TOKEN" not in env
        assert env["MENAGERIE_CHECK_CHILD"] == "scripts.synthetic"
        stdout.write(b"synthetic-private-value /private/output")
        return subprocess.CompletedProcess(command, code)

    monkeypatch.setattr(subprocess, "run", run)
    if code:
        with pytest.raises(SystemExit, match="raw output withheld"):
            run_live_check(None, "scripts.synthetic")
    else:
        run_live_check(None, "scripts.synthetic")
    assert "synthetic-private-value" not in capsys.readouterr().out
