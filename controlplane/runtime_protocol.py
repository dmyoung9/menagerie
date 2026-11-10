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


def features(runtime, flags):
    """Executable advertisements, never model or hardware certification.

    Absence from help is unknown: builds can expose protocol features without
    corresponding CLI flags. Supplier labels deliberately do not participate.
    """
    flags = set(flags)
    requirements = (
        {
            "image_projector": {"mmproj"},
            "reasoning_budget": {"reasoning-budget"},
            "reasoning_output_format": {"reasoning-format"},
            "template_arguments": {"chat-template-kwargs"},
            "speculative_decoding": {"spec-type"},
            "native_fit": {"fit"},
            "device_selection": {"device"},
            "native_pool": {"models-preset", "models-autoload", "models-max"},
        }
        if runtime["engine"] == "llama.cpp"
        else {
            "reasoning_parser": {"reasoning-parser"},
            "template_arguments": {"default-chat-template-kwargs"},
        }
        if runtime["engine"] == "vllm"
        else {}
    )
    return {
        name: {
            "status": "supported" if required <= flags else "unknown",
            "value": {"mechanism": "cli", "parameters": sorted(required)},
            "evidence": [
                {
                    "source": "runtime",
                    "confidence": "high",
                    "detail": "Installed executable help advertises "
                    + ", ".join("--" + key for key in sorted(required))
                    + "; model compatibility and inference unverified",
                }
            ]
            if required <= flags
            else [],
        }
        for name, required in requirements.items()
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
