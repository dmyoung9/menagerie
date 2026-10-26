# Menagerie

A single-host inference control plane. Manage model artifacts, runtime installations,
versioned profiles, independently supervised deployments and co-resident groups.
Serve them through one streaming OpenAI-compatible endpoint.

- **Dashboard:** http://127.0.0.1:8017
- **Gateway:** http://127.0.0.1:8001/v1
- **API reference:** http://127.0.0.1:8017/docs
- **Prometheus:** http://127.0.0.1:8017/metrics

## Daily operation

The default dashboard shows live GPU/host capacity, resident models and operational
events. Models, Runtimes, Profiles, Deployments, History and Settings provide the
corresponding management workflows. No browser component controls a process directly.

1. Import a local GGUF/safetensors directory or browse the Hugging Face and public
   Ollama catalogs. Model cards show format, parameter and capability badges.
   **Choose variant** opens a modal with quantization and size/quality chips;
   unavailable combinations are disabled, single choices are selected
   automatically, and the footer downloads only a complete selection. Split GGUF
   shards are downloaded and registered as one variant. Hugging Face also exposes
   branches/tags, safetensors snapshots and linked quantization repositories.
   Ollama library tags can be viewed without a local engine; pulling them requires
   local Ollama. Local Ollama inventory is a separate view. Local files are
   referenced in place.
2. Register a trusted executable or digest-pinned Docker/Podman image. Native source
   builds require reviewing the exact HTTPS repository, commit and build commands.
3. Create a profile with the runtime's typed options and explicit client capabilities.
   Advanced arguments are argv entries, never shell expressions. Supervisor-owned
   networking, routing and artifact flags cannot be overridden.
4. Create a deployment with a stable alias, runtime port and residency policy.
   A deployment snapshots the selected profile revision. Editing a profile alone
   does not restart or change an existing deployment.
5. Validate and activate an individual deployment or ordered group. Review estimates,
   errors and authorized disruptions. Stop before updating a deployment's profile.

### Installed daily-driver configuration

The original five shelf profiles and client identities were imported. A separate
**Bonsai 27B + 9B resident pair** uses 32,768-token context pools, one slot each,
q8_0 KV caches and 8,192-token client output limits. Both use the existing pinned
Prism binary and its isolated CUDA 12.8 libraries. Original 128K profiles are retained.

The pair is pinned. Manual stops remain stopped; deployments that were pinned and
running at daemon shutdown are restored on startup with their saved admission policy.
Other imported deployments are disabled and absent from client discovery until
explicitly enabled. Importing weights/profiles does not deploy them. Enabled
on-demand deployments remain discoverable while unloaded. Their launches require
an explicit uncertainty override. Use group authorized stops to deliberately switch
away from the pinned pair.

## Architecture

Python/FastAPI + asynchronous HTTP streaming; SQLite WAL registry; React/TypeScript UI.

| Module | Responsibility |
|---|---|
| `controlplane/store.py` | Registry, immutable configuration revisions, sessions, events, backups |
| `controlplane/schema.py` | Typed control API records and host policy |
| `controlplane/adapters.py` | Binary probing, GGUF metadata, native/OCI argv, compatibility validation |
| `controlplane/manager.py` | Admission, lifecycle, process identity, groups, recovery, residency |
| `controlplane/api.py` | CRUD/actions, SSE, gateway, request accounting, client integration |
| `controlplane/jobs.py` | Source builds, image pulls, pinned downloads and checksum verification |
| `controlplane/catalog.py` | Explicit capabilities and native OpenCode V2 catalog/config |
| `controlplane/importer.py` | Read-only per-model shelf migration, without executing shelf Python |
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
- On-demand requests use bounded queues and timeouts. Non-ready pinned deployments
  return structured errors. Full queues return 429; unavailable/loading failures 503.
- Readiness requires `/health` success and the expected model alias from `/v1/models`.
  Merely creating a process does not mark it ready. Process crash and health degradation
  are distinct states. Requests are sent only to READY deployments.
