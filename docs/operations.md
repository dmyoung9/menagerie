# Operation and safety boundaries

## Daily workflow

Overview shows deployments, capacity, and recent activity. GPU/RAM treemaps split
deployment usage, unattributed usage, protected reserve, and available capacity.
Select a block/legend to inspect it. Stale telemetry is labeled. GPU process
attribution is shown only on single-GPU hosts because process samples aggregate devices.

Models supports **Discover** (Hugging Face and public Ollama catalogs) and
**+ Add from File** (host-local GGUF or safetensors). Variant selection requires a
complete choice; split GGUF shards are registered together. Ollama library tags
are browsable without a local engine; pulling them requires local Ollama. Existing
files are referenced in place, not copied or uploaded by the browser.

Settings → Engines registers trusted executables, reviewed source builds, or
digest-pinned OCI images. No browser component controls processes directly.

Deployments have independent model settings and stable API aliases. Editing a
loaded deployment requires unloading. Duplicate creates an independent, inactive
configuration. Renaming does not change its alias; changing the alias requires
updating clients. Immutable revisions remain internal for history/recovery.
See [multi-model deployments](multi-model-deployments.md).

The composer previews the whole draft alongside existing usage and desktop reserve.
Context, concurrency, cache, and member changes update estimates without launching.
Context recommendations are soft guidance; layer metadata bounds GPU-layer inputs
when available. Reservations are displayed separately, never added to predicted
usage. Context per request is converted to a shared pool for engines that divide
it between parallel slots. Generic KV/overhead estimates are low-confidence for
hybrid models, CPU offload, auxiliary models, and engine-owned pools. Predicted
offload RAM is not yet available. Launch review rechecks actual admission.

## Admission and lifecycle

- A host registry lock and serialized admission prevent competing reservations
  bypassing capacity checks. Reservations above physical capacity plus desktop
  reserve are errors; unknown memory estimates require explicit authorization.
- Reservations are **not physical GPU isolation**. External processes can consume
  memory; estimates and observed session peaks are workload-dependent.
- Default startup gates require 2 GiB free VRAM and 4 GiB available RAM. Newly
  loading runtimes roll back if observed headroom/temperature crosses the gate.
- Pinned deployments are never automatically evicted. Idle, explicitly authorized
  evictable deployments can be stopped for pressure/higher-priority demand.
  Pinned pressure is visible, not a guarantee against OOM.
- On-demand requests use bounded queues/timeouts. Multi-model deployments load,
  idle, and make room as a unit. Busy members protect the unit from unloading.
  Full queues return 429; unavailable/loading failures return structured 503 errors.
- Readiness requires `/health` success and the expected alias from `/v1/models`.
  A PID is not readiness. Crashes and degraded health are distinct states.
- Failed starts stop new processes, release reservations, and attempt to restore
  explicitly stopped predecessors. Failed restoration is recorded, not hidden.
  Active requests block ordinary stops/evictions.
- Native identity includes PID, creation time, and process group. OCI cleanup checks
  the ownership label before controlling a container.
- Streaming stays streamed; cancellation closes the upstream connection. Request
  records retain correlation ID, deployment, latency, observable TTFT/output tokens,
  and errors—not prompt bodies.

## Trust and security

Menagerie is a privileged application **within your user account**: it can execute
reviewed runtime/build commands, access your model files, download artifacts, and
control its deployments. It is not a sandbox against malicious model engines.

Source builds execute trusted third-party code after explicit repository/commit/
command review; no sudo or downloaded installer scripts are used. Downloads pin
revisions and verify checksums. Safetensors snapshots exclude repository Python;
adapters do not enable `trust-remote-code`.

OCI images require `@sha256:` digests; model/auxiliary mounts are read-only,
capabilities are dropped, GPU mapping is explicit, and runtime ports bind loopback.
Host GPU-container prerequisites remain the operator's responsibility.

Dashboard writes require a current same-origin token. There is no login/TLS or
multi-user authorization. Local processes and trusted LAN dashboard users can
administer it. Keep default loopback binding unless you understand the LAN exposure.
Do not publish runtime logs/diagnostics without checking them for sensitive data.
OpenTelemetry is not configured.

## Storage and retention

Default private state: `~/.local/state/menagerie/` (override with `--state` or
`MENAGERIE_STATE`).

| Path | Contents |
| --- | --- |
| `registry.sqlite3` | Registry, revisions, operations, sessions, requests, hardware samples |
| `deployments/<id>/runtime.log` | Redacted timestamped runtime logs; 4 MiB rotation plus one previous file |
| `models/` | Managed Hugging Face cache with resume support |
| `runtimes/` | Isolated reviewed source builds |
| `registry-backup-*.sqlite3` | Explicit consistent online registry backups |
| `opencode-managed.json` | Generated client provider fragment |

The UI tails the last 64 KiB of runtime logs every two seconds while open. Hardware
defaults to two-second sampling, seven days high resolution, and 90 days retention,
with a configurable 512 MiB **logical-payload** quota each for samples and requests.
That quota does not cap physical SQLite file size. Older samples retain per-minute
memory/thermal extremes. Explicit telemetry purge is in host settings; sessions
and configuration history are separate. Runtime counters are engine-supplied, not
per-request measurements.

Restoring a session creates an inactive deployment. Restoring an activation creates
an inactive deployment with new aliases/ports for review. Unrelated historical
files are not automatically removed. See [backup/recovery](installation.md#upgrade-and-rollback).
