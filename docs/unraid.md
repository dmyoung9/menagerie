# Unraid and containers

The container runs the dashboard, gateway and native managed engines together.
It needs no Docker socket, privileged mode, separate worker, or source checkout.
The initial image target is Linux x86_64. Actual Unraid and accelerator acceptance
must be verified separately; availability of the image is not GPU certification.

## Installation

Use the versioned `menagerie-unraid.xml` release asset as a user template in
Unraid's Docker template directory (for example,
`/boot/config/plugins/dockerMan/templates-user/my-menagerie.xml`), then select it
through **Add Container**.
This is a user template, not an approved Community Applications listing.

The repository and GHCR image are currently private. Arrange authorized registry
access through your normal private-registry configuration on the Docker host.
Do not put credentials in the template, container variables, screenshots, or
support reports. Private release assets require authorized access too. Nothing
in the release process changes package or repository visibility.

The template selects host networking, a version-pinned image, and UID/GID 99:100.
Set the dashboard address explicitly to the server's private LAN IPv4 address.
Prepare a persistent appdata directory writable by the selected UID/GID; the image
does not recursively change ownership of existing data. Generic Docker installs
default to UID/GID 1000:1000 and can override with `--user`.

All configuration, managed model weights, engines, logs, caches and backups live
under `/data`. Map that directory persistently. To use an existing model library,
add a separate read-only mapping to `/models` and register files by their container
paths. Never use ephemeral container storage for the only copy of your models.

## Networking and clients

- Host networking is intentional. Do not publish ports or bind the gateway to
  all interfaces. Dashboard/gateway ports default to 8017/8001; resolve conflicts
  before starting. `MENAGERIE_PORT` and `MENAGERIE_GATEWAY_PORT` change the ports;
  update the Unraid WebUI link accordingly.
- Without a dashboard address, both listeners are loopback-only. With the explicit
  private dashboard address, trusted LAN peers can administer the application.
  **There is no login or TLS.** Never expose it to the internet or untrusted peers.
- Inference routes on the LAN dashboard listener are denied. The gateway remains
  loopback-only. A client on the host or in a trusted host-network container uses
  `http://127.0.0.1:8001/v1`. A remote client needs an administrator-approved secure
  tunnel to that loopback endpoint; ordinary bridge containers cannot use their
  own localhost to reach the host gateway.
- The in-dashboard prompt test also requires loopback inference access. When
  administering over the LAN, use a local/tunneled dashboard for that test.

## CPU and NVIDIA

Start with a managed llama.cpp CPU engine for a driver-independent baseline.
For NVIDIA, install the appropriate host driver and Unraid container integration
first, then explicitly enable GPU passthrough (for example, `--gpus all` where
supported) and `NVIDIA_DRIVER_CAPABILITIES=compute,utility`. Menagerie does not
install or repair host drivers. Choose a managed CUDA engine only when its listed
driver requirements match the host.

Lack of Tensor cores does not imply that CUDA offload is impossible. Limited VRAM
may require a smaller model, smaller context, or CPU offload. Missing GPU telemetry
is unavailable data, not zero capacity or proof of an unsupported GPU. CPU,
acceleration and telemetry results must be recorded independently.
Global GPU metrics may be available while per-deployment GPU attribution is
unavailable: NVIDIA reports host PIDs, not the container's isolated PIDs. The image
does not request the host PID namespace just to obtain attribution. Host RAM
figures also do not certify a container's configured memory limit; launches can
fail under tighter Docker limits despite an optimistic host-based estimate.

## Updates, removal and recovery

Back up the registry before updating; it does not include model/runtime files.
Stop the container, pull a reviewed version, and recreate it with the same `/data`
mapping, UID/GID, network settings and GPU options. Allow up to 90 seconds for clean
shutdown. The image includes an init process for child reaping. Do not use the
Linux application installer or install a systemd service inside the container.

To roll back, select the retained image version. Confirm database compatibility or
restore a matching registry backup while all containers using that data are
stopped. Never run two Menagerie containers against the same state directory.
Deleting the container/image does not delete a bind-mounted appdata directory;
review data removal separately. Matching source is included at
`/usr/share/menagerie/source.tar.gz`, with the license alongside it.

## Target-host acceptance checklist

- Install the private image/template and reach the expected dashboard.
- Download a small model and CPU engine; complete first response, streaming,
  cancellation and unload. Verify clean shutdown with no remaining worker.
- Enable NVIDIA passthrough separately; probe the chosen engine and test offload.
  Record actual runtime/model/backend versions and limitations without raw logs,
  device identifiers, private paths or network details in public reports.
- Restart and replace the container; confirm configuration, models and engines
  persist and remain writable under the configured UID/GID.
- Verify LAN administration works only as intended, LAN inference is denied, and
  the gateway is reachable only through loopback or an approved tunnel.
- Report CPU serving, GPU acceleration and telemetry outcomes separately. Hosted
  CI checks cover container behavior with synthetic state, never real inference.
