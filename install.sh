#!/usr/bin/env bash
# Menagerie user-space installer. No sudo and no shell startup-file edits.
set -euo pipefail
umask 077

prefix="${XDG_DATA_HOME:-$HOME/.local/share}/menagerie/app"
bin_dir="$HOME/.local/bin"
version=2.1.4
wheel='' constraints=''
service=ask plugin=ask open=ask
unattended=false rollback=false
usage() {
  cat <<'EOF'
Usage: bash install.sh [options]
  --wheel PATH          Install a locally built wheel (before publication)
  --constraints PATH    Use release dependency constraints
  --version VERSION     Release version (default: 2.1.4)
  --prefix PATH         Application directory
  --bin-dir PATH        CLI launcher directory
  --service | --no-service   Enable/start the systemd user service
  --plugin | --no-plugin     Install the bundled OpenCode plugin
  --open | --no-open         Open the local dashboard
  --rollback            Switch back to the previously installed application
  --yes                 Noninteractive; unspecified optional actions are skipped
Existing models and state are preserved. Updates keep the previous application.
EOF
}
while (($#)); do
  case "$1" in
    --wheel|--version|--prefix|--bin-dir|--constraints)
      (($# >= 2)) || { usage >&2; exit 2; }
      key="${1#--}"; key="${key//-/_}"; printf -v "$key" '%s' "$2"; shift 2 ;;
    --service) service=yes; shift ;; --no-service) service=no; shift ;;
    --plugin) plugin=yes; shift ;; --no-plugin) plugin=no; shift ;;
    --open) open=yes; shift ;; --no-open) open=no; shift ;;
    --rollback) rollback=true; shift ;;
    --yes) unattended=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$(uname -s)" == Linux ]] || { echo 'This installer currently supports Linux.' >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Use a release version such as 2.1.4.' >&2; exit 2; }
if [[ -n "$constraints" ]]; then
  [[ -f "$constraints" ]] || { echo 'Dependency constraints file not found.' >&2; exit 1; }
  constraints="$(realpath "$constraints")"
fi
for command in curl tar sha256sum mktemp; do
  command -v "$command" >/dev/null || { echo "Required utility missing: $command" >&2; exit 1; }
done
mkdir -p "$prefix" "$bin_dir"
prefix="$(cd "$prefix" && pwd -P)"
bin_dir="$(cd "$bin_dir" && pwd -P)"
launcher="$bin_dir/menagerie"
if [[ -e "$launcher" || -L "$launcher" ]]; then
  [[ -L "$launcher" && "$(readlink "$launcher")" == "$prefix/current/bin/menagerie" ]] || {
    echo "An unrelated launcher exists at $launcher. Choose another --bin-dir." >&2; exit 1;
  }
fi
if [[ -e "$prefix/current" && ! -L "$prefix/current" ]]; then
  echo 'Application current path is not an installer-owned symlink.' >&2; exit 1
fi
if [[ ( -e "$prefix/current" || -L "$prefix/current" || -e "$prefix/previous" || -L "$prefix/previous" ) && ! -f "$prefix/.menagerie-installer" ]]; then
  echo 'Existing application pointers have no Menagerie installer ownership marker.' >&2; exit 1
fi
work="$(mktemp -d "$prefix/.install-XXXXXX")"
created=''
cleanup() { rm -rf -- "$work"; if [[ -n "$created" ]]; then rm -rf -- "$created"; fi; }
trap cleanup EXIT

