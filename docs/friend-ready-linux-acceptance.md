# Linux installation and first-response acceptance — 2026-10-28

Scope: issues #10 and #11. This is not Windows, Unraid, ARM, Intel, AMD, or
cross-distribution GPU certification. Fresh-user feedback remains a separate #17
gate; agent-driven browser operation does not establish novice usability.

## Distribution finding and delivery

v2.0.0's wheel and checksum exist, but the repository is private. An unauthenticated
clean-container request to the advertised release URL returned HTTP 404. The
anonymous `curl | bash` path is not usable for friends today. Repository visibility
and published v2.0.0 assets were not changed.

The supported trial handoff is a generated `menagerie-linux-trial.tar.gz` containing
only the wheel and corresponding source distribution, installer/wrapper,
lock-exported dependency constraints, checksums, license and instructions.
Extract and run `bash ./install`. No repository token,
source checkout, user registry, logs or model files are included. This is an
online bootstrap, not an offline/self-contained executable. Generation does not
publish a release or change the installed daily-driver application.

## Clean installed-artifact acceptance

Run after building the candidate wheel and matching sdist with `uv build`:

```sh
bash scripts/check_linux_install.sh dist/menagerie-2.0.0-py3-none-any.whl
```

Passed in a disposable Debian bookworm-slim x86_64 container with only the minimal
OS utilities and curl/certificates installed. Explicitly verified Python, Node,
Git and uv absent before bootstrap. No host HOME, GPU or service configuration is
mounted. The maintainer retrieves and checks the existing private release assets
with `gh`; credentials are not passed to the container or trial bundle.

Verified:

- Published wheel install supplies managed CPython 3.12.16 and bundled dashboard.
- No systemd user session: requesting optional service setup explains the absence
  and still succeeds, printing a working absolute foreground command with no PATH
  edits required.
- Installed CLI, dashboard assets/logos, health, gateway catalog, plugin
  install/removal in isolated config, diagnostics and backup pass outside checkout.
- Upgrade from the published wheel to the candidate trial bundle checks wheel,
  constraints and installer digests. Constraints select locked dependency versions;
  the dependency selection participates in the application environment identity.
- Two rollback swaps succeed; registry entry and model-file sentinel survive.
- Removing only the owned application directory and launcher retains registry and
  model data. The disposable container is removed after the check.

## Development-host runtime and browser acceptance

Host: Pop!_OS 24.04 LTS, kernel 7.0.11-76070011-generic, NVIDIA GeForce RTX 5060 Ti
(16,311 MiB), driver 595.84. Test used private temporary application state and
separate loopback ports, not the daily-driver registry/listeners. Baseline free
VRAM was 13,785 MiB; the experiment maintained more than 12 GiB free, above a
2 GiB desktop-headroom gate. No existing model service was stopped or changed.

Using the real dashboard, starting from an empty registry:

1. Install managed upstream llama.cpp b11971 CUDA 12.8 with companion cudart.
   Executable reports build 11971, commit `74a4fb003`.
2. Choose the starter repository `Qwen/Qwen2.5-0.5B-Instruct-GGUF`, Q4_K + M.
   Resolved revision `9217f5db79a29953eb74d5343926648285ec7e67`, 491,400,032 bytes,
   SHA-256 `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`.
3. Create a deployment using the existing composer and recommended llama.cpp
   engine, context pool 8192, parallel 1, GPU layers all, q8_0 KV cache.
4. Review estimates, including a low-confidence warning, and load without a memory
   acknowledgment checkbox. Wait for Ready, not merely queued.
5. In Overview's first-response section, submit the default greeting prompt.
   The real gateway streamed a nonempty greeting into the browser. No OpenCode or
   separate client was involved. NVIDIA attributed approximately 594 MiB to the
   acceptance llama-server process. This is short-context workflow evidence, not
   a quality benchmark, maximum-context proof or complete backend certification.
6. Submit another prompt and cancel from the dashboard. The cancellation message
   appears; gateway inflight accounting returns empty.
7. Terminate the isolated daemon gracefully, restart with the same state, and
   verify the model/deployment remain registered and unloaded. Stop again; the
   test GPU process and loopback listeners disappear.

A separate transient user-systemd unit with the shipped sandbox policy reached
active/running and served health successfully on isolated ports; stopping it
removed its listeners. No login startup, lingering, installed user unit or boot
behavior was altered or newly certified.

## Automated and fixture evidence

- Backend suite plus trial-bundle and interrupted-download/retry coverage.
- Frontend TypeScript/build and stream-parser tests: fragmented UTF-8/CRLF SSE,
  upstream HTTP/stream errors, empty/truncated responses and cancellation.
- `smoke_first_run.js`: unavailable GPU/RAM telemetry, existing-model path,
  pre-ready test disabled, mobile layout, streamed result, actual-error display
  and retry (all fixture-backed).
- `smoke_product.js`: creation/editing, advisory launch warnings, focus/navigation,
  failure preservation, empty install, disconnection and five mobile views.
- OpenCode plugin typecheck and seven behavior checks; provider contract unchanged.

Interrupted download test confirms no partial artifact registration, retains the
completed shard, and successfully registers one complete artifact on retry.
Existing asynchronous job progress, cancellation, errors and deployment logs are
reused rather than introducing a parallel provisioning/lifecycle path.
