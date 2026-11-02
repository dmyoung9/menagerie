# Operation and safety boundaries

## Daily workflow

Overview shows deployments, capacity, and recent activity. GPU/RAM treemaps split
deployment usage, unattributed usage, and free capacity.
Select a block/legend to inspect it. Stale telemetry is labeled. GPU process
attribution is shown only on single-GPU hosts because process samples aggregate devices.

Models supports **Discover** (Hugging Face) and
**+ Add from File** (host-local GGUF or safetensors). Variant selection requires a
complete choice; split GGUF shards are registered together. Existing
files are referenced in place, not copied or uploaded by the browser.

Settings → Engines installs versioned llama.cpp/Prism release binaries or an
isolated vLLM environment. Downloads, verification, and probing appear in Activity.
Updates install alongside existing engines; deployments retain their chosen version.
Referenced engines cannot be removed. Existing executables, source builds, and
digest-pinned OCI images are available from the engine toolbar.

Deployments have independent model settings and stable API aliases. The
**Configuration** tab is the editor; **Advanced** contains raw settings. Editing a
loaded deployment requires unloading. Duplicate creates an independent, inactive
configuration. Renaming does not change its alias; changing the alias requires
updating clients. Immutable revisions remain internal for history/recovery.
See [multi-model deployments](multi-model-deployments.md).

The composer previews the whole draft alongside existing usage and safety headroom.
Context, concurrency, cache, and member changes update estimates without launching.
Known runtime/model constraints bound inputs; estimated capacity does not. The
backend rejects known-invalid model limits and batch/cache combinations, not
over-budget drafts. llama.cpp's context is a shared pool
across parallel slots. CPU/RAM offload is explicit and slower, with approximate RAM
requirements shown where placement is known. The engine allocates memory according
to its own configuration. Hybrid architectures, engine buffers and internal
weights/cache/projector splits remain unavailable without instrumentation; no
overhead or margin is invented. Launch review rechecks actual admission.

Overview shows each GPU separately, OS-available RAM, a process ownership filter,
and live memory/activity/temperature trends. Decode throughput appears only when
reported by the runtime. Select a deployment block or its label to open its detail
page. GPU trend charts identify each device with a legend. Deployment performance
charts include retained runs of the same configuration, with gaps between runs.
Deployment/model details show retained GPU and RSS peak summaries, grouped by
configuration, with measured counts, mean/max and dates. **Settings → History**
contains formatted individual-run and telemetry-sample tables.
Failed/partial runs are included; history is not a promise of future memory fit.

**Activity → Events** groups lifecycle steps into expandable operations with links
to their resources and logs. **Requests** records individual inference calls;
deployment details also offer a scoped Requests tab. **Models → Downloads** shows
model transfer progress and history. Historical configuration-copy actions are
not part of these views. Older measurements or event details that were not
recorded appear as an em dash. Unloaded deployment VRAM is **N/A**.

External monitoring systems can scrape **`/metrics`** in Prometheus text format.
It reports GPU measurements, gateway waiting count, deployment readiness and active
requests. This integration endpoint is separate from the built-in dashboard charts.

## Admission and lifecycle

- Menagerie does not reserve memory. Resource previews show free GPU/RAM, file
  sizes and observed configuration-specific peaks (or metadata-derived file/KV
  accounting when there are no measurements). Over-budget labels are advisory,
  not failure predictions or approval checkboxes. Unknown measurements stay unknown.
- Default startup gates require 2 GiB free VRAM and 4 GiB available RAM. Newly
  loading runtimes roll back if observed headroom/temperature crosses the gate.
- Manual and client-triggered launches do not require uncertainty permission.
  Manual review still requires approval of proposed unloads.
- Pinned deployments are never automatically evicted. Idle, explicitly authorized
  evictable deployments can be stopped for pressure/higher-priority demand.
  Pinned pressure is visible, not a guarantee against OOM.
- On-demand requests use bounded queues/timeouts. Multi-model deployments load,
  idle, and make room as a unit. Busy members protect the unit from unloading.
  Full queues return 429; unavailable/loading failures return structured 503 errors.
- Ready means the runtime responds successfully and advertises the expected model.
  A running process alone is not readiness. Crashes and degraded health are distinct states.
- Failed starts stop new processes, report captured engine errors, and attempt to restore
  explicitly stopped predecessors. Failed restoration is recorded, not hidden.
  Active requests block ordinary stops/evictions.
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

| Path                           | Contents                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `registry.sqlite3`             | Registry, revisions, operations, sessions, requests, hardware samples                             |
| `deployments/<id>/runtime.log` | Timestamped runtime logs with limited credential filtering; 4 MiB rotation plus one previous file |
| `models/`                      | Managed Hugging Face cache with resume support                                                    |
| `runtimes/`                    | Isolated reviewed source builds                                                                   |
| `registry-backup-*.sqlite3`    | Explicit consistent online registry backups                                                       |
| `opencode-managed.json`        | Generated client provider fragment                                                                |

Credential filtering does not make logs safe to publish: paths, host details, or
unrecognized secret formats may remain. Review any excerpt privately before sharing.

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
