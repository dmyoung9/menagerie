# Menagerie

A single-host inference control plane. Manage model artifacts, runtime installations,
and deployments containing one or more co-resident models with their own inference settings.
Serve them through one streaming OpenAI-compatible endpoint.

- **Dashboard:** http://127.0.0.1:8017
- **Gateway:** http://127.0.0.1:8001/v1
- **API reference:** http://127.0.0.1:8017/docs
- **Prometheus:** http://127.0.0.1:8017/metrics

## Daily operation

The dashboard shows loaded models, available capacity, and recent activity.
The primary views are **Overview**, **Models**, **Deployments**, **Activity**, and
**Settings**. No browser component controls a process directly.

1. In **Models**, import a local GGUF/safetensors directory or use **Discover** to browse the Hugging Face and public
   Ollama catalogs. Model cards show format, parameter and capability badges.
   **Choose variant** opens a modal with quantization and size/quality chips;
   unavailable combinations are disabled, single choices are selected
   automatically, and the footer downloads only a complete selection. Split GGUF
   shards are downloaded and registered as one variant. Hugging Face also exposes
   branches/tags, safetensors snapshots and linked quantization repositories.
   Ollama library tags can be viewed without a local engine; pulling them requires
   local Ollama. Local Ollama inventory is a separate view. Local files are
   referenced in place.
2. In **Settings → Engines**, register a trusted executable or digest-pinned Docker/Podman image. Native source
   builds require reviewing the exact HTTPS repository, commit and build commands.
3. Choose **Create deployment** on an installed model. Select an engine, context per
   request, concurrency, and operating mode. Advanced options include cache settings,
   GPU selection, arguments, and eviction authorization. Client capabilities are
   explicit, not inferred. Context per request is converted into the shared context
   pool for engines that divide it between parallel slots.
4. Choose **Create without loading** or **Create & review launch**. Creation saves
   an enabled deployment; the separate launch review checks capacity before loading.
   On-demand loading with uncertain estimates requires explicit permission.
5. A deployment can host one or more models. **New deployment → Multiple models**
   adds installed weights directly, with independent engine/settings and a unique
   API alias for each member. The same weights can be used in multiple deployments;
   no standalone deployment or profile is required first. Expand its row to inspect members.
   See [multi-model deployments](docs/multi-model-deployments.md) for configuration and policies.
6. Open a deployment for configuration, activity, and logs. Edit its model, engine,
   inference settings, and client capabilities directly; unload before saving changes.
   **Duplicate** creates an independent, initially inactive configuration to vary.
   No separate profile creation or update step is required. Immutable configuration
   revisions remain internal for history and recovery; existing records are preserved.
   The deployment name is the client catalog display name, and its API alias is the
   readable catalog key. Renaming does not change that alias; changing the alias
   requires updating clients that reference the old ID.
7. Use **Connect client** on Overview for the OpenAI-compatible endpoint and model
   alias. **Activity** contains operations, requests, sessions, and launch history.

Start with a downloaded model or local model files; no pre-existing configuration
is required.

## Architecture

Python/FastAPI + asynchronous HTTP streaming; SQLite WAL registry; React/TypeScript UI.

| Module | Responsibility |
|---|---|
| `controlplane/store.py` | Registry, immutable configuration revisions, sessions, events, backups |
| `controlplane/schema.py` | Typed control API records and host policy |
| `controlplane/adapters.py` | Binary probing, GGUF metadata, native/OCI argv, compatibility validation |
| `controlplane/manager.py` | Admission, coordinated lifecycle, process identity, recovery, residency |
| `controlplane/api.py` | CRUD/actions, SSE, gateway, request accounting, client integration |
| `controlplane/jobs.py` | Source builds, image pulls, pinned downloads and checksum verification |
| `controlplane/catalog.py` | Explicit capabilities and native OpenCode V2 catalog/config |
| `controlplane/telemetry.py` | NVIDIA fallback, host/process memory, CPU and swap |
| `frontend/` | Locally bundled web interface; no CDN dependencies |

## Policies and guarantees

- A host registry lock and serialized admission prevent concurrent reservations from
  bypassing capacity checks. Explicit reservations beyond physical capacity plus
  desktop reserve are hard errors. Unknown memory usage remains a warning/override.
- Reservations are **not physical GPU isolation**. External processes can consume
  memory. Estimates show confidence and provenance; session peaks are workload-specific.
- Startup requires at least 2 GiB free VRAM and 4 GiB available RAM. A newly loading
  runtime is rolled back if observed headroom/temperature crosses the configured gate.
- Pinned deployments are never automatically evicted. Idle, explicitly authorized
  evictable deployments can be stopped under pressure or for higher-priority demand.
  Resource pressure affecting pinned processes is visible, not a promise of OOM prevention.
- On-demand requests use bounded queues and timeouts. Multi-model deployments load,
  idle, and make room as one unit; a request to either alias loads the complete set.
  Busy members protect the entire deployment from unloading. Non-ready pinned deployments
  return structured errors. Full queues return 429; unavailable/loading failures 503.
- Readiness requires `/health` success and the expected model alias from `/v1/models`.
  Merely creating a process does not mark it ready. Process crash and health degradation
  are distinct states. Requests are sent only to READY deployments.
- Failed deployment starts stop newly launched processes, release reservations and attempt
  to restore explicitly stopped predecessors. Restoration failure is recorded, not
  concealed as a successful rollback. Active requests block ordinary stops/evictions.
- Native process identity includes PID, creation time and process-group identity.
  OCI cleanup checks Menagerie's ownership label before controlling a container.