- Failed group starts stop newly launched processes, release reservations and attempt
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

Live acceptance on this desktop covered **Prism/Bonsai**, not every engine/image or
model family. The Docker installation currently lacks a registered NVIDIA runtime;
GPU-container inference is not validated. Podman is not installed. Registering a
runtime or accepting its flags is not proof every architecture or quantization works.

Native source builds execute trusted third-party build code as this user after an
explicit command review. They do not run arbitrary downloaded installer scripts or
use sudo. Downloads pin revisions and verify checksums. Safetensors snapshots exclude
repository Python files; `trust-remote-code` is not enabled by adapters.

## OpenCode / OpenChamber

The existing `llama.cpp` provider can keep its endpoint and stable client IDs.
`GET /v1/models` publishes the same explicit shelf-v2 capability contract consumed
by the installed discovery plugin. The running OpenChamber backend was checked
against Menagerie's published context limits and aliases; no client restart was needed.

The managed fallback file is `~/.local/state/menagerie/opencode-managed.json`.
It is atomically refreshed on catalog reads or **Settings → Export config**.
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
- Existing `history.sqlite3`, `control.sqlite3` and `snapshots/` remain untouched.
  **History → Legacy archive** reads the old imported observation results.

Hardware defaults to two-second samples, seven days high resolution and 90 days
retention, subject to a configurable 512 MiB logical-payload quota for each of
samples and requests. This is not a physical SQLite file-size limit. An explicit
telemetry purge is available in host policy settings. Older samples retain
per-minute memory and thermal extremes. Session and
configuration records are separate from metric retention. Runtime counters are
engine-supplied and must not be confused with per-request measurements.

Restoring a session creates a new profile. Restoring an activation creates a disabled
group with new aliases and ports, allowing review before any disruptive activation.

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

## Acceptance on this host

- 28 control-plane tests and the TypeScript/Vite build passed. The earlier
  implementation also passed 43 legacy tests.
- Catalog modal checks passed for chip selection, automatic single-variant
  selection, split-shard submission and a 390px mobile viewport. Real split
  download and launch remain unverified.
- All seven UI pages passed desktop/mobile checks, including typed profile editing.
- Both pinned Bonsai deployments passed concurrent inference, tool calls, complete
  streaming, cancellation with slot reuse, independent restarts and daemon recovery.
- Simultaneous 30,446-token retrieval prompts passed on both models. Minimum sampled
  free VRAM was 2,864 MiB; maximum sampled GPU temperature was 75°C. These are
  workload-specific acceptance results, not a general quality or throughput benchmark.
- Active OpenChamber discovery preserved aliases and reported the 32K context limits.
- GPU-container/vLLM/SGLang inference remains unvalidated on this host as described above.

## Service and rollback

The enabled user unit remains named **`menagerie.service`**. Its current source is
`menagerie-controlplane.service`; the old observatory unit is preserved in state.
The old shelf unit, sources, configuration, weights and watchdog remain installed,
but the shelf and watchdog timer are stopped and disabled to avoid boot collisions.

```sh
systemctl --user status menagerie.service
.venv/bin/python -m controlplane.cli doctor
.venv/bin/python -m controlplane.cli backup
journalctl --user -u menagerie.service -n 50
```

Return serving to the old shelf without deleting Menagerie or any model data:

```sh
systemctl --user disable --now menagerie.service
systemctl --user enable --now llama-shelf.service llama-shelf-watchdog.timer
```

To restore the old dashboard too, first stop Menagerie, restore
`~/.local/state/menagerie/menagerie-observatory.service.backup` to
`~/.config/systemd/user/menagerie.service`, run `systemctl --user daemon-reload`,
then enable/start the restored dashboard. It uses the untouched legacy databases.
Restore its CLI target as well:

```sh
ln -sfn "$HOME/Projects/menagerie/menagerie.py" "$HOME/.local/bin/menagerie"
```
