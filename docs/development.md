# Development and release checks

## Architecture

Python/FastAPI, asynchronous HTTP streaming, SQLite WAL, React/TypeScript.

| Module | Responsibility |
| --- | --- |
| `controlplane/store.py` | Registry, revisions, sessions, backups |
| `controlplane/schema.py` | Typed API records and host policy |
| `controlplane/adapters.py` | Probing, metadata, argv, compatibility |
| `controlplane/manager.py` | Admission, lifecycle, process identity, recovery |
| `controlplane/api.py` | CRUD/actions, gateway, SSE, accounting, client integration |
| `controlplane/jobs.py` | Reviewed builds, pinned downloads, image pulls |
| `controlplane/catalog.py` | Explicit capability metadata and OpenCode configuration |
| `controlplane/telemetry.py` | NVIDIA, host/process memory, CPU, swap |
| `controlplane/cli.py`, `service.py` | Operator CLI and optional user-service registration |
| `frontend/` | Bundled UI without CDN dependencies |

## Local checks

```sh
uv sync --locked
uv run --no-sync python -m pytest -q
uv build
uv venv /tmp/opencode/menagerie-wheel-check
uv pip install --python /tmp/opencode/menagerie-wheel-check/bin/python dist/menagerie-2.0.0-py3-none-any.whl
/tmp/opencode/menagerie-wheel-check/bin/python scripts/check_wheel.py
```

Use a fresh path for the wheel-check environment; don't overwrite an unrelated
environment. The artifact check runs outside the source checkout with temporary
state and ephemeral loopback ports. It checks the installed CLI, assets, API,
catalog export, diagnostics, and graceful shutdown, with no real model runtimes.

For frontend iteration:

```sh
cd frontend
npm ci
npm run dev -- --port 8037
```

Run `npm run build`, `npm test`, and `npm run test:ui` from `frontend/`.
The automated browser suite starts its own isolated Vite server on :8049 and
intercepts every API request; it never changes live serving processes. See the
[design-system guide](frontend-design-system.md) for the exact shadcn preset,
component ownership, regeneration policy, and desktop/mobile accessibility checks.
The ad-hoc fixture runners (`smoke_product.js`, forms, capabilities, resources,
and multi-model flows) can also be run with
`playwright-cli run-code --filename=/absolute/path/to/smoke_product.js` against
their documented fixture-server ports.
`smoke_first_run.js` checks first-response onboarding with missing telemetry,
streaming, failure/retry and mobile layout on :8037 (intercepts API and gateway).
For opt-in clean Linux trial installation, build wheel + sdist with `uv build`,
then run `bash scripts/check_linux_install.sh dist/menagerie-2.0.0-py3-none-any.whl`.
This uses a disposable Docker container and maintainer `gh` access to release
assets; it never installs into the host HOME and performs no inference.
`smoke_controlplane.js` is a read-only installed-dashboard check; do not run it
against an arbitrary deployment without reviewing its target.

The OpenCode plugin has separate SDK/type/behavior checks:

```sh
cd plugins/opencode
npm ci --ignore-scripts
npm run check
npm test
```

With OpenCode V2 installed, run `uv run --no-sync python -m scripts.check_opencode`
from the repository root for fresh-runtime acceptance. It installs the plugin in
temporary config, starts an isolated OpenCode server with separate HOME/XDG state,
and checks discovery against a fake local catalog. No real model request or user
configuration change is made. CI runs the SDK tests; this runtime check is opt-in.

## Support boundaries

Linux is the supported installation target. NVIDIA telemetry and native
Prism/Bonsai serving have historical development-host evidence. Native upstream
llama.cpp has its own probed adapter identity. vLLM, SGLang, custom templates,
Docker, and Podman have configuration/specification support; this is **not** a
claim of live acceptance for every engine, image, model family, or quantization.
Non-NVIDIA GPU serving and other operating systems are not certified.

Automated tests use fake runtimes and intercepted APIs. They cannot prove GPU
compatibility, thermal behavior, actual memory fit, or inference quality.

Explicit live inference check (never CI):

```sh
uv run --no-sync python tests/live_acceptance.py --alias MODEL_A --alias MODEL_B
```

This sends real requests and may trigger saved on-demand loading. It never revises
configuration. It only checks short concurrent responses; separately verify tools,
streaming, cancellation, long contexts, crash recovery, and engine-specific behavior
before claiming those combinations are supported.

## Release gate

- Backend tests and TypeScript/frontend build pass.
- Build sdist and wheel; verify assets and installed operation outside the checkout.
- Review changes to API metadata/client references and state compatibility.
- Test service registration/removal and upgrade/backup/restore on a disposable host
  before advertising unattended deployment. Existing service files are never overwritten.
- Record engine/model-specific live acceptance separately; do not run inference in CI.
- License is AGPL-3.0-or-later; review dependency/artwork distribution terms for each release.
- Publish reviewed versioned artifacts deliberately; CI does not publish automatically.

The version is currently `2.0.0`; keep Python, API, CLI, and frontend version strings
aligned when preparing a release.
