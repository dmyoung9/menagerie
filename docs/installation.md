# Installation and recovery

## Source checkout

Install Python 3.12+, uv, Node.js 22+, npm, and Git through your preferred trusted
package sources. GPU drivers are a host prerequisite; engines can be installed
from Menagerie's dashboard.

```sh
git clone https://github.com/dmyoung9/menagerie.git
cd menagerie
uv sync --locked
.venv/bin/menagerie serve
```

Use a release tag or reviewed commit for deployment. Keep the checkout in place:
the source installation and its virtual environment refer to it. Installation
builds the dashboard using the committed npm lockfile. It does not change your
services, clients, drivers, or model configuration.

## Build and install a wheel

```sh
uv build
uv tool install ./dist/menagerie-2.0.0-py3-none-any.whl
menagerie --version
menagerie serve
```

Builds require Node; running the wheel does not. `uv build` produces a source
archive and a wheel containing dashboard assets. Wheels are not currently
published to PyPI; do not install an unrelated package with the same name.
Use `uv tool update-shell` if uv's tool directory is not on PATH.

## Run as a user service

First stop a foreground daemon, if one is running. Then, using the executable
from the installation you want the service to run:

```sh
menagerie service install
systemctl --user enable --now menagerie.service
systemctl --user status menagerie.service
menagerie doctor
journalctl --user -u menagerie.service -n 50
```

For a checkout, substitute `.venv/bin/menagerie`. The installer records that
environment's absolute Python path; it does not assume a checkout directory.
It refuses to overwrite unmanaged or differently configured units. The
`menagerie service install` command only registers the unit; the guided installer
enables/restarts it when its service option is selected. Inspect and
back up an existing unit yourself before replacing it.

Custom ports/state can be captured at registration:

```sh
menagerie service install --state /absolute/private/state --port 8017 --gateway-port 8001
```

The state directory is created before service startup. The service runs as your
user, with a private umask, read-only home/system protection and write access to
the selected state directory. Keep state on a local filesystem. Source builds
write under state; model files outside it are referenced read-only.

The service starts at user login. Running before login requires a separate
administrator decision about lingering; the installer does not change it.
`menagerie.service` is a reference unit for the default uv tool path;
`service install` generates a unit for the actual interpreter and state path.

## Ports and network exposure

```sh
menagerie serve --state /absolute/private/state --port 8027 --gateway-port 8028
menagerie doctor --port 8027 --state /absolute/private/state
```

`MENAGERIE_STATE` sets the default state directory. Both listeners bind loopback
by default. The control API is also available on the gateway loopback listener;
the two ports are not separate authentication boundaries.

An optional `serve --dashboard-address PRIVATE_IPV4` adds a dashboard listener
on that exact private IPv4 address while preserving loopback. The LAN listener
rejects inference routes based on the accepted socket, not forwarding headers.
It has **no login or TLS** and allows trusted LAN users to administer Menagerie.
Never port-forward it or expose it to untrusted peers. To use it in a service,
review a systemd override setting `MENAGERIE_DASHBOARD_ADDRESS`; remove that
override and restart to return to local-only access.

## Upgrade and rollback

1. Run `menagerie backup` while the daemon is available. Copy the returned SQLite
   backup outside the state directory; retain the previous wheel or Git revision.
   Backups contain configuration and file references, **not model/runtime files**.
2. Stop the service with `systemctl --user stop menagerie.service` (or stop the
   foreground process). This interrupts inference; schedule downtime.
3. Update the reviewed checkout and run `uv sync --locked`, or replace the tool
   installation with `uv tool install --force /path/to/new.whl`.
4. If the interpreter path, ports, or state changed, disable/remove the old managed
   unit and register the new one. Otherwise start the existing service.
5. Check `status`, `doctor`, recent logs, model catalog, and a real client request.

For rollback, stop Menagerie, reinstall the retained version, and inspect its
compatibility with the database. If necessary restore the matching backup below.
Do not assume older code can read a newer database.