if $rollback; then
  [[ -L "$prefix/current" && -L "$prefix/previous" ]] || {
    echo 'No previous application is retained; nothing to roll back to.' >&2; exit 1;
  }
  current="$(readlink "$prefix/current")"
  previous="$(readlink "$prefix/previous")"
  [[ -d "$previous" && -f "$previous/.complete" ]] || {
    echo "Previous application is incomplete: $previous" >&2; exit 1;
  }
  # Swap the pointers so a later --rollback returns to the newer application.
  ln -s "$previous" "$work/current"
  ln -s "$current" "$work/previous"
  mv -Tf "$work/current" "$prefix/current"
  mv -Tf "$work/previous" "$prefix/previous"
  "$prefix/current/bin/menagerie" --version
  if command -v systemctl >/dev/null && systemctl --user is-enabled --quiet menagerie.service 2>/dev/null; then
    exec_path="$(systemctl --user cat menagerie.service 2>/dev/null | sed -n 's/^ExecStart=//p' | head -n1 | awk '{print $1}' | tr -d '"')"
    ours=false
    if [[ -n "$exec_path" ]]; then
      resolved="$(realpath -m -- "$exec_path")"
      if [[ "$resolved" == "$(realpath -m -- "$launcher")" || "$resolved" == "$prefix/"* ]]; then ours=true; fi
    fi
    if $ours; then
      if systemctl --user is-active --quiet menagerie.service 2>/dev/null; then
        systemctl --user restart menagerie.service
        echo 'Restarted menagerie.service on the restored application.'
      else
        echo 'Start menagerie.service to run the restored application: systemctl --user start menagerie.service'
      fi
    else
      echo 'menagerie.service runs a different installation; it was left untouched.' >&2
    fi
  fi
  echo "Rolled back: $prefix/current -> $previous"
  echo "The newer application remains at $prefix/previous."
  exit 0
fi

if [[ -z "$wheel" ]]; then
  url="https://github.com/dmyoung9/menagerie/releases/download/v$version/menagerie-$version-py3-none-any.whl"
  echo "Downloading Menagerie $version…"
  curl -fLSs "$url" -o "$work/menagerie-$version-py3-none-any.whl" || {
    echo 'Release wheel unavailable. Before publication, build a wheel and use --wheel PATH.' >&2; exit 1;
  }
  curl -fLSs "$url.sha256" -o "$work/expected.sha256"
  digest="$(cut -d ' ' -f 1 "$work/expected.sha256")"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid release checksum.' >&2; exit 1; }
  wheel="$work/menagerie-$version-py3-none-any.whl"
  [[ "$(sha256sum "$wheel" | cut -d ' ' -f 1)" == "$digest" ]] || { echo 'Release checksum mismatch.' >&2; exit 1; }
  if [[ -z "$constraints" ]]; then
    constraints="$work/menagerie-$version-requirements.txt"
    requirements_url="${url%/*}/menagerie-$version-requirements.txt"
    curl -fLSs "$requirements_url" -o "$constraints" || {
      echo 'Release dependency constraints unavailable; use matching release assets or --wheel with explicit local inputs.' >&2; exit 1;
    }
    curl -fLSs "$requirements_url.sha256" -o "$work/requirements.sha256"
    digest="$(cut -d ' ' -f 1 "$work/requirements.sha256")"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid dependency checksum.' >&2; exit 1; }
    [[ "$(sha256sum "$constraints" | cut -d ' ' -f 1)" == "$digest" ]] || { echo 'Dependency checksum mismatch.' >&2; exit 1; }
  fi
else
  [[ -f "$wheel" ]] || { echo "Wheel not found: $wheel" >&2; exit 1; }
  wheel="$(realpath "$wheel")"
fi

# Pin the bootstrap tool and verify its upstream release digest before execution.
case "$(uname -m)" in
  x86_64) target=x86_64-unknown-linux-gnu; uv_hash=f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645 ;;
  aarch64) target=aarch64-unknown-linux-gnu; uv_hash=229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d ;;
  *) echo 'Managed bootstrap supports Linux x86_64 and aarch64.' >&2; exit 1 ;;
