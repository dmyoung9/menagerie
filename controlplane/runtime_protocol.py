"""Small runtime protocol boundary; suppliers and forks are not adapters.

Capabilities describe advertised mechanisms, not successful hardware acceptance.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Protocol:
    formats: tuple[str, ...]
    help_args: tuple[str, ...]
    version_args: tuple[str, ...] = ()
    properties_path: str | None = None


PROTOCOLS = {
    "llama.cpp": Protocol(("gguf",), ("--help",), ("--version",), "/props"),
    "vllm": Protocol(("safetensors",), ("serve", "--help=all")),
    "sglang": Protocol(("safetensors",), ("--help",)),
    "custom": Protocol((), ("--help",)),
}


def mechanisms(runtime, flags):
    flags = set(flags)
    llama = runtime["engine"] == "llama.cpp"
    return {
        "fit": llama and "fit" in flags,
        "native_idle_sleep": llama and "sleep-idle-seconds" in flags,
        "router": llama and {"models-preset", "models-autoload", "models-max"} <= flags,
        "router_memory": llama and "models-memory-margin" in flags,
        "device_selection": "device" in flags,
        "evidence": "installed executable help; behavior requires launch verification",
    }


def native_idle_sleep(deployment, runtime):
    """Groups keep their atomic supervisor timer; only standalone units delegate."""
    return bool(
        runtime.get("capabilities", {}).get("mechanisms", {}).get("native_idle_sleep")
        and not deployment.get("deployment_set_id")
        and deployment.get("residency") == "on-demand"
        and deployment.get("idle_timeout", 0) > 0
    )


def observation(store, deployment):
    """Operational facts never advance editable configuration revisions."""
    if deployment.get("state") not in {"READY", "DEGRADED", "LOADING"}:
        return None
    try:
        record = store.get("runtime_observation", deployment["id"])
    except KeyError:
        return None
    return (
        record["facts"]
        if record.get("session_id") == deployment.get("session_id")
        else None
    )
