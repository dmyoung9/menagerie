<p align="center"><img src="frontend/public/logo.png" alt="Menagerie" width="520"></p>

# Menagerie

**Your models. One home. One endpoint.**

Download models, install inference engines, and run single- or multi-model
deployments from a local dashboard. Connect clients through an OpenAI-compatible
streaming gateway or the bundled OpenCode discovery plugin.

## Install

Linux is the initial target. Install the latest release directly:

```sh
curl -sSL https://raw.githubusercontent.com/dmyoung9/menagerie/main/install.sh | bash
```

Alternatively, to install from a local checkout or build a wheel:

```sh
git clone https://github.com/dmyoung9/menagerie.git
cd menagerie
uv build --wheel
bash install.sh --wheel dist/menagerie-2.0.0-py3-none-any.whl
```

The installer supplies an isolated Python environment and dependencies, then
offers a background user service, OpenCode plugin installation, and opening the
dashboard. Use `--yes` for unattended installation; optional actions require
`--service`, `--plugin`, or `--open`. No sudo or shell startup-file changes.

Run `~/.local/bin/menagerie serve`, or use the optional service. Open
**[127.0.0.1:8017](http://127.0.0.1:8017)**.

## Your first model

1. **Models → Discover:** search Hugging Face, choose a variant, and download.
   **+ Add from File** also accepts existing local GGUF files or safetensors folders.
2. Create a deployment and add the model. Install an engine from its configuration
   or **Settings → Engines**: llama.cpp for GGUF, vLLM for supported safetensors,
   or the Prism build for applicable ternary artifacts. Unknown models allow manual selection.
3. Choose context, concurrency, and residency; save and load. Settings use model
   metadata and memory estimates. CPU/RAM offload is an explicit, slower option.
   External memory use can still cause a launch to fail.
4. Send a request using the deployment's API alias:

```sh
curl http://127.0.0.1:8001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"my-model","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

## OpenCode

```sh
menagerie plugin install
```

Restart the owning OpenCode server. The plugin discovers deployment aliases and
capabilities without replacing unrelated client configuration. See
[OpenCode setup](docs/opencode.md).

## Operations and support

`menagerie doctor`, `status`, `backup`, and `--help` provide diagnostics and
operations. Re-running the installer upgrades in place and retains the previous
release; `bash install.sh --rollback` switches back to it. Engine updates install
alongside existing versions; choose the new version in a deployment before
removing its predecessor.

This is a single-user local application. NVIDIA is the GPU telemetry path;
drivers remain a host prerequisite. Windows/WSL and cross-distribution acceptance
are pending. See [installation and recovery](docs/installation.md),
[operations](docs/operations.md), and [release validation](docs/release-validation.md)
for verified coverage and remaining release gates.

## License

Menagerie is licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. See the [LICENSE](LICENSE) file for details.
