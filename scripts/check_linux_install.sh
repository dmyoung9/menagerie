#!/usr/bin/env bash
# Opt-in disposable-container acceptance; never installs into the host HOME.
# Build wheel + sdist first with uv build, then pass the wheel.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
wheel="$(realpath "${1:?Pass the candidate wheel}")"
release_dir="$(mktemp -d /tmp/opencode/menagerie-release-assets-XXXXXX)"
trap 'rm -f "$release_dir/menagerie-2.0.0-py3-none-any.whl" "$release_dir/menagerie-2.0.0-py3-none-any.whl.sha256" "$release_dir/trial.tar.gz"; rmdir "$release_dir"' EXIT
# Private repositories cannot serve anonymous release downloads. Fetch the exact
# published assets with the owner's existing gh authorization; never pass tokens
# into the trial container or distribute them with the bundle.
gh release download v2.0.0 --repo dmyoung9/menagerie --pattern '*.whl*' --dir "$release_dir"
(cd "$release_dir" && sha256sum --check menagerie-2.0.0-py3-none-any.whl.sha256)
python3 "$root/scripts/build_trial_bundle.py" "$wheel" --source "${wheel%-py3-none-any.whl}.tar.gz" --output "$release_dir/trial.tar.gz"
docker run --rm -i --mount "type=bind,src=$root,dst=/source,readonly" \
  --mount "type=bind,src=$release_dir,dst=/release,readonly" \
  debian:bookworm-slim bash -s <<'CONTAINER'
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null
! command -v python3
! command -v node
! command -v git
! command -v uv
export HOME=/trial
mkdir -p "$HOME"
# Exercise published assets without exposing repository credentials to friends.
bash /source/install.sh --wheel /release/menagerie-2.0.0-py3-none-any.whl --yes --service --no-plugin --no-open
test -x "$HOME/.local/bin/menagerie"
! command -v menagerie
python="$HOME/.local/share/menagerie/app/current/bin/python"
"$python" /source/scripts/check_wheel.py
# Persist a real registry and referenced model sentinel across application swaps.
"$python" - <<'PY'
from pathlib import Path
from controlplane.store import Store
state = Path.home() / '.local/state/menagerie'
store = Store(state)
store.put('artifact', {'id': 'preserved', 'name': 'Preserved trial model'})
(state / 'model.gguf').write_bytes(b'preserve-model-data')
PY
# The candidate is a distinct content-addressed release even before a version bump.
tar -xzf /release/trial.tar.gz -C /trial
bash /trial/menagerie-linux-trial/install --yes
test -L "$HOME/.local/share/menagerie/app/previous"
"$python" /source/scripts/check_wheel.py
bash /source/install.sh --rollback
bash /source/install.sh --rollback
"$python" - <<'PY'
from pathlib import Path
from controlplane.store import Store
state = Path.home() / '.local/state/menagerie'
assert Store(state).get('artifact', 'preserved')['name'] == 'Preserved trial model'
assert (state / 'model.gguf').read_bytes() == b'preserve-model-data'
PY
# Follow documented manual uninstall, restricted to this disposable HOME.
rm "$HOME/.local/bin/menagerie"
rm -rf "$HOME/.local/share/menagerie/app"
test -f "$HOME/.local/state/menagerie/registry.sqlite3"
test "$(cat "$HOME/.local/state/menagerie/model.gguf")" = preserve-model-data
echo 'PASS: clean Debian install without Python/Node/Git/uv; published assets; no user service; candidate upgrade; two rollbacks; uninstall preserves registry/model data.'
CONTAINER