esac
curl -fLSs "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-$target.tar.gz" -o "$work/uv.tar.gz"
[[ "$(sha256sum "$work/uv.tar.gz" | cut -d ' ' -f 1)" == "$uv_hash" ]] || { echo 'Bootstrap checksum mismatch.' >&2; exit 1; }
tar -xzf "$work/uv.tar.gz" -C "$work"
uv="$work/uv-$target/uv"
export UV_PYTHON_INSTALL_DIR="$prefix/python"
export UV_CACHE_DIR="$prefix/cache"
export UV_NO_CONFIG=1
digest="$(sha256sum "$wheel" | cut -d ' ' -f 1)"
if [[ -n "$constraints" ]]; then
  # The installed environment identity includes its dependency selection.
  digest="$(printf '%s\n%s\n' "$digest" "$(sha256sum "$constraints" | cut -d ' ' -f 1)" | sha256sum | cut -d ' ' -f 1)"
fi
release="$prefix/releases/$digest"
if [[ ! -d "$release" ]]; then
  mkdir -p "$prefix/releases"
  mkdir "$release"
  created="$release"
  "$uv" venv --python 3.12 --managed-python "$release"
  dependency_args=()
  if [[ -n "$constraints" ]]; then dependency_args=(--constraint "$constraints"); fi
  "$uv" pip install --python "$release/bin/python" "${dependency_args[@]}" "$wheel"
  "$release/bin/menagerie" --version
  "$release/bin/python" -I -c 'from pathlib import Path; import controlplane; assert (Path(controlplane.__file__).parent / "static/index.html").is_file(), "Wheel lacks dashboard assets"'
  touch "$release/.complete"
elif [[ ! -f "$release/.complete" ]]; then
  echo "Incomplete installation at $release; inspect it before retrying." >&2; exit 1
fi
previous="$(readlink "$prefix/current" 2>/dev/null || true)"
if [[ -n "$previous" && "$previous" != "$release" ]]; then
  ln -s "$previous" "$work/previous"
  mv -Tf "$work/previous" "$prefix/previous"
fi
ln -s "$release" "$work/current"
mv -Tf "$work/current" "$prefix/current"
touch "$prefix/.menagerie-installer"
created=''
if [[ ! -L "$launcher" ]]; then ln -s "$prefix/current/bin/menagerie" "$launcher"; fi

choose() {
  local value="$1" prompt="$2" answer
  if [[ "$value" != ask ]]; then [[ "$value" == yes ]]; return; fi
  if $unattended; then return 1; fi
  if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then return 1; fi
  printf '%s [y/N] ' "$prompt" >/dev/tty
  read -r answer </dev/tty || return 1
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]]
}
if choose "$service" 'Run Menagerie in the background at login?'; then
  if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
    echo 'No systemd user session is available. Installation is complete; use the foreground command below.' >&2
  elif "$prefix/current/bin/python" -I -m controlplane.cli service install --interpreter "$prefix/current/bin/python"; then
    # An upgrade requires an explicit restart to run the selected application.
    if systemctl --user enable menagerie.service && systemctl --user restart menagerie.service; then
      echo 'Started menagerie.service.'
    else
      echo 'Service activation failed; the application is installed. Inspect systemctl --user status menagerie.service, or use the foreground command below.' >&2
    fi
  else
    echo 'Service setup did not complete; the application itself is installed.' >&2
    echo 'Resolve the message above, then run: menagerie service install' >&2
  fi
fi
if choose "$plugin" 'Install the OpenCode discovery plugin?'; then "$launcher" plugin install; fi
if choose "$open" 'Open the dashboard?'; then
  if curl -fsS http://127.0.0.1:8017/health >/dev/null; then
    if ! command -v xdg-open >/dev/null || ! xdg-open http://127.0.0.1:8017/; then
      echo 'Open http://127.0.0.1:8017/ in your browser.'
    fi
  else
    echo 'Start Menagerie with: menagerie serve. Then open http://127.0.0.1:8017/'
  fi
fi
echo "Installed: $launcher"
printf 'Start in a terminal: %q serve\n' "$launcher"
echo 'Keep that terminal open; press Ctrl+C to stop. Dashboard: http://127.0.0.1:8017/'
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to PATH, or use the full launcher path." ;; esac
if [[ -n "$previous" && "$previous" != "$release" ]]; then
  echo "Previous application retained at $prefix/previous; switch back with: bash install.sh --rollback"
fi
