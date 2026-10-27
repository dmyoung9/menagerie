"""Portable, opt-in user-service registration. Never changes inference state."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

MARKER = "# Managed by menagerie service install\n"


def quote(value, environment=False):
    value = str(value)
    if any(c in value for c in "\n\r\0"):
        raise ValueError("Service paths cannot contain newlines or NUL")
    value = value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    if environment:
        value = value.replace("$", "$$")
    return '"' + value + '"'


def unit(state, port, gateway_port, interpreter=None):
    if not all(1 <= p <= 65535 for p in (port, gateway_port)):
        raise ValueError("Ports must be 1..65535")
    # Keep the venv interpreter path, not its resolved system-Python symlink.
    executable = os.path.abspath(interpreter or sys.executable)
    return MARKER + f"""[Unit]
Description=Menagerie inference control plane
After=network.target

[Service]
Type=simple
ExecStart={quote(executable, environment=True)} -m controlplane --state {quote(state, environment=True)} --port {port} --gateway-port {gateway_port}
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
KillMode=control-group
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={quote(state)}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=default.target
"""


def systemctl(*args, check=True):
    result = subprocess.run(["systemctl", "--user", *args], text=True, capture_output=True, timeout=20)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "systemctl failed")
    return result


def manage(operation, state, port, gateway_port, interpreter=None):
    if not sys.platform.startswith("linux"):
        raise ValueError("User services require Linux and systemd")
    path = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "systemd/user/menagerie.service"
    if operation == "status":
        result = systemctl("status", "menagerie.service", "--no-pager", check=False)
        return {"path": str(path), "status": result.stdout, "exit_code": result.returncode}
    if path.is_symlink() or (path.exists() and not path.read_text().startswith(MARKER)):
        raise ValueError(f"Refusing to overwrite or remove an unmanaged unit: {path}")
    if operation == "remove":
        # Require explicit stop/disable first, including when a unit is failed.
        active = systemctl("is-active", "menagerie.service", check=False)
        enabled = systemctl("is-enabled", "menagerie.service", check=False)
        if active.stdout.strip() not in {"inactive", "failed", "unknown"} or enabled.stdout.strip() not in {"disabled", "not-found", ""}:
            raise ValueError("First run: systemctl --user disable --now menagerie.service")
        path.unlink(missing_ok=True)
    else:
        content = unit(state, port, gateway_port, interpreter)
        if path.exists() and path.read_text() != content:
            raise ValueError("A different managed unit exists; stop/disable and remove it explicitly before reinstalling")
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
        try:
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    systemctl("daemon-reload")
    return {"path": str(path), "operation": operation, "data_preserved": True,
            "next": "systemctl --user enable --now menagerie.service" if operation == "install" else "Application state and models were not removed."}