With the guided installer, `bash install.sh --rollback` swaps the retained previous
application back into place without downloading anything. It refuses to run when no
complete previous release exists, and only restarts `menagerie.service` when that
unit belongs to the same installation. Running it again returns to the newer
release. Database compatibility still governs whether rollback is safe.

### Restore a registry backup

Stop **all** Menagerie processes using the state directory. Preserve the current
`registry.sqlite3` and any `registry.sqlite3-wal`/`registry.sqlite3-shm` sidecars in
a separate recovery directory. Copy the selected consistent backup to
`registry.sqlite3`, with private permissions; do not retain stale sidecars beside
it. Restart and inspect the dashboard before issuing inference. Pinned deployments
saved as running may be restored on startup under their saved admission policy.

SQLite backups, runtime logs and registry state can contain private paths and
metadata. Keep recovery copies private. Never overwrite an active SQLite database.

## Uninstall without deleting data

```sh
systemctl --user disable --now menagerie.service
menagerie service remove
uv tool uninstall menagerie
```

For a checkout installation, skip `uv tool uninstall`; the checkout and environment
can be removed separately once no service references them. Service removal only
accepts a unit created by `menagerie service install`.

**Models, runtime builds, registry history, and backups are retained.** No uninstall
command deletes application data. Review the selected state directory and external
model paths separately before deciding what to remove.

## Troubleshooting

- **Daemon unavailable:** run `menagerie doctor`; then `menagerie serve` to see
  startup errors, or inspect the service journal. Check port conflicts and state permissions.
- **Dashboard missing:** rebuild with `uv sync --reinstall-package menagerie`, or
  install a wheel with bundled assets. For frontend development use `npm run build`.
- **Runtime won't load:** inspect Activity/launch errors, engine compatibility,
  executable permissions and capacity. Memory estimates do not require approval.
- **OCI GPU failure:** confirm your host's NVIDIA/container runtime setup separately.
- **Client model missing:** check deployment enablement, aliases, declared
  capabilities, and regenerate/reload the client fragment.
- **Port changed:** pass the control port to CLI commands with `--port`; regenerate
  the client fragment so its gateway URL matches.
## Guided installer

Before release publication, build a wheel with `uv build --wheel`, then run:

```sh
bash install.sh --wheel dist/menagerie-2.0.0-py3-none-any.whl
```

The installer downloads a pinned, SHA-256-verified uv binary and uses it to supply
Python 3.12 and application dependencies in user space. It offers user-service
startup, the OpenCode plugin, and opening the dashboard. `--yes` skips prompts;
select optional actions explicitly with `--service`, `--plugin`, and `--open`.
Use `--prefix` and `--bin-dir` for an isolated installation.

Published releases must provide the wheel and its `.whl.sha256` alongside a
`vVERSION` tag. Once published, the intended command is:

```sh
curl -fsSL https://raw.githubusercontent.com/dmyoung9/menagerie/main/install.sh | bash
```

**That download path is not release-ready until publication.** Local-wheel
installation is the verified path today.

## Guided-install updates and recovery

Run the installer again with the new wheel. Application environments are
content-addressed under `~/.local/share/menagerie/app/releases`; the installer
switches `current` only after installation and asset checks succeed. The prior
target remains available as `previous`. Models and registry state live outside
this application directory and are preserved.

The optional unit runs `<prefix>/current/bin/python`, so an upgrade or rollback
needs only a service restart; it does not need to be removed and recreated.
`bash install.sh --rollback` swaps `current` and `previous` atomically and restarts
the unit when it belongs to that installation. Back up registry state before
upgrading; application rollback is not a substitute for restoring a compatible
database backup.

To remove an installation, disable/stop and remove its optional user service,
remove the optional plugin with `menagerie plugin remove`, then remove the
installer's CLI symlink and application prefix. Keep the state directory to
preserve models, engine installations, configuration, and history.
