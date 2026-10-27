# Release validation

This checkout is not yet a published or fully accepted release.

## Verified in this implementation pass

- Built a wheel containing the dashboard, logos, and OpenCode plugin.
- Ran `install.sh --wheel … --yes` into an isolated prefix and launcher directory.
  The pinned, SHA-256-verified uv bootstrap installed managed Python 3.12 and the
  application dependencies without a system Python prerequisite.
- Discovered and installed upstream llama.cpp **b11913 Linux x86_64 CPU** through
  Menagerie's managed installer, verified the published SHA-256, and probed its
  executable (335 advertised flags).
- Downloaded `ggml-org/models`' `tinyllamas/stories15M-q4_0.gguf` at a resolved
  repository revision, created a CPU deployment, and received a nonempty HTTP 200
  chat completion through Menagerie's gateway. This is lifecycle evidence, not a
  recommendation of this tiny model for chat quality.
- Installed upstream llama.cpp **b11913 Linux x86_64 CUDA 12.8** with its cudart
  companion archive through the managed installer, verified both SHA-256 digests,
  probed 335 flags, and enumerated `CUDA0: NVIDIA GeForce RTX 5060 Ti`. A
  `Qwen3.5-9B Q4_K_M` deployment with all layers on the GPU served a chat
  completion through the gateway at about 69 generated tokens/s.
- Installed Prism **prism-b10826-c9c34bc CUDA** and served a ternary
  `Ternary Bonsai 2 9B PQ2_0` deployment on the GPU at about 131 generated
  tokens/s through the gateway. Unloading returned GPU memory to its baseline.
- Installer upgrade retained the prior release as `previous`; `--rollback`
  round-tripped between releases, and the generated unit runs
  `<prefix>/current/bin/python` so an upgrade or rollback needs only a restart.
  A foreign or unmanaged unit is refused and left untouched.
- `scripts/check_wheel.py` passed against the rebuilt wheel: CLI, bundled
  dashboard and logos, health, gateway catalog, export, doctor, and backup.
- Browser product smoke passed: creation/editing, launch without memory approval,
  failure preservation, navigation, mobile layouts, and empty-installation states.
- Installed-wheel lifecycle check passed: referenced-engine removal was blocked;
  after unloading and removing its configuration, engine files were removed while
  model weights remained intact.
- A transient systemd user service using the shipped sandbox settings became
  active, served its loopback API, and completed a managed CPU engine install.
  The verification unit was stopped and collected afterward.
- Real OpenCode V2 standalone request through the installed discovery plugin and
  Menagerie gateway passed with Qwen2.5-0.5B-Instruct Q4_K_M (model revision
  `9217f5db79a29953eb74d5343926648285ec7e67`): one gateway request, ten generated
  tokens, and a visible greeting in the client. Repeat with
  `TMPDIR=/tmp/opencode .venv/bin/python -m scripts.smoke_opencode`.
  This opt-in check downloads weights and runs an isolated CPU engine.
- Automated coverage includes archive escape rejection, checksum failure cleanup,
  installation collision preservation, engine probing/removal, metadata constraints,
  peer-preserving memory budget validation, and stable service-unit generation.

## Still required before release acceptance

- User-service and upgrade/rollback/removal acceptance across the supported
  distribution matrix; the local checks above cover this desktop only, on
  x86_64 with a single NVIDIA GPU.
- Complete architecture-aware estimates for hybrid models and vLLM's reservation
  behavior; current estimates are approximate.
- License decision and authorized publication of installer, wheel, and matching
  `.whl.sha256` release asset. The installer's default download URL cannot work
  until those assets exist; `--wheel` is the verified pre-publication path.

Release discovery is live upstream discovery, not a certification that every new
upstream build has been tested. Installs are versioned and probed; deployment
compatibility remains specific to the artifact, engine build, and host.