- Upstream streams remain streamed; client cancellation closes the upstream connection.
  Request records retain correlation ID, deployment, latency, TTFT when observable,
  output tokens when reported, and errors. They do not store request prompts.

## Runtimes and evidence boundaries

Native upstream llama.cpp and Prism use probed `--help` options and separate adapter
identities. vLLM, SGLang, custom templates and Docker/Podman launch specifications are
available. Container images must use `@sha256:` digests; model/auxiliary mounts are
read-only, capabilities are dropped, ports bind to host loopback, and GPU mapping is
explicit. OCI GPU serving requires a correctly configured host GPU container runtime.

Supported launch configuration is not proof that every engine, image, model family,
or quantization works. Engine-specific live acceptance and host prerequisites are
recorded separately in [local installation notes](docs/local-installation.md).

Native source builds execute trusted third-party build code as this user after an
explicit command review. They do not run arbitrary downloaded installer scripts or
use sudo. Downloads pin revisions and verify checksums. Safetensors snapshots exclude
repository Python files; `trust-remote-code` is not enabled by adapters.

## OpenCode / OpenChamber

The existing `llama.cpp` provider can keep its endpoint and stable client IDs.
`GET /v1/models` publishes the explicit capability metadata consumed by
compatible discovery plugins, including context limits, aliases, and capabilities.

The managed fallback file is `~/.local/state/menagerie/opencode-managed.json`.
It is atomically refreshed on catalog reads or **Connect client → OpenCode → Export configuration**.
This is a native V2 provider fragment; it does not overwrite global user settings.
Clients without dynamic discovery must merge/use the fragment and may need a reload.
Do not combine static model overrides with the dynamic plugin unless intentionally
overriding its discovery behavior.

## Storage and history

Private state is under `~/.local/state/menagerie/`:

- `registry.sqlite3`: current registry, revisions, launch operations, sessions,
  request records and hardware samples.
- `deployments/<id>/runtime.log`: redacted, timestamped logs, rotated at 4 MiB with
  one previous file. The UI tails the last 64 KiB every two seconds while open.
- `models/`: managed Hugging Face cache with resume support.
- `runtimes/`: isolated reviewed source builds.
- `registry-backup-*.sqlite3`: explicit consistent online backups.
- Existing historical databases and snapshots remain untouched.

Hardware defaults to two-second samples, seven days high resolution and 90 days
retention, subject to a configurable 512 MiB logical-payload quota for each of
samples and requests. This is not a physical SQLite file-size limit. An explicit
telemetry purge is available in host policy settings. Older samples retain
per-minute memory and thermal extremes. Session and
configuration records are separate from metric retention. Runtime counters are
engine-supplied and must not be confused with per-request measurements.

Restoring a session creates an inactive deployment. Restoring an activation creates an inactive
deployment with new aliases and ports, allowing review before any disruptive loading.

## Development and checks

```sh
uv sync --locked
cd frontend
npm ci
npm run build
cd ..
.venv/bin/python -m pytest -q
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q
.venv/bin/python -m controlplane --state /tmp/opencode/menagerie-dev --port 8027 --gateway-port 8028
```

The old stdlib observatory remains in `menagerie.py` and its supporting files;
[its historical documentation](docs/legacy-observatory.md) is retained.

`tests/live_acceptance.py` is an explicit, non-pytest live runner. It makes real
requests against the named Bonsai pair. `--tune-pair` revises/restarts each paired
deployment and verifies that the other PID remains serving. It must not run in CI.

The gateway binds only to loopback. An optional `--dashboard-address` (or
`MENAGERIE_DASHBOARD_ADDRESS`) adds a dashboard listener on a specific private IPv4
address while preserving localhost access. The installed service enables this via
`menagerie.service.d/lan-dashboard.conf`. Inference routes are rejected on that LAN
socket, regardless of Host or forwarding headers. UI writes still require a current
same-origin token. The dashboard has no login/TLS and is intended for the trusted
household LAN; do not forward its port to the internet. OpenTelemetry is not configured.
Remove the LAN drop-in and reload/restart the user service to restore local-only access.

## UI acceptance

`smoke_product.js` exercises the UI against intercepted API fixtures: creation and
retry, context/concurrency mapping, memory approval, form preservation, dialog focus,
browser navigation, missing telemetry, mobile layouts, empty installation, and
disconnection. Run the frontend at `127.0.0.1:8037` with `npm run dev -- --port 8037`,
then use `playwright-cli run-code --filename=/absolute/path/to/smoke_product.js`.
All API traffic in this test is intercepted; no serving processes are changed.

`smoke_controlplane.js` checks the installed dashboard at `:8017` without mutations.
`smoke_multi_deployments.js` covers the unified multi-model workflow using isolated
API fixtures. `tests/test_deployment_sets.py` exercises coordinated fake runtimes.
`smoke_catalog.js` covers catalog selection; download submission is intercepted.
The older `smoke_browser.js` and `smoke_config_browser.js` target the historical
observatory, not the current product UI.

Historical live-serving evidence is in [local installation notes](docs/local-installation.md).

## Service and rollback

The supplied user-service definition is `menagerie-controlplane.service`.
For an installation registered as `menagerie.service`:

```sh
systemctl --user status menagerie.service
.venv/bin/python -m controlplane.cli doctor
.venv/bin/python -m controlplane.cli backup
journalctl --user -u menagerie.service -n 50
```

Host-specific rollback instructions are retained in the [local installation notes](docs/local-installation.md).
