# Contributor guide

For installation and daily use, start with the [README](../README.md).
This page describes source development; [testing](testing.md) defines isolation
and opt-in checks, and [release validation](release-validation.md) defines release gates.

## Architecture

Menagerie contains a FastAPI daemon (`controlplane/`), a bundled React/Vite
dashboard (`frontend/`), and an OpenCode discovery plugin (`plugins/opencode/`).
The CLI is an HTTP client; the daemon owns model lifecycle. `Manager` serializes
admission and process ownership. `Store` uses SQLite WAL, revision checks, and
history. Serving deployments own shared loading/eviction policy; model instances
retain their engine configuration snapshots and stable aliases.

Backend API contracts are in `controlplane/schema.py`. Frontend wire decoders
are in `frontend/src/contracts.ts`; domain types are in `frontend/src/types/`.
Use the [frontend contributor reference](frontend-design-system.md) when changing
components, styling, contracts, or accessibility behavior.

### Serving deployment contracts

`deployment` records retain per-model process/history identities; `deployment_set`
owns membership and shared policy. Installed model artifacts are reusable; runtime
instances have a single lifecycle owner.

- `GET /api/serving-deployments` provides the unified serving view.
- `POST /api/deployment-sets` saves shared policy and inline `members`, with
  `name`, `alias`, `port`, and `configuration`. Existing members include their
  instance `id`; new members omit it. `?expected=REV` guards updates.
- `/api/serving-deployments/{id}/validate`, `/start`, `/stop`, and `/enabled`
  operate on complete serving units. User starts require the reviewed `plan_token`.
- `/api/deployment-sets/{id}/dissolve?expected=REV` separates unloaded members.

Member lifecycle actions expand to complete membership. Policy/enablement changes
on owned members are rejected; settings edits require the whole unit unloaded.
Review tokens include membership and policy revisions. Preserve atomic rollback,
independent aliases/ports for reused weights, and inactive history restoration.
See `tests/test_deployment_sets.py` and `tests/test_multi_configuration.py` for
fake-runtime regression coverage, not live GPU acceptance.

## Checks

Prerequisites: Python 3.12+, uv, Node.js 22+, npm, and Git. Install dependencies
through trusted channels. From the repository root:

```sh
uv sync --locked --no-install-project
uv run --no-sync ruff check .
uv run --no-sync ruff format --check .
uv run --no-sync python -m pytest -q
```

From `frontend/`:

```sh
npm ci
npm run check
npm run lint
npm run format:check
npm run build
npm test
npm run test:ui
```

The browser suite requires Playwright Chromium; provision it separately with
`npx playwright install chromium`. It starts its own loopback Vite server and
refuses an occupied port. No installed Menagerie daemon is needed.

From `plugins/opencode/`:

```sh
npm ci --ignore-scripts
npm run check
npm run lint
npm run format:check
npm test
```

Use Ruff/Prettier to format only files changed for the task. The package scripts
and `.github/workflows/checks.yml` are authoritative for the current check set.

## Dashboard iteration

From `frontend/`, run `npm run dev`. Vite has no API proxy. Use the browser
fixtures for UI-only work; do not point development tests at a personal daemon.
A checkout daemon serves `frontend/dist/`; build it before expecting the dashboard
to be available. An installed wheel contains its own dashboard assets.

From a checkout use `.venv/bin/menagerie` or `bin/menagerie` rather than an unrelated
global executable. Starting a daemon against real saved state is an operational
action, not a test prerequisite. Use temporary state and non-conflicting ports.

## Installed-artifact check

`uv build` builds the frontend and produces a wheel and source archive. Running
the wheel needs no Node. Create a fresh environment outside the checkout:

```sh
uv build
check_dir="$(mktemp -d)"
uv venv "$check_dir/venv"
uv pip install --python "$check_dir/venv/bin/python" dist/menagerie-2.1.4-py3-none-any.whl
"$check_dir/venv/bin/python" scripts/check_wheel.py
```

The checker uses temporary HOME/XDG/state and ephemeral ports. It verifies the
CLI, assets, API, plugin installation, export, diagnostics, backup, and shutdown
with synthetic telemetry and without loading models. Remove only the check
environment you created when done.

Check the source archive as well as the wheel. See [testing](testing.md)
before any installed-client, container, or live-inference check. Backend/plugin
catalog contracts must remain compatible; a plugin disk update does not reload
a running client server.

Version alignment, release artifacts and tag-triggered publication are described
in [releasing](releasing.md). Container deployment is documented in [Unraid](unraid.md).

## Native Windows packaging (contributors)

Build on Windows x64, with Node 22+, uv/Python 3.12, and Inno Setup 6.6+ available.
`uv build` produces the wheel with dashboard/plugin assets. Install that wheel and
the locked `windows-build` dependency group in an external packaging environment,
then run `scripts/build_windows.py` with that environment's Python. The script
freezes the installed package, not checkout imports. See the Windows job in
`.github/workflows/checks.yml` for the exact build contract.

The ordinary installer is emitted under `dist/windows/`; temporary PyInstaller
output belongs in ignored `build/windows/`. The GUI and CLI share a payload.
`scripts.check_windows_distribution` inspects text, nested archives and embedded
Menagerie code; human review of dependencies, licenses and binary provenance is
still required. Python and distribution license metadata travel with the payload.

CI also builds a private synthetic `0.0.0` installer with a distinct build manifest
to test in-place replacement. It is never a release asset and is not evidence of
compatibility with a historical Windows release. For a real baseline use
`scripts.check_windows --baseline PATH --installer PATH --worker PATH` with explicit
local inputs. The worker is a frozen `tests/fake_runtime.py`, never an inference
engine. Run this only in a disposable Windows test account: installer checks create
Start Menu/uninstall entries before cleaning them up.

### Optional uninstaller data removal

Inno Setup collects independent choices and invokes the bundled CLI only after
final uninstall confirmation, before application executables are removed. The
offline `remove-data` helper requires explicit categories and `--confirm`, verifies
state ownership, holds both launcher/daemon locks, preflights all selected paths,
and never obtains deletion targets from registry model/runtime records. Settings
are removed last, so an earlier file-removal failure retains recovery metadata.

Silent uninstaller flags are `/REMOVESETTINGS=1`, `/REMOVEENGINES=1`,
`/REMOVEMODELS=1`, `/REMOVECACHE=1` and `/REMOVELOGS=1`. Any such selection also
requires `/CONFIRMDATAREMOVAL=1`. Without those flags, silent uninstall retains
data. The CLI equivalent is `menagerie-cli.exe remove-data --state PATH --remove
CATEGORY --confirm`; repeat `--remove` for multiple categories. Valid categories
are `settings`, `engines`, `models`, `cache` and `logs`. Do not run these commands
against personal state as a verification shortcut.

Native installed checks verify unchecked interactive defaults/cancellation,
silent confirmation, each category and all categories together, retained external
models/unknown files, and refusal to follow a synthetic Windows junction. Unit
tests use isolated synthetic registries and cover consent, lock exclusion,
link handling, partial-failure recovery and category isolation. No real user data
is removed in ordinary verification.
