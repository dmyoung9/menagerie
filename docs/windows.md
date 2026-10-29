# Windows installation and recovery

Menagerie has a native Windows 11 x64 installer. It includes the application,
Python dependencies, and dashboard: Python, Node, Git, OpenCode, and WSL are not
installation prerequisites. **RTX 5060 hardware acceptance remains pending.**
An installer build or fake-worker CI check does not establish GPU compatibility.

## Install and open

Download `menagerie-VERSION-windows-x64-setup.exe` and its `.sha256` file from the
matching release, using authorized access if the repository is private. Development
builds are available in the Checks workflow's `menagerie-windows-x64` artifact;
they are test candidates, not a separate installation format.

Verify the checksum with PowerShell's `Get-FileHash -Algorithm SHA256` and compare
it with the downloaded checksum file. A checksum checks integrity, not publisher
identity. The installer may be unsigned. Windows/browser reputation or security
warnings must be evaluated against the trusted download; do not disable Defender,
SmartScreen, or other protections to install it. If policy blocks execution, stop
and report the exact prompt through a private support channel.

Run the installer in your own account; normal installation does not need admin
rights. Open **Menagerie** from the Start Menu. It starts the local daemon and
opens the dashboard at `http://127.0.0.1:8017`. Opening it again reuses the running
instance. Closing the browser does not stop the daemon or models. Use **Stop
Menagerie** from the Start Menu before shutting down or relaunching it.

No Windows service, startup-at-login registration, or firewall exception is
installed. Dashboard and inference listeners remain local to the machine.

## First model and engine

Use **Overview → Get your first response**, then the engine/model checklist.
Managed Windows engines currently cover **llama.cpp GGUF on x64**, with CPU and
compatible CUDA release assets when available. Linux-only vLLM installations and
specialized Prism builds are not offered as managed Windows engines.

CUDA requires a compatible NVIDIA driver; Menagerie does not install or update
drivers. Engine assets and companion DLLs are downloaded together, verified, and
probed before registration. A probe failure is not a reason to copy arbitrary DLLs
into Windows system directories. Update the driver through its official channel
or choose an available compatible engine. CPU serving does not prove GPU offload.

## Paths, conflicts, and logs

- Application: `%LOCALAPPDATA%\Programs\Menagerie` by default.
- Persistent configuration, managed engines, and application state:
  `%LOCALAPPDATA%\Menagerie`.
- External model files stay where you selected them.
- Startup logs: `daemon.log` and `launcher.log` in the state directory.

If startup reports a port conflict, close the conflicting application only if you
recognize it, or choose other ports. Menagerie will not stop an unrelated listener.
For example, in PowerShell:

```powershell
& "$env:LOCALAPPDATA\Programs\Menagerie\Menagerie.exe" open --port 8117 --gateway-port 8101
```

The launcher remembers the running instance's ports for subsequent open/stop
actions. To change ports, stop it first. `--state` or `MENAGERIE_STATE` selects a
different persistent state directory; use the same choice when opening/stopping.
Default Start Menu actions operate on the default state unless that environment
variable is configured for the launching process.

The bundled `menagerie-cli.exe` offers `status`, `doctor`, `backup`, and other CLI
operations. Use `--port` when operating on a non-default dashboard port. Logs and
diagnostics can contain local paths: review them before sharing.

## Update and remove

Run the newer release installer in the same account and application location.
It asks the verified daemon to stop before replacing application files. If it
cannot stop safely, installation fails rather than forcibly killing an unrelated
process. Configuration, existing managed engines, and model references remain
outside the application directory. Back up state before updating; retain the
previous installer for recovery. Automatic rollback is not provided.

Remove Menagerie through Windows **Installed apps**. Removal stops the default
instance and removes application files and shortcuts, but **retains user data and
model files**. Reinstalling in the same account reuses retained state. Instances
started with custom state overrides must be stopped using those overrides first.
Do not manually delete the state directory as an uninstall step.
