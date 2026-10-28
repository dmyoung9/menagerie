"""Build a shareable Linux trial archive; does not publish or include user state."""
import argparse
import hashlib
import io
from pathlib import Path
import tarfile
import subprocess


def build(wheel: Path, source: Path, output: Path):
    root = Path(__file__).resolve().parents[1]
    if not wheel.name.endswith('-py3-none-any.whl') or not wheel.is_file():
        raise ValueError('Pass a built Menagerie wheel')
    if not wheel.name.startswith('menagerie-'):
        raise ValueError('Not a Menagerie wheel')
    if source.name != wheel.name.replace('-py3-none-any.whl', '.tar.gz') or not source.is_file():
        raise ValueError('Pass the matching Menagerie source distribution')
    constraints = subprocess.check_output(['uv', 'export', '--locked', '--no-dev', '--no-emit-project', '--no-hashes'], cwd=root)
    files = {
        wheel.name: wheel.read_bytes(),
        source.name: source.read_bytes(),
        'install.sh': (root / 'install.sh').read_bytes(),
        'LICENSE': (root / 'LICENSE').read_bytes(),
        'constraints.txt': constraints,
        'install': f'''#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
sha256sum --check SHA256SUMS
exec bash ./install.sh --wheel './{wheel.name}' --constraints ./constraints.txt "$@"
'''.encode(),
        'README.txt': b'''Menagerie Linux trial
Extract this entire folder, then run: bash ./install
No Python, Node, Git, or source checkout required. Internet is still required
for managed Python, application dependencies, engines, and models.
Requires glibc Linux x86_64/aarch64, Bash, curl, tar, sha256sum and GNU utilities.
GPU drivers are a host prerequisite. CPU is also available.
The installer prints an absolute command to start the dashboard. Keep its
terminal open; Ctrl+C stops it. Start the same command to reopen saved state.
Then use Overview > Get your first response. No OpenCode needed.
For unattended installation: bash ./install --yes
For updates: extract the new archive and run its installer; data is preserved.
For rollback: bash ./install.sh --rollback
For removal: stop Menagerie; if its optional service was installed, run
systemctl --user disable --now menagerie.service, then
~/.local/bin/menagerie service remove. Remove the optional client plugin with
~/.local/bin/menagerie plugin remove if installed. Remove only the installer
symlink ~/.local/bin/menagerie and application directory
~/.local/share/menagerie/app. Keep ~/.local/state/menagerie to retain models,
engines, and configuration. Custom prefixes/state require their selected paths.
The checksum detects corruption, not publisher identity; obtain the archive
from someone you trust. License: AGPL-3.0-or-later (see LICENSE).
The matching source distribution is included for inspection and modification;
it is not needed to install/run the application. See its README/development docs.
''',
    }
    files['SHA256SUMS'] = ''.join(f'{hashlib.sha256(files[name]).hexdigest()}  {name}\n' for name in [wheel.name, source.name, 'constraints.txt', 'install.sh']).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, 'w:gz') as archive:
        for name, content in files.items():
            entry = tarfile.TarInfo('menagerie-linux-trial/' + name)
            entry.size, entry.mode, entry.mtime = len(content), 0o755 if name == 'install' else 0o644, 0
            archive.addfile(entry, io.BytesIO(content))
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wheel', type=Path)
    parser.add_argument('--source', type=Path, required=True, help='Corresponding source distribution from the same uv build')
    parser.add_argument('--output', type=Path, default=Path('dist/menagerie-linux-trial.tar.gz'))
    args = parser.parse_args()
    build(args.wheel, args.source, args.output)
