import hashlib
import subprocess
import sys
import tarfile
from pathlib import Path


def test_trial_bundle_contains_only_distribution_inputs(tmp_path):
    wheel = tmp_path / 'menagerie-2.0.0-py3-none-any.whl'
    wheel.write_bytes(b'trial-wheel')
    source = tmp_path / 'menagerie-2.0.0.tar.gz'
    source.write_bytes(b'trial-source')
    output = tmp_path / 'trial.tar.gz'
    subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'scripts/build_trial_bundle.py'), str(wheel), '--source', str(source), '--output', str(output)], check=True)
    with tarfile.open(output) as archive:
        members = archive.getnames()
        prefix = 'menagerie-linux-trial/'
        assert set(members) == {prefix + name for name in [wheel.name, source.name, 'install.sh', 'install', 'LICENSE', 'README.txt', 'SHA256SUMS', 'constraints.txt']}
        assert archive.extractfile(prefix + source.name).read() == b'trial-source'
        assert archive.extractfile(prefix + wheel.name).read() == b'trial-wheel'
        sums = archive.extractfile(prefix + 'SHA256SUMS').read().decode()
        assert sums.startswith(f'{hashlib.sha256(b"trial-wheel").hexdigest()}  {wheel.name}\n')
        assert 'constraints.txt' in sums and 'install.sh' in sums
        wrapper = archive.extractfile(prefix + 'install').read().decode()
        assert 'sha256sum --check SHA256SUMS' in wrapper
        assert '--wheel' in wrapper
        assert archive.getmember(prefix + 'install').mode == 0o755
