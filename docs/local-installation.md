# Local installation: historical acceptance

These notes describe the original development desktop, not product defaults or
the current live registry. Consult the running dashboard for current state.

## Imported configuration

The original five shelf profiles and client identities were imported. A separate
**Bonsai 27B + 9B resident pair** used 32,768-token context pools, one slot each,
q8_0 KV caches and 8,192-token client output limits. Both used a pinned Prism binary
and isolated CUDA 12.8 libraries. Original 128K profiles were retained.

The pair was pinned. Pinned deployments running at daemon shutdown are restored
on startup with their saved admission policy; manually stopped ones stay stopped.
Other imported deployments were disabled until explicitly enabled. Enabled
on-demand deployments remain discoverable while unloaded when host policy allows
it; uncertain launches require explicit authorization.

## Earlier serving acceptance

- Both pinned Bonsai deployments passed concurrent inference, tool calls, complete
  streaming, cancellation with slot reuse, independent restarts and daemon recovery.
- Simultaneous 30,446-token retrieval prompts passed on both models. Minimum sampled
  free VRAM was 2,864 MiB; maximum sampled GPU temperature was 75°C. These are
  workload-specific acceptance results, not a general quality or throughput benchmark.
- Active OpenChamber discovery preserved aliases and reported the 32K context limits.
- Live engine acceptance covered **Prism/Bonsai**, not every engine/image or model
  family. GPU-container/vLLM/SGLang inference was not validated on this host.
- The development Docker installation lacked a registered NVIDIA runtime; Podman
  was not installed. Registering a runtime is not evidence of successful inference.
- Earlier catalog modal checks covered chip selection, automatic single-variant
  selection, split-shard submission, and a 390px mobile viewport. Real split download
  and launch were not verified.

These results predate the product UX pass and are not evidence that new UI controls
have been used to launch models. Product smoke checks deliberately avoid live
inference changes.

## Original desktop rollback

These are historical instructions for the original development desktop, not a
product migration feature. Verify the installed units and paths before using them.

The original installation kept the previous shelf unit, sources, model files,
configuration, and watchdog. Its shelf service and watchdog timer were disabled
while Menagerie owned inference. Returning to that preserved installation used:

```sh
systemctl --user disable --now menagerie.service
systemctl --user enable --now llama-shelf.service llama-shelf-watchdog.timer
```

The original observatory unit was backed up at
`~/.local/state/menagerie/menagerie-observatory.service.backup`. Restoring it required
stopping Menagerie, restoring the unit to `~/.config/systemd/user/menagerie.service`,
running `systemctl --user daemon-reload`, then enabling/starting the restored unit.
Its databases were kept untouched. The old CLI target was restored with:

```sh
ln -sfn "$HOME/Projects/menagerie/menagerie.py" "$HOME/.local/bin/menagerie"
```
