import json
import subprocess
import sys
import urllib.error
from pathlib import Path

import pytest

from controlplane import cli, plugin_install, service


def test_cli_help_version_and_validation(capsys):
    with pytest.raises(SystemExit) as result:
        cli.main(["--help"])
    assert result.value.code == 0
    assert "plugin" in capsys.readouterr().out
    assert cli.parser().parse_args(["--port", "8027", "status"]).port == 8027
    assert cli.parser().parse_args(["status", "--port", "8028"]).port == 8028
    with pytest.raises(SystemExit):
        cli.main(["stop"])
    with pytest.raises(SystemExit):
        cli.main(["status", "--port", "0"])


def test_doctor_offline_does_not_create_state(tmp_path, monkeypatch, capsys):
    root = tmp_path / "missing/state"

    def offline(*args):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(cli.Client, "request", offline)
    assert cli.main(["doctor", "--state", str(root)]) == 1
    report = json.loads(capsys.readouterr().out)
    assert not report["daemon_reachable"]
    assert not root.exists()


def test_cli_errors_have_exit_codes_and_no_tracebacks(monkeypatch, capsys):
    def offline(*args):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(cli.Client, "request", offline)
    assert cli.main(["status", "--json"]) == 1
    assert "offline" in json.loads(capsys.readouterr().err)["error"]


def test_start_requires_explicit_approval(monkeypatch, capsys):
    calls = []

    def request(self, path, body=None):
        calls.append((path, body))
        return (
            {"errors": [], "plan_token": "reviewed"}
            if path.endswith("/validate")
            else {"id": "job"}
        )

    monkeypatch.setattr(cli.Client, "request", request)
    assert cli.main(["start", "deployment"]) == 1
    assert len(calls) == 1 and calls[0][0].endswith("/validate")
    assert cli.main(["start", "deployment", "--approve"]) == 0
    assert calls[-1][1] == {"plan_token": "reviewed"}


def test_service_install_preserves_unmanaged_and_requires_explicit_lifecycle(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    calls = []

    def systemctl(*args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(
            args, 0, "inactive\n" if "is-active" in args else "disabled\n", ""
        )

    monkeypatch.setattr(service, "systemctl", systemctl)
    state = tmp_path / "private state"
    installed = service.manage("install", state, 8027, 8028)
    unit = Path(installed["path"])
    assert state.is_dir() and "--port 8027" in unit.read_text()
    assert service.quote(sys.executable) in unit.read_text()
    assert calls == [("daemon-reload",)]
    service.manage("remove", state, 8027, 8028)
    assert not unit.exists() and state.exists()
    unit.write_text("# owned by somebody else")
    with pytest.raises(ValueError, match="unmanaged"):
        service.manage("install", state, 8027, 8028)
    assert unit.read_text() == "# owned by somebody else"


def test_service_install_can_pin_a_stable_interpreter_across_releases(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setattr(
        service,
        "systemctl",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, "inactive\n", ""),
    )
    state, interpreter = tmp_path / "state", tmp_path / "app/current/bin/python"
    first = service.manage("install", state, 8027, 8028, interpreter)
    text = Path(first["path"]).read_text()
    assert service.quote(interpreter) + " -m controlplane " in text
    assert service.quote(sys.executable) not in text
    # A later release installs the same unit, so an upgrade needs no manual removal.
    assert (
        service.manage("install", state, 8027, 8028, interpreter)["path"]
        == first["path"]
    )


def test_service_rejects_directive_injection():
    with pytest.raises(ValueError):
        service.unit("/path\nExecStart=bad", 8017, 8001)
    assert '"/path with space"' in service.unit("/path with space", 8017, 8001)


def test_plugin_install_update_remove_preserve_config_and_backups(tmp_path):
    config = tmp_path / "config"
    config.mkdir()
    original = '{// comments and unrelated settings\n"model":"other/model"}'
    (config / "opencode.jsonc").write_text(original)
    result = plugin_install.manage("install", config, 8028)
    target = Path(result["path"])
    assert (
        json.loads((target / "settings.json").read_text())["baseURL"]
        == "http://127.0.0.1:8028/v1"
    )
    assert plugin_install.manage("status", config)["installed"]
    updated = plugin_install.manage("install", config)
    assert Path(updated["backup"]).is_dir()
    removed = plugin_install.manage("remove", config)
    assert Path(removed["backup"]).is_dir() and not target.exists()
    assert (config / "opencode.jsonc").read_text() == original


def test_plugin_install_refuses_unmanaged_or_locally_edited_files(tmp_path):
    target = tmp_path / "plugins/menagerie"
    target.mkdir(parents=True)
    (target / "index.ts").write_text("user plugin")
    with pytest.raises(ValueError, match="unmanaged"):
        plugin_install.manage("install", tmp_path)
    assert (target / "index.ts").read_text() == "user plugin"
    other = tmp_path / "other"
    plugin_install.manage("install", other)
    edited = other / "plugins/menagerie/index.ts"
    edited.write_text("user edit")
    with pytest.raises(ValueError, match="edited"):
        plugin_install.manage("remove", other)
    assert edited.read_text() == "user edit"
