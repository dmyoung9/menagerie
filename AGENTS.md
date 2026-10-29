# Menagerie contributor instructions

Menagerie is a single-user, loopback-first inference control plane: FastAPI in
`controlplane/`, React/Vite in `frontend/`, and an OpenCode V2 discovery plugin in
`plugins/opencode/`. Read `docs/development.md` for checks/builds,
`docs/testing.md` before changing tests or running integration checks, and
`docs/release-validation.md` before preparing artifacts. For frontend components
or styling, also read `docs/frontend-design-system.md`.

## Scope and privacy

- Write user guides around supported tasks, limitations, and recovery. Put
  implementation details in clearly labeled contributor references. Verify claims
  against behavior; do not turn a development session into product documentation.
- Use synthetic examples and fixtures. Keep personal paths, machine/network
  identifiers, application inventories, authentication workflows, live screenshots,
  and raw diagnostics out of tracked files and distributable artifacts.
- Preserve user data and unrelated changes. Live inference, downloads of runtimes
  or models, installed-client checks, and container acceptance are opt-in actions;
  do not run them as routine verification. Never run inference in CI.
- Source archives include documentation and tests. Inspect nested artifacts as
  well as wheels before distribution. Correcting source does not sanitize old
  releases, CI uploads, or Git history; altering those requires separate approval.

## Checks

Use the package scripts and `.github/workflows/checks.yml` as the current check
contract. Backend checks include Ruff lint/format and pytest. Frontend checks
include typecheck, ESLint, Prettier, build, unit tests, and Playwright. The plugin
has separate type, lint, format, and behavior checks. Commands are in the
contributor guide; do not install global tools to substitute for project tooling.

`uv build` requires Node 22+/npm, builds the dashboard, and bundles the plugin.
Running an installed wheel needs no Node. Test installed artifacts in a fresh
environment outside the checkout, with temporary HOME/XDG/state and ephemeral
ports. From a checkout use `.venv/bin/menagerie` or `bin/menagerie`, not an
unrelated global installation. The Vite dev server has no API proxy.

Ordinary tests must not use the live registry or external services. Pass temporary
state to every `Store`/`create_app`; a bare `create_app()` uses real saved state.
Use fake telemetry/runtimes and mocked network APIs. Browser tests must use fresh
contexts, fixture responses, and a dedicated server that refuses occupied ports.
Keep captures under ignored test output; never attach a personal browser profile.

## Architecture invariants

- The CLI is an HTTP client. The daemon owns lifecycle; `Manager` owns admission,
  process identity, and start/stop. Change runtime state through its locking and
  lifecycle paths, not by editing registry rows behind its lock.
- `Store` uses SQLite WAL and optimistic revisions. API updates require the
  expected revision; keep history for editable records and use `historical=False`
  for high-churn operational state.
- A serving deployment owns one or more runtime instances and their shared policy.
  Each instance has one lifecycle owner; installed weights may be reused across
  deployments. Membership/settings edits require the unit unloaded. Configuration
  snapshots prevent later profile edits from changing existing deployments.
- User launches validate through `/api/serving-deployments/{id}/validate`, then
  start with its `plan_token` (CLI: `start ID --approve`). Preserve reviewed unload
  consent. Manual estimate warnings and saved on-demand uncertainty permission
  are different controls; do not conflate them.
- Non-GET `/api/*` calls require the current process token, same-origin checks,
  Content-Length, and bounded bodies. ASGI tests use `http://testserver`.
- Dashboard and gateway default to loopback. Optional private-LAN dashboard
  access has no login/TLS and must not expose inference routes. Do not start a
  test daemon on default ports against real state.

## Compatibility and completion

Plugin installation changes disk, not a running client server. Keep backend and
plugin catalog contracts compatible; verify runtime activation separately only
when authorized. Preserve stored state and prefer native workflows over one-off
environment migration machinery.

For version changes, search all version declarations, lockfiles, installer defaults,
and documentation examples together rather than relying on a cached file count.
Finish with scoped checks, artifact/privacy inspection where relevant, and an
honest account of untested behavior. Do not infer GPU, memory-fit, thermal, or
model-quality acceptance from fake runtimes or intercepted APIs.
