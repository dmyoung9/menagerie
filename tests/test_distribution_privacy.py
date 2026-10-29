import io
import tarfile
import zipfile

import pytest

from scripts.check_distribution import inspect_archive


def archive(tmp_path, files):
    path = tmp_path / "source.tar.gz"
    with tarfile.open(path, "w:gz") as output:
        for name, content in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            output.addfile(entry, io.BytesIO(content))
    return path


def test_synthetic_sources_and_product_security_examples_are_allowed(tmp_path):
    path = archive(
        tmp_path,
        {
            "docs/security.md": b"Use loopback. No login or TLS. State: ~/.local/state/menagerie",
            "tests/network.py": b"fixture = '192.168.0.10'; token = 'fixture-token'",
        },
    )
    assert inspect_archive(path) == []


@pytest.mark.parametrize(
    "name,content,category",
    [
        ("docs/setup.md", b"/" + b"home/example/private", "personal home path"),
        ("METADATA", b"hf_" + b"X" * 32, "credential-like literal"),
        (
            "docs/report.md",
            b"Host: Example OS, kernel 1, driver 2",
            "development-host report",
        ),
        (".env", b"synthetic", "private/generated member"),
        ("test-results/trace.zip", b"synthetic", "private/generated member"),
        ("../unsafe", b"synthetic", "unsafe archive path"),
    ],
)
def test_private_content_is_rejected_without_echoing_values(
    tmp_path, name, content, category
):
    # Use a non-archive capture extension so it tests the member policy alone.
    name = name.replace("trace.zip", "capture.txt")
    findings = inspect_archive(archive(tmp_path, {name: content}))
    assert any(category in finding for finding in findings)
    assert not any(content.decode() in finding for finding in findings)


def test_nested_wheel_metadata_is_inspected(tmp_path):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as wheel:
        wheel.writestr("package.dist-info/METADATA", b"hf_" + b"X" * 32)
    findings = inspect_archive(archive(tmp_path, {"package.whl": data.getvalue()}))
    assert findings == ["distribution/nested archive: credential-like literal"]
