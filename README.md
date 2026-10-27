<p align="center"><img src="frontend/public/logo.png" alt="Menagerie" width="520"></p>

# Menagerie

**Your models. One home. One endpoint.**

Menagerie is a single-host inference control plane. Download or add model weights,
register trusted inference engines, and run one or more models together with their
own settings. A local dashboard manages deployments; a streaming OpenAI-compatible
gateway connects them to your clients.

- **See your capacity:** GPU/RAM usage, deployment budgets, reserve, and activity.
- **Run models together:** independent settings and API aliases in a coordinated deployment.
- **Control residency:** pinned, on-demand, or explicitly evictable deployments.
- **Keep control:** local SQLite state, reviewed runtime commands, no cloud account required.

## Requirements and support

- Linux, Python **3.12+**, and [uv](https://docs.astral.sh/uv/).
- Building from source also needs **Node.js 22+ and npm**. Installed wheels include
  the dashboard and do not need Node.
- A compatible inference engine and sufficient model storage/RAM/VRAM. NVIDIA is
  the current GPU telemetry path; a working driver and `nvidia-smi` are recommended.
- Optional: systemd user services; Docker/Podman with a configured GPU runtime for OCI engines.

This is a **single-user, trusted-host application**, not an internet-facing or
multi-tenant service. Native llama.cpp/Prism, vLLM, SGLang, and custom/OCI launch
configuration are available; configuration support is not live-serving certification.
See [support and validation](docs/development.md#support-boundaries).

## Install and start

From source (the currently available installation path):

```sh
git clone https://github.com/dmyoung9/menagerie.git
cd menagerie
uv sync --locked
.venv/bin/menagerie serve
```

The package build installs frontend dependencies with `npm ci` and bundles the
dashboard automatically. No sudo, driver installation, runtime download, service
enablement, or model loading is performed by installation.

Open **[127.0.0.1:8017](http://127.0.0.1:8017)**. Keep the terminal running, or
follow the [optional user-service setup](docs/installation.md#run-as-a-user-service).

| Endpoint | Default URL |
| --- | --- |
| Dashboard | <http://127.0.0.1:8017> |
| OpenAI-compatible gateway | <http://127.0.0.1:8001/v1> |
| Control API reference | <http://127.0.0.1:8017/docs> |
| Prometheus metrics | <http://127.0.0.1:8017/metrics> |

## Serve your first model

1. **Models → Discover**: choose a model and a complete variant, then download.
   Already have weights? Choose **+ Add from File** and enter a GGUF file or
   safetensors directory **on the Menagerie host**. Files stay in place; this is
   not a browser upload.
2. **Settings → Engines**: register a trusted executable or a digest-pinned
   Docker/Podman image. Source builds require reviewing the repository, pinned
   commit, and exact commands. Menagerie does not install GPU drivers for you.
3. Choose **Create deployment** on your model. Set an API alias, engine, context,
   concurrency, and residency. For co-resident models, use **New deployment →
   Multiple models**. The memory preview is guidance, not an allocation guarantee.
4. Choose **Create & review launch**, inspect the capacity review, and approve
   loading. Or save without loading and launch later.
5. Use **Connect client** on Overview, or send a request using your chosen alias:

```sh
curl http://127.0.0.1:8001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

Replace `my-model` with the deployment's API alias. No API key is required on the
local gateway. Declare client capabilities explicitly; Menagerie does not infer
tool or multimodal support just because a model starts.

## Command line

With the source installation, use `.venv/bin/menagerie` in place of `menagerie`,
or activate the environment. Wheel tool installations put `menagerie` on PATH.

```sh
menagerie --help
menagerie doctor
menagerie status
menagerie deployments
menagerie start DEPLOYMENT_ID                 # review only
menagerie start DEPLOYMENT_ID --approve       # queue reviewed launch
menagerie stop DEPLOYMENT_ID                  # queue unload
menagerie backup
menagerie export-opencode
```

Commands return JSON; errors have nonzero exit codes. Use `--json` for JSON errors.
Launch/unload commands return queued jobs, **not proof of readiness**; follow the
dashboard's Activity view. `doctor` provides local diagnostics even if startup fails.

## OpenCode / OpenChamber

Install the bundled **OpenCode V2 discovery plugin**:

```sh
menagerie plugin install
opencode service restart
```

The plugin automatically registers the `menagerie` provider and refreshes model
aliases, capabilities, limits, and variants every 30 seconds. OpenChamber inherits
it when using that OpenCode server. Installation only writes the auto-discovered
`plugins/menagerie/` directory in your OpenCode config; unrelated JSON/JSONC and
model defaults are untouched. See [plugin installation and removal](docs/opencode.md).

Without the plugin, **Connect client → OpenCode → Export configuration**, or `menagerie export-opencode`,
writes a native OpenCode V2 provider fragment to
`~/.local/state/menagerie/opencode-managed.json`. Merge its `providers.menagerie`
entry into your client configuration without replacing unrelated settings, then
reload the client. Model references use `menagerie/<api-alias>`.

The fragment is also refreshed by `/v1/models`. Standard clients use that endpoint
for aliases; extended capability metadata is under each row's
`menagerie.catalog`. Dynamic capability discovery requires a compatible client
integration such as the bundled plugin—it is not implied by OpenAI compatibility.

The [monochrome logo](frontend/public/logo-mono.png) is included for client
integrators. OpenCode V2's documented custom-provider configuration does not expose
an icon setting; OpenChamber icon rendering needs separate client support. No
unsupported icon field is emitted.

## Documentation

- [Installation, upgrades, backups, and removal](docs/installation.md)
- [Daily operation, policies, storage, and security](docs/operations.md)
- [Multi-model deployments](docs/multi-model-deployments.md)
- [Model capabilities and reasoning presets](docs/model-capabilities.md)
- [OpenCode / OpenChamber plugin](docs/opencode.md)
- [Development, packaging, and acceptance checks](docs/development.md)
- [Security reporting](SECURITY.md)

**Distribution note:** a project license has not yet been selected. Public release
and redistribution terms remain a release blocker; do not assume an open-source license.
