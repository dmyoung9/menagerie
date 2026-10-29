import hashlib
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from controlplane.telemetry import gpu_process_usage
from scripts.prepare_release import validate_version

ROOT = Path(__file__).resolve().parents[1]


def test_container_pid_namespace_does_not_report_false_zero_gpu_usage():
    host = {"gpus": [{"index": 0}], "processes": [{"pid": 123, "gpu_mib": 64}]}
    assert gpu_process_usage(host, [123]) == 64
    assert gpu_process_usage(host | {"gpu_process_attribution": False}, [123]) is None
    assert gpu_process_usage({"gpus": [], "processes": []}, [123]) is None


def test_release_versions_align():
    version = validate_version(ROOT)
    assert validate_version(ROOT, "v" + version) == version
    with pytest.raises(ValueError, match="Tag does not match"):
        validate_version(ROOT, "v0.0.0")


def test_mismatched_installer_blocks_release(tmp_path):
    for path in (
        "pyproject.toml",
        "frontend/package.json",
        "frontend/package-lock.json",
        "plugins/opencode/package.json",
        "plugins/opencode/package-lock.json",
        "controlplane/version.py",
        "install.sh",
        "deploy/unraid/menagerie.xml",
    ):
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / path, target)
    installer = tmp_path / "install.sh"
    installer.write_text(installer.read_text().replace("version=", "version=0", 1))
    with pytest.raises(ValueError, match="Installer version mismatch"):
        validate_version(tmp_path)


def test_unraid_template_preserves_network_and_privilege_boundaries():
    template = ET.parse(ROOT / "deploy/unraid/menagerie.xml").getroot()
    assert template.findtext("Network") == "host"
    assert template.findtext("Privileged") == "false"
    assert "--user=99:100" in template.findtext("ExtraParams")
    assert "--cap-drop=ALL" in template.findtext("ExtraParams")
    paths = [c for c in template.findall("Config") if c.get("Type") == "Path"]
    assert [c.get("Target") for c in paths] == ["/data"]
    assert "/var/run/docker.sock" not in ET.tostring(template).decode()
    assert (
        template.find("Config[@Target='MENAGERIE_DASHBOARD_ADDRESS']").get("Default")
        == ""
    )


@pytest.mark.skipif(sys.platform != "linux", reason="Linux release installer")
def test_release_installer_rejects_corrupt_dependency_constraints(tmp_path):
    version = validate_version(ROOT)
    fixtures = tmp_path / "assets"
    fixtures.mkdir()
    wheel = fixtures / f"menagerie-{version}-py3-none-any.whl"
    wheel.write_bytes(b"synthetic wheel")
    (fixtures / (wheel.name + ".sha256")).write_text(
        hashlib.sha256(wheel.read_bytes()).hexdigest() + "  " + wheel.name + "\n"
    )
    requirements = fixtures / f"menagerie-{version}-requirements.txt"
    requirements.write_text("synthetic-package==1.0\n")
    (fixtures / (requirements.name + ".sha256")).write_text("0" * 64 + "\n")
    commands = tmp_path / "commands"
    commands.mkdir()
    curl = commands / "curl"
    curl.write_text(
        f"#!{sys.executable}\n"
        "import os,sys,shutil\nfrom pathlib import Path\n"
        "args=sys.argv[1:]; url=next(a for a in args if a.startswith('https://'))\n"
        "source=Path(os.environ['FIXTURE_ASSETS'])/url.rsplit('/',1)[1]\n"
        "shutil.copyfile(source,args[args.index('-o')+1])\n"
    )
    curl.chmod(0o755)
    env = dict(os.environ, HOME=str(tmp_path / "home"), FIXTURE_ASSETS=str(fixtures))
    env["PATH"] = str(commands) + os.pathsep + env["PATH"]
    result = subprocess.run(
        [
            "bash",
            str(ROOT / "install.sh"),
            "--yes",
            "--prefix",
            str(tmp_path / "app"),
            "--bin-dir",
            str(tmp_path / "bin"),
        ],
        env=env,
        text=True,
        capture_output=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "Dependency checksum mismatch" in result.stderr
    assert not (tmp_path / "app/releases").exists()
