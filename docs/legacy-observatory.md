# Menagerie legacy observatory (retained reference)

A small, observation-first web console for the local Prism/llama.cpp shelf,
with a separately isolated, explicitly confirmed preset editor.
Python 3.12 stdlib, SQLite, vanilla JavaScript, and SVG charts. No packages,
containers, external fonts, CDN requests, proxy, or inference-path dependency.

## Use

Open **http://127.0.0.1:8017**. The model shelf shows effective settings,
disk/preset differences and process-lifetime metric averages. GPU & history shows
minimum free VRAM, maximum temperature, average power, and compute-process
attribution. Configuration lab projects memory from imported two-point KV fits.
Evaluation archive shows existing mechanical grades and individual outputs;
known-invalid files are hidden by default. Event timeline shows journal evidence.
**Preset editor** adds typed per-model drafts, an exact diff, guarded apply,
configuration history, and reviewed reverts. Viewing and drafting never load models.

**Current per-model shelf mode:** when `shelf/engines.toml` exists under the trial
directory, the dashboard reads authoritative `shelf/models/*.toml` through the
shelf's validator. The legacy INI editor is explicitly read-only, and its HTTP
draft/apply/revert routes and worker refuse legacy writes. Existing history and
drafts are retained. Edit model files and use `shelf_config.py check` / `apply`
instead; see `~/ai/qwen38-trials/shelf/README.md`. The legacy editor behavior below
still applies to installations without the new configuration directory.

```sh
python3 menagerie.py serve
python3 menagerie.py doctor
python3 menagerie.py status
python3 menagerie.py collect-once --state /tmp/opencode/menagerie-trial
python3 menagerie.py import
python3 -m unittest -v
```

Defaults: shelf at loopback port 8001, inputs in `~/ai/qwen38-trials`, own state
at `~/.local/state/menagerie`. `--trials`, `--state`, and `--port` override paths
and dashboard port. The router address is deliberately fixed. Data stays local,
but contains model paths and evaluation answers; treat the database as private.

## Observation boundary and non-waking metrics

- Collection only uses `GET /models`, `GET /props`, and reviewed-build
  `GET /metrics?model=…&autoload=false`. It never calls `/slots`, inference,
  model loading, reload or removal. Separately, an explicitly requested apply
  worker restarts the shelf and sends one bounded inference request.
