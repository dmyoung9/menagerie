#!/usr/bin/env bash
# Opt-in installer acceptance in a disposable container. No host installation.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
baseline="$(realpath "${1:?Pass baseline wheel and candidate wheel}")"
candidate="$(realpath "${2:?Pass candidate wheel}")"
[[ -f "$baseline" && -f "$candidate" ]] || { echo 'Both wheels must exist.' >&2; exit 2; }
[[ "$(sha256sum "$baseline" | cut -d ' ' -f 1)" != "$(sha256sum "$candidate" | cut -d ' ' -f 1)" ]] || {
  echo 'Use distinct baseline and candidate artifacts to exercise upgrade.' >&2; exit 2;
}
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/baseline" "$work/candidate"
cp -- "$baseline" "$work/baseline/"
cp -- "$candidate" "$work/candidate/"
cp -- "$root/install.sh" "$root/scripts/check_wheel.py" "$root/scripts/check_support.py" "$work/"
docker run --rm -i --mount "type=bind,src=$work,dst=/inputs,readonly" \
  debian:bookworm-slim bash -s <<'CONTAINER'
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null
! command -v python3
! command -v node
! command -v git
! command -v uv
export HOME=/installation-check
mkdir -p "$HOME"
bash /inputs/install.sh --wheel /inputs/baseline/*.whl --yes --service --no-plugin --no-open
test -x "$HOME/.local/bin/menagerie"
python="$HOME/.local/share/menagerie/app/current/bin/python"
"$python" /inputs/check_wheel.py
"$python" - <<'PY'
from pathlib import Path
from controlplane.store import Store
state = Path.home() / '.local/state/menagerie'
store = Store(state)
store.put('artifact', {'id': 'preserved', 'name': 'Synthetic model'})
(state / 'model.gguf').write_bytes(b'preserve-model-data')
PY
bash /inputs/install.sh --wheel /inputs/candidate/*.whl --yes --no-service --no-plugin --no-open
test -L "$HOME/.local/share/menagerie/app/previous"
"$python" /inputs/check_wheel.py
bash /inputs/install.sh --rollback
bash /inputs/install.sh --rollback
"$python" - <<'PY'
from pathlib import Path
from controlplane.store import Store
state = Path.home() / '.local/state/menagerie'
assert Store(state).get('artifact', 'preserved')['name'] == 'Synthetic model'
assert (state / 'model.gguf').read_bytes() == b'preserve-model-data'
PY
rm "$HOME/.local/bin/menagerie"
rm -rf "$HOME/.local/share/menagerie/app"
test -f "$HOME/.local/state/menagerie/registry.sqlite3"
test "$(cat "$HOME/.local/state/menagerie/model.gguf")" = preserve-model-data
echo 'PASS: isolated install, upgrade, rollback, and uninstall preserve synthetic data.'
CONTAINER
