# Installation and recovery

## Requirements

The installer targets glibc Linux on x86_64 or aarch64. Architecture availability
does not certify a particular GPU or distribution. Bash, curl, tar, sha256sum,
standard GNU filesystem tools, and internet access are required. Python and
application dependencies are installed in user space; Node and Git are not needed
to run a prebuilt wheel. GPU drivers remain your responsibility.

Windows/WSL, macOS, Alpine/musl, and non-NVIDIA GPU serving are not certified.
NVIDIA supplies the GPU telemetry path; CPU serving is also available.

## Install a release

Download the installer from the project's repository, inspect it, then run it:

```sh
curl -fLSs https://raw.githubusercontent.com/dmyoung9/menagerie/main/install.sh -o install.sh
bash install.sh
```

The installer downloads the versioned wheel and verifies its published checksum.
Starting with 2.1, release installation also verifies and applies the matching
locked dependency constraints; local-wheel installs can pass `--constraints PATH`.
Checksums detect corruption, not publisher identity. Internet is required for
managed Python, dependencies, engines, and model downloads. Never supply personal
repository credentials to an installer.

The installer offers a user service, the optional OpenCode plugin, and opening
the dashboard. For unattended use, `--yes` skips prompts; optional actions require
`--service`, `--plugin`, or `--open`. No sudo or shell startup-file edits are used.
`--open` opens an existing dashboard; it does not start a foreground daemon.

To install a downloaded wheel:

```sh
bash install.sh --wheel ./menagerie-2.1.1-py3-none-any.whl --constraints ./menagerie-2.1.1-requirements.txt
```

Release downloads must be publicly accessible. A 404 can mean unavailable assets;
do not work around it by embedding credentials.
Wheels are not published to PyPI; avoid unrelated packages with the same name.

## Start and use

If you decline the service, run the absolute launcher printed by the installer,
normally:

```sh
~/.local/bin/menagerie serve
```

Keep the terminal open and visit <http://127.0.0.1:8017>. Ctrl+C stops the daemon.
Run the same command to reopen saved state. **Overview → Get your first response**
guides engine/model setup and a test prompt; no separate client is required.
Watch Activity for downloads and failures. Wait for Ready after requesting a load.

## Optional user service

Stop any foreground daemon first. Use the executable from the installation you
want to run:

```sh
menagerie service install
systemctl --user enable --now menagerie.service
menagerie doctor
```

Inspect with `systemctl --user status menagerie.service` and
`journalctl --user -u menagerie.service -n 50`. Logs may contain private details;
review them before sharing. Registration refuses unmanaged or differently
configured units rather than overwriting them. `service install` registers a
unit; the guided installer's service option also enables/starts it.

The service starts at login. Pre-login operation requires a separate administrator
decision about lingering. The generated unit uses the selected interpreter and
state path; it restricts writes to that state directory. Model files outside it
are referenced read-only. Keep state on a local filesystem.

## Ports, state, and LAN access

Default state is `~/.local/state/menagerie`, configurable with `MENAGERIE_STATE`
or `--state`. Default dashboard/gateway ports are 8017/8001, both loopback:

```sh
menagerie serve --state /absolute/private/state --port 8027 --gateway-port 8028
menagerie doctor --port 8027 --state /absolute/private/state
```

Use `service install` with the same options to register a custom configuration.
Check for existing listeners before starting another daemon. The gateway also
exposes the control API locally; the two ports are not authentication boundaries.

`serve --dashboard-address PRIVATE_IPV4` adds a listener on that private address.
It allows trusted LAN peers to administer Menagerie, with **no login or TLS**.
Inference routes remain loopback-only. Never port-forward it or expose it to
untrusted peers. A service can use a reviewed `MENAGERIE_DASHBOARD_ADDRESS`
override; remove the override and restart to return to loopback-only operation.

## Upgrade and rollback

1. Run `menagerie backup`. Keep the returned registry backup outside the state
   directory and retain the previous application. Backups do **not** contain model
   weights or runtime files.
2. Stop the daemon or service; this interrupts inference.
3. Run the installer with the new release or wheel. It verifies the application before
   switching its `current` pointer and retains the prior release as `previous`.
4. Restart and check `status`, `doctor`, the dashboard, and your client catalog.

For an installer-managed application, `bash install.sh --rollback` swaps current
and previous. It restarts only a running service belonging to that installation.
Running rollback again swaps them back. Application rollback does not restore
the database; confirm database compatibility before using an older application.

If interpreter, ports, or state changed, remove/re-register only the managed
service unit. Keep the previous release and registry backup until verification
of the new release is complete.

### Restore a registry backup

Stop **all** processes using the selected state. Preserve the current database
and its `-wal`/`-shm` sidecars in a private recovery directory. Copy the consistent
backup to `registry.sqlite3` with private permissions and no stale sidecars.
Never overwrite an active database. Restart and inspect before issuing requests;
pinned deployments saved as running may load under their saved policy.

## Uninstall without deleting data

Stop and remove the optional managed service and plugin first:

```sh
systemctl --user disable --now menagerie.service
menagerie service remove
menagerie plugin remove
```

Skip commands for optional components you did not install. For the guided
installer, remove only its CLI symlink and application prefix (normally
`~/.local/bin/menagerie` and `~/.local/share/menagerie/app`). Preserve state to
retain models, engines, registry history, and
backups. Review custom paths separately before removing anything.

## Troubleshooting

- **Daemon unavailable:** run `doctor`, inspect port conflicts/state permissions,
  and review foreground output or the service journal privately.
- **Dashboard unavailable:** verify the selected release and reinstall if its
  bundled assets are missing.
- **Runtime load failed:** inspect Activity, engine compatibility, capacity, and
  executable permissions. On-demand uncertainty permission differs from manual
  launch review; see [operations](operations.md).
- **Client model missing:** check enabled aliases and declared capabilities, then
  reload the client integration. See [OpenCode setup](opencode.md).
- **Port changed:** pass `--port` to CLI commands and update client gateway settings.