- Metrics are enabled **only for `b10777-e3de71522`**. Reviewed source:
  [router](https://github.com/PrismML-Eng/llama.cpp/blob/e3de71522/tools/server/server-models.cpp),
  [metrics route](https://github.com/PrismML-Eng/llama.cpp/blob/e3de71522/tools/server/server-context.cpp),
  [idle handling](https://github.com/PrismML-Eng/llama.cpp/blob/e3de71522/tools/server/server-queue.cpp).
  The query disables router autoload, sleeping metrics use cached data, and metrics
  tasks do not reset idle timers. Per-slot requests lack these properties.
  Review all three behaviors before allowing another build; unknown builds still
  provide inventory and GPU history. No claim of compatibility from version alone.
- Fixed-loopback upstream, no HTTP redirects or environment proxies. Observation
  routes open history SQLite read-only. The four `/api/config/*` POST routes
  require exact same-origin Host/Origin, a process-local anti-CSRF token and bounded
  JSON bodies. Other write routes remain rejected. No CORS or external resources.
  This is **not owner authentication**: same-user local programs are trusted.
  Do not expose it beyond loopback or publish through a relay.
- Metrics scrapes reset Prism's averaging buckets. Cumulative counters remain
  intact, but concurrent external scrapers would share those short-window buckets.
  UI rates use cumulative counters, not those gauges.
- Compute process attribution uses `/proc/PID/cgroup`; graphics-only GPU allocations
  may be missing. Total GPU memory is the authoritative aggregate.

## Data and limitations

Ten-second sampling; per-minute incremental imports of existing GPU health logs
and recognized result JSONs. Model snapshots are retained seven days, GPU and
event history 90 days. Charts aggregate at query time to about 400 buckets, keep
free-memory minima and temperature maxima, and leave missing stretches visible.
No destructive rollup or arbitrary disk-size guarantee. Initial journal backfill
is limited to the last 4,000 source lines in seven days; incremental pages drain
oldest first. Archive versions are deduplicated by SHA-256 and kept indefinitely.
GPU log rotation is detected by inode and file truncation.

Imported grades lacking build IDs, exact request/config snapshots or prompt hashes
stay provenance-incomplete. File modification times are labelled as such, not run
times. Known `artifact-` and `pre-checker-fix` files are explicitly flagged invalid.
This is an archive, **not an eval runner**. General prompt execution, prompt A/B
experiments, tracing and benchmarks are deferred. Apply's tiny smoke request is
not an evaluation grade.

The lab uses `fixed_mib + mib_per_1k × context / 1024` and subtracts explicit other
allocations. Fits are historical process-memory measurements, not total GPU use.
Parallelism divides a fixed context pool; extra per-slot overhead is unknown.
No CPU-offload slider or throughput prediction: existing data cannot support it.
Original parallel/build provenance is missing, so even interpolation is not a
validated configuration. Guard thresholds shown are the current shelf's documented
2,048 MiB GPU, 4 GiB available RAM and 85 °C; they are not dynamically discovered.
System swap use is explicitly not the shelf's runtime-owned swap guard.

## User service and recovery

```sh
mkdir -p ~/.local/state/menagerie
cp menagerie.service ~/.config/systemd/user/menagerie.service
systemctl --user link "$PWD/menagerie-apply@.service"
systemctl --user daemon-reload
systemctl --user enable --now menagerie.service
systemctl --user status menagerie.service
journalctl --user -u menagerie.service -n 30
```

The dashboard may write only its state directory. The on-demand worker template
has no autostart and may additionally write the trial directory (atomic replacement
requires directory write access). Its code fixes the target to `shelf.ini`, never
takes shell commands or arbitrary paths from requests, and revalidates queued
changes before service operations. It is a same-user isolation boundary, not a
privilege separation from other programs already running as the owner.
The dashboard does not depend on the shelf being up. Existing lingering is unchanged.
Stop without losing any history:

```sh
systemctl --user disable --now menagerie.service
```

Wait for any `menagerie-apply@…` job to finish before an offline backup, then stop
the dashboard and copy its entire state directory. It now contains both
`history.sqlite3` and `control.sqlite3`, their WAL/SHM companions, and snapshots.
Use SQLite's backup API if backing up databases while running. Restarting the
dashboard never restarts the shelf or cancels an independently running apply.

## Preset editing and apply contract

1. Select an existing `shelf.ini` model, check only the fields to override, and
   **Create review draft**. The original file revision is retained while editing;
   background polls do not silently rebase a form. Reload explicitly after edits
   outside Menagerie. Unknown keys, comments, global defaults and paths are preserved.
2. Review the exact unified diff. No setting is applied by drafting. Allowed fields
   cover context, slots, K/V dtype, batch/threads, cache, idle sleep, reasoning token
   budget and sampling. Existing MoE offload is editable; generic paths, templates,
   global router residency and safety constants are not.
3. Pause **every** client and wait for all models to sleep/unload. Check the
   maintenance acknowledgement, type **RESTART SHELF**, then click Apply. This
   stops the whole shelf, destroys KV caches, and loads the selected model for a
   smoke request. There is no force/busy override. Apply only supports the reviewed
   Prism build and the default installed state/preset paths.
4. The worker rechecks the file hash and effective baseline, snapshots the original,
   temporarily pauses the watchdog timer/oneshot to avoid competing recovery,
   stops the shelf, checks startup headroom (14,000 MiB GPU and 4 GiB available RAM),
   replaces the file atomically, starts the shelf, checks resolved settings and
   runs a bounded 512-output-token request. During validation it samples 2,048 MiB
   GPU / 4 GiB available RAM / 85 °C gates; the existing shelf safety supervisor
   and its process-swap guard are never disabled or weakened.
5. Success records build, full candidate checksum, resolved options/argv, exact
   smoke request and prompt hash, response/usage and sampled headroom. A short
   smoke can fail from a reasoning-only answer exhausting its 512-token budget;
   this causes rollback, not a claim that the configuration is intrinsically bad.
   Near-limit context retrieval and quality remain unverified.
6. Verification failure attempts to stop the candidate, restore the original bytes,
   restart the original preset, and restore the watchdog's prior active state.
   Rollback does not run another inference request. External file edits are never
   overwritten: a conflict leaves the shelf stopped and shows **recovery required**.
   Such a job blocks further applies until recovery is resolved.
7. **Review revert** on a successful job creates another diff for explicit approval.
   It only works if the current file is still that job's candidate revision.

No client catalogue is edited. Reducing context or adding slots requires reconciling
OpenCode and other clients' advertised per-slot limits before resuming them.
Numeric ranges are input limits, not proof a configuration will fit; memory
estimators are not a safety certification. Pausing clients is essential: a new
external request can race the last quiet check and service stop.

Drafts and jobs persist in `control.sqlite3`, with full original/candidate texts.
Per-job originals are also copied privately to `snapshots/ID.ini` before stopping.
A SQLite unique active-job constraint and a process file lock prevent overlapping
applies/recovery. Durable phase updates precede side effects. The worker's
`ExecStopPost` handles interrupted processes independently of the dashboard.
Sudden power loss cannot run that hook: pending jobs remain visible and block new
applies; they are **not silently resumed after reboot**.

### Manual recovery

Pause clients first and inspect the job's diff, current `shelf.ini`, snapshot and
worker journal. For a stranded active job after power loss:

```sh
python3 ~/Projects/menagerie/config_control.py recover ID
```

For a job marked `recovery_required`, first resolve the external edit or resource
problem deliberately, preserving any manual changes; then retry recovery:

```sh
python3 ~/Projects/menagerie/config_control.py retry ID
```

Both paths still refuse to overwrite a file whose hash is neither the saved
original nor the candidate. No broad reset, force-write or automatic downgrade is
provided. Inspect `journalctl --user -u 'menagerie-apply@ID.service'` for worker
startup/sandbox failures. Disabling Menagerie does not revert a successful preset
change: use Review revert or deliberate manual recovery.

## Verification

`python3 -m unittest -v` covers transaction failure/crash/conflict paths with fake
runtime operations and temporary files; no models are loaded. Existing browser
checks use Playwright CLI: `smoke_browser.js` covers the observatory,
`smoke_config_browser.js` exercises real drafting/discard and confirmation gates
without sending an apply request. Scripts must run in the CLI browser session's
working directory. A real worker preflight-recovery fixture also passed without
touching the shelf. Actual live apply/inference and full 24-hour observation
acceptance remain unperformed in this implementation session.
