"""Version-probed runtime adapters. No shell interpolation or downloaded code execution."""

import asyncio
import contextlib
import hashlib
import json
import math
import os
import re
import struct
from pathlib import Path

import psutil

from . import runtime_protocol, templates
from .schema import ParameterPresentation

FIELDS = {
    "mmproj": {"type": "string", "label": "Multimodal projector path"},
    "ctx-size": {
        "type": "integer",
        "default": 0,
        "min": 0,
        "max": 1048576,
        "units": "tokens",
        "label": "Context pool",
    },
    "parallel": {
        "type": "integer",
        "default": -1,
        "min": -1,
        "max": 128,
        "label": "Parallel slots",
    },
    "gpu-layers": {"type": "string", "default": "auto", "label": "GPU layers"},
    "fit": {"type": "enum", "choices": ["on", "off"], "label": "Automatic fit"},
    "fit-target": {"type": "string", "label": "Free device memory target (MiB)"},
    "fit-ctx": {
        "type": "integer",
        "min": 0,
        "max": 1048576,
        "label": "Minimum automatic context",
    },
    "device": {
        "type": "string",
        "label": "Engine devices (comma-separated, none for CPU)",
    },
    "split-mode": {
        "type": "enum",
        "choices": ["none", "layer", "row", "tensor"],
        "label": "Device split mode",
    },
    "tensor-split": {"type": "string", "label": "Device split proportions"},
    "override-tensor": {"type": "string", "label": "Tensor placement overrides"},
    "cpu-moe": {"type": "boolean", "label": "Keep MoE experts on CPU"},
    "n-cpu-ffn": {
        "type": "integer",
        "min": 0,
        "max": 4096,
        "label": "Dense FFN layers on CPU",
    },
    "cache-type-k": {
        "type": "enum",
        "choices": ["f16", "q8_0", "q4_0"],
        "default": "f16",
        "label": "K cache",
    },
    "cache-type-v": {
        "type": "enum",
        "choices": ["f16", "q8_0", "q4_0"],
        "default": "f16",
        "label": "V cache",
    },
    "batch-size": {
        "type": "integer",
        "min": 1,
        "max": 8192,
        "default": 2048,
        "label": "Batch size",
    },
    "ubatch-size": {
        "type": "integer",
        "min": 1,
        "max": 8192,
        "default": 512,
        "label": "Physical batch",
    },
    "threads": {
        "type": "integer",
        "min": -1,
        "max": 256,
        "default": -1,
        "label": "CPU threads",
    },
    "threads-batch": {
        "type": "integer",
        "min": -1,
        "max": 256,
        "default": -1,
        "label": "Batch threads",
    },
    "flash-attn": {
        "type": "enum",
        "choices": ["auto", "on", "off"],
        "default": "auto",
        "label": "Flash attention",
    },
    "temp": {
        "type": "number",
        "min": 0,
        "max": 5,
        "default": 0.8,
        "label": "Temperature",
    },
    "top-p": {"type": "number", "min": 0, "max": 1, "label": "Top-p"},
    "top-k": {"type": "integer", "min": 0, "max": 1048576, "label": "Top-k"},
    "min-p": {"type": "number", "min": 0, "max": 1, "label": "Min-p"},
    "presence-penalty": {
        "type": "number",
        "min": -2,
        "max": 2,
        "label": "Presence penalty",
    },
    "repeat-penalty": {
        "type": "number",
        "min": 0,
        "max": 10,
        "label": "Repetition penalty",
    },
    "spec-type": {"type": "string", "label": "Speculative decoding type (MTP)"},
    "spec-draft-model": {"type": "string", "label": "MTP / draft model path"},
    "model-draft": {"type": "string", "label": "Draft model path (legacy alias)"},
    "spec-draft-n-max": {
        "type": "integer",
        "min": 1,
        "max": 1048576,
        "label": "Maximum draft tokens",
    },
    "spec-draft-n-min": {
        "type": "integer",
        "min": 0,
        "max": 1048576,
        "label": "Minimum draft tokens",
    },
    "draft-max": {
        "type": "integer",
        "min": 1,
        "max": 1048576,
        "label": "Maximum draft tokens (legacy)",
    },
    "draft-min": {
        "type": "integer",
        "min": 0,
        "max": 1048576,
        "label": "Minimum draft tokens (legacy)",
    },
    "reasoning-budget": {
        "type": "integer",
        "min": -1,
        "max": 1048576,
        "default": -1,
        "label": "Default reasoning budget",
    },
    "n-cpu-moe": {
        "type": "integer",
        "min": 0,
        "max": 256,
        "default": 0,
        "engine_default": 0,
        "label": "MoE expert layers on CPU",
    },
}
OPTION_HELP = {
    "fit": "Let the engine adjust unspecified settings to available device memory. Explicit overrides still constrain fitting.",
    "fit-target": "Free memory to leave on each device, in MiB. A larger margin leaves more room for the desktop or other models; comma-separated values set different device margins.",
    "fit-ctx": "Smallest context automatic fitting may choose. Raise this when your workload needs a minimum usable context.",
    "device": "Engine device identifiers, comma-separated. Use none for CPU-only execution; omit to let the engine choose available devices.",
    "split-mode": "How to distribute work across multiple GPUs. Usually leave this to the engine; it is not needed for a single GPU.",
    "tensor-split": "Relative model shares for multiple GPUs, such as 3,1. Useful for unequal devices; omit for engine-selected proportions.",
    "override-tensor": "Expert-only tensor placement rules. Use when particular tensors must live in a specific buffer; ordinary offloading does not need this.",
    "cpu-moe": "Keep mixture-of-experts weights in system RAM to reduce VRAM use, potentially at a substantial speed cost.",
    "n-cpu-moe": "Keep expert weights from this many initial MoE layers in system RAM. Trades generation speed for lower VRAM usage.",
    "n-cpu-ffn": "Keep feed-forward weights from this many initial dense layers in system RAM. Advanced speed-versus-memory tradeoff.",
    "cache-type-k": "Precision of the key cache. Lower precision can save memory for longer context; compatibility and quality depend on the model and runtime.",
    "cache-type-v": "Precision of the value cache. Lower precision can save memory; quantized values may require flash attention.",
    "gpu-memory-utilization": "Fraction of GPU memory this vLLM instance may use. Reduce it to leave capacity for other workloads.",
}

OWNED = {
    "model",
    "model-path",
    "served-model-name",
    "m",
    "host",
    "port",
    "alias",
    "a",
    "api-key",
    "api-key-file",
    "models-preset",
    "models-dir",
    "models-max",
    "models-autoload",
    "models-memory-margin",
    "path",
    "log-file",
    "logdir",
    "daemon",
    "rpc",
    "model-url",
    "hf-repo",
    "hf-file",
    "hf-token",
    "trust-remote-code",
}
IGNORED = {"load-on-startup", "stop-timeout", "sleep-idle-seconds"}
ENV_KEYS = {
    "LD_LIBRARY_PATH",
    "CUDA_VISIBLE_DEVICES",
    "GGML_CUDA_ENABLE_UNIFIED_MEMORY",
    "OMP_NUM_THREADS",
    "HF_HOME",
    "XDG_CACHE_HOME",
    "TRITON_CACHE_DIR",
    "CUDA_CACHE_PATH",
    "VLLM_CACHE_ROOT",
    "VLLM_WORKER_MULTIPROC_METHOD",
}


async def command(argv, env=None, timeout=30):
    from . import processes

    try:
        process = await processes.spawn(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
        )
    except OSError as exc:
        raise ValueError(
            f"Cannot execute engine; check its path, architecture and prerequisites: {exc}"
        ) from exc
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        with contextlib.suppress(psutil.NoSuchProcess):
            await processes.terminate(
                {
                    "pid": process.pid,
                    "pid_started": psutil.Process(process.pid).create_time(),
                },
                grace=0,
            )
        await process.wait()
        raise
    finally:
        processes.release(process.pid)
    text = output.decode(errors="replace")
    if process.returncode:
        raise ValueError(
            f"Command failed ({processes.exit_reason(process.returncode)}): {text[-2000:]}"
        )
    return text


def environment(runtime):
    unknown = set(runtime.get("env", {})) - ENV_KEYS
    if unknown:
        raise ValueError(f"Unsupported environment keys: {sorted(unknown)}")
    env = {
        k: v
        for k, v in os.environ.items()
        if k.upper()
        in {
            "PATH",
            "HOME",
            "LANG",
            "XDG_RUNTIME_DIR",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "PATHEXT",
        }
    }
    env.update(runtime.get("env", {}))
    if os.name == "nt" and runtime.get("managed", {}).get("dll_dirs"):
        root = Path(runtime["managed"]["root"]).resolve()
        directories = [Path(p).resolve() for p in runtime["managed"]["dll_dirs"]]
        if any(not p.is_relative_to(root) for p in directories):
            raise ValueError("Managed DLL directory escapes the engine installation")
        path_key = next((k for k in env if k.upper() == "PATH"), "PATH")
        env[path_key] = os.pathsep.join(
            [*(str(p) for p in directories), env.get(path_key, "")]
        )
    return env


async def probe(runtime):
    environment(runtime)
    if not runtime.get("trust"):
        raise ValueError("Runtime execution requires explicit source trust")
    if runtime["execution_kind"] != "native":
        if not re.search(r"@sha256:[0-9a-f]{64}$", runtime["executable"]):
            raise ValueError("Container images must be pinned by sha256 digest")
        await command(
            [runtime["execution_kind"], "image", "inspect", runtime["executable"]]
        )
        formats = (
            ["gguf"]
            if runtime["engine"] == "llama.cpp"
            else runtime.get("formats", ["gguf"])
            if runtime["engine"] == "custom"
            else ["safetensors"]
        )
        return {
            "version": runtime["executable"],
            "flags": [],
            "formats": formats,
            "provenance": "local image inspection; runtime options require launch verification",
        }
    path = Path(runtime["executable"]).expanduser().resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("Runtime executable does not exist or is not executable")
    env = environment(runtime)
    protocol = runtime_protocol.PROTOCOLS[runtime["engine"]]
    help_args = list(protocol.help_args)
    text = await command(
        [str(path), *help_args], env, 120 if runtime["engine"] == "vllm" else 45
    )
    flags = sorted(set(re.findall(r"--([a-zA-Z0-9][a-zA-Z0-9-]*)", text)))
    version = (
        await command([str(path), *protocol.version_args], env, 20)
        if protocol.version_args
        else runtime.get("version") or "unverified"
    )
    devices = []
    if "list-devices" in flags:
        device_text = await command([str(path), "--list-devices"], env, 30)
        devices = [
            {"id": match[1], "description": match[2][:512]}
            for match in re.finditer(
                r"(?m)^\s*([A-Za-z][A-Za-z0-9_-]*\d+):\s+(.+)$", device_text
            )
        ][:64]
    return {
        "version": version.strip()[-1500:],
        "flags": flags,
        "mechanisms": runtime_protocol.mechanisms(runtime, flags),
        "features": runtime_protocol.features(runtime, flags),
        "devices": devices,
        "formats": ["gguf"]
        if runtime["engine"] == "llama.cpp"
        else runtime.get("formats", ["gguf"])
        if runtime["engine"] == "custom"
        else ["safetensors"],
        "sha256": await asyncio.to_thread(file_hash, path),
        "provenance": "installed executable --help/--version",
        "schema": option_schema(runtime, flags, text),
    }


def help_defaults(text, schema, runtime):
    """Read only advertised defaults, scoped to their own option's help block."""
    for block in re.split(r"(?m)(?=^-)", text):
        header = block.split("\n", 1)[0]
        header = re.sub(r"^-[^-][^ ,]*,\s+", "", header)
        names = re.findall(
            r"--([a-zA-Z0-9][a-zA-Z0-9-]*)", re.split(r"\s{2,}", header)[0]
        )
        normalized = " ".join(block.split())
        match = re.search(r"\(default:\s*([^)]*)\)", normalized)
        if not match or "argument has been removed" in normalized:
            continue
        for key in names:
            field = schema.get(key)
            if not field:
                continue
            raw = match[1]
            field["default_note"] = raw
            if field.get("type") not in {"integer", "number"}:
                candidate = raw.split(",", 1)[0].strip().strip("'\"")
                if field.get("type") in {"enum", "string"} and (
                    not field.get("choices") or candidate in field["choices"]
                ):
                    field["default"] = candidate
                continue
            source = re.fullmatch(r"same as --([a-z-]+)", raw)
            if source and source[1] in schema:
                field["default_from"] = source[1]
                continue
            number = re.match(r"(-?\d+(?:\.\d+)?)(?=\s*[, )-]|$)", raw)
            if not number:
                continue
            value = float(number[1])
            if not math.isfinite(value) or (
                field["type"] == "integer" and not value.is_integer()
            ):
                continue
            if (
                key in {"spec-draft-n-max", "draft-max"}
                and runtime.get("managed", {}).get("backend") == "cuda"
            ):
                mtp = re.search(r"(\d+) for draft-mtp on CUDA", raw)
                if mtp:
                    value = int(mtp[1])
            field["engine_default"] = (
                int(value) if field["type"] == "integer" else value
            )
            field["default_note"] = raw
    return schema


async def configuration_schema(runtime):
    """Read trusted engine help without loading weights or modifying saved records."""
    schema = option_schema(runtime)
    if (
        runtime.get("execution_kind") != "native"
        or not runtime.get("trust")
        or runtime["engine"] not in {"llama.cpp", "vllm"}
    ):
        return schema
    digest = runtime.get("capabilities", {}).get("sha256")
    if (
        digest
        and await asyncio.to_thread(file_hash, Path(runtime["executable"])) != digest
    ):
        raise ValueError(
            "Runtime executable changed; register the updated installation before probing options"
        )
    args = ["serve", "--help=all"] if runtime["engine"] == "vllm" else ["--help"]
    text = await command(
        [runtime["executable"], *args],
        environment(runtime),
        120 if runtime["engine"] == "vllm" else 45,
    )
    return help_defaults(text, schema, runtime)


def executable_fingerprint(runtime):
    """Cheap cache invalidation; configuration_schema verifies the trusted hash."""
    if runtime.get("execution_kind") != "native":
        return ()
    path = Path(runtime["executable"]).expanduser().resolve()
    try:
        stat = path.stat()
    except OSError as exc:
        raise ValueError(
            "Runtime executable unavailable; inspect the installation before probing options"
        ) from exc
    return (
        str(path),
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
        stat.st_ctime_ns,
    )


def parameter_presentation(key, engine):
    """Describe existing CLI fields without changing their values or ownership.

    Native llama pools render these model-server options in each child's preset;
    router policy is separate and must not be inferred from child option names.
    """
    generation = {
        "temp",
        "top-p",
        "top-k",
        "min-p",
        "presence-penalty",
        "repeat-penalty",
        "reasoning-budget",
    }
    resources = {"ctx-size", "parallel", "fit", "device", "max-model-len"}
    category = (
        "generation"
        if key in generation
        else "resources-context"
        if key in resources
        else "model-runtime"
        if key == "mmproj"
        else "advanced"
    )
    automatic = (
        {"ctx-size": 0, "parallel": -1, "gpu-layers": "auto", "flash-attn": "auto"}
        if engine == "llama.cpp"
        else {}
    )
    return ParameterPresentation(
        category=category,
        owner="runtime-process",
        owner_by_mode={
            "standalone": "runtime-process",
            "native-pool": "model-deployment",
        }
        if engine == "llama.cpp"
        else {},
        request_overridable=key in generation - {"reasoning-budget"},
        **({"automatic_value": automatic[key]} if key in automatic else {}),
    ).model_dump(exclude_none=True)


def option_schema(runtime, flags=None, help_text=None):
    flags = (
        flags if flags is not None else runtime.get("capabilities", {}).get("flags", [])
    )
    if runtime["engine"] == "llama.cpp":
        retired = {
            legacy
            for legacy, modern in (
                ("draft-max", "spec-draft-n-max"),
                ("draft-min", "spec-draft-n-min"),
            )
            if modern in flags
        }
        schema = {
            k: v
            | {
                "restart_required": True,
                "description": OPTION_HELP.get(k, ""),
                "presentation": parameter_presentation(k, runtime["engine"]),
            }
            for k, v in FIELDS.items()
            if k in flags and k not in retired
        }
        # Older saved schemas contain policy presets, not executable defaults.
        # Carry only explicitly probed default evidence across registry reads.
        for key, field in schema.items():
            saved = runtime.get("capabilities", {}).get("schema", {}).get(key, {})
            for name in ("engine_default", "default_note", "default_from"):
                if name in saved:
                    field[name] = saved[name]
            if (
                field.get("type") in {"string", "enum"}
                and saved.get("default_note")
                and "default" in saved
            ):
                field["default"] = saved["default"]
        return help_defaults(help_text, schema, runtime) if help_text else schema
    schema = (
        {
            "max-model-len": {
                "type": "integer",
                "min": 512,
                "max": 1048576,
                "restart_required": True,
            },
            "gpu-memory-utilization": {
                "description": OPTION_HELP["gpu-memory-utilization"],
                "type": "number",
                "min": 0.05,
                "max": 0.95,
                "restart_required": True,
            },
        }
        if runtime["engine"] == "vllm"
        else {}
    )
    for key, field in schema.items():
        field["presentation"] = parameter_presentation(key, runtime["engine"])
    return schema


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def runtime_observation(properties):
    """Retain only non-content runtime facts, never prompts or template bodies."""
    settings = properties.get("default_generation_settings", {})
    params = settings.get("params", {}) if isinstance(settings, dict) else {}
    resolved = {}
    for source in (properties, settings, params):
        if isinstance(source, dict):
            for key in ("n_ctx", "n_ctx_train", "n_parallel", "n_batch", "n_ubatch"):
                value = source.get(key)
                if type(value) is int and value >= 0:
                    resolved[key] = value
    return {
        "residency": "sleeping"
        if properties.get("is_sleeping") is True
        else "resident",
        "resolved": resolved,
        "source": "runtime /props",
        "capabilities": {
            target: properties["modalities"][source]
            for source, target in (("vision", "input_image"), ("audio", "input_audio"))
            if isinstance(properties.get("modalities"), dict)
            and type(properties["modalities"].get(source)) is bool
        },
    }


def inspect_artifact(path, checksum=False):
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise ValueError("Artifact path does not exist")
    if p.is_dir():
        files = list(p.glob("*.safetensors"))
        if not files:
            raise ValueError("Directory must contain safetensors weights")
        config = (
            json.loads((p / "config.json").read_text())
            if (p / "config.json").exists()
            else {}
        )
        tokenizer = p / "tokenizer_config.json"
        template = p / "chat_template.jinja"
        hints = {}
        generation = p / "generation_config.json"
        if generation.is_file() and generation.stat().st_size <= 1024 * 1024:
            hints["generation_config"] = json.loads(generation.read_text())
        if tokenizer.is_file() and tokenizer.stat().st_size <= 1024 * 1024:
            hints["tokenizer_config"] = json.loads(tokenizer.read_text())
        if template.is_file() and template.stat().st_size <= 1024 * 1024:
            hints["chat_template"] = template.read_text()
        manifest = (
            {
                str(f.relative_to(p)): file_hash(f)
                for f in sorted(p.rglob("*"))
                if f.is_file()
            }
            if checksum
            else {}
        )
        digest = (
            hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
            if manifest
            else None
        )
        return {
            "local_path": str(p),
            "name": p.name,
            "format": "safetensors",
            "size_bytes": sum(f.stat().st_size for f in p.rglob("*") if f.is_file()),
            "architecture": config.get("model_type"),
            "metadata": {"config": config, "file_sha256": manifest, **hints},
            "sha256": digest,
        }
    metadata = gguf_metadata(p)
    return {
        "local_path": str(p),
        "name": Path(path).stem,
        "format": "gguf",
        "size_bytes": p.stat().st_size,
        "sha256": file_hash(p) if checksum else None,
        "architecture": metadata.get("general.architecture"),
        "quantization": str(metadata.get("general.file_type", "unknown")),
        "metadata": metadata,
    }


def gguf_metadata(path):
    """Bounded GGUF header reader. Skip tokenizer arrays without materializing them."""
    with open(path, "rb") as f:

        def read(n):
            if n > 64 * 1024 * 1024 or f.tell() + n > 128 * 1024 * 1024:
                raise ValueError("GGUF metadata exceeds inspection limit")
            value = f.read(n)
            if len(value) != n:
                raise ValueError("Truncated GGUF")
            return value

        def unpack(fmt):
            return struct.unpack("<" + fmt, read(struct.calcsize("<" + fmt)))[0]

        def string():
            return read(unpack("Q")).decode("utf-8", errors="replace")

        def value(kind, keep=True, depth=0):
            if depth > 2:
                raise ValueError("Invalid nested GGUF metadata")
            formats = {
                0: "B",
                1: "b",
                2: "H",
                3: "h",
                4: "I",
                5: "i",
                6: "f",
                7: "?",
                10: "Q",
                11: "q",
                12: "d",
            }
            if kind in formats:
                return unpack(formats[kind])
            if kind == 8:
                return string()
            if kind == 9:
                subtype, count = unpack("I"), unpack("Q")
                if count > 2_000_000:
                    raise ValueError("Oversized GGUF metadata array")
                for _ in range(count):
                    value(subtype, False, depth + 1)
                return {"array_length": count}
            raise ValueError(f"Unknown GGUF value type {kind}")

        if read(4) != b"GGUF" or unpack("I") not in (2, 3):
            raise ValueError("Unsupported GGUF header")
        unpack("Q")
        count = unpack("Q")
        if count > 10000:
            raise ValueError("Oversized GGUF metadata table")
        result = {}
        for _ in range(count):
            key = string()
            v = value(unpack("I"))
            if not key.startswith("tokenizer.") or key == "tokenizer.chat_template":
                result[key] = v
        return result


def validate_profile(profile, artifact, runtime, selection=None):
    errors = []
    if artifact["format"] != "unknown" and artifact["format"] not in runtime.get(
        "capabilities", {}
    ).get("formats", []):
        errors.append("Artifact format is not supported by the probed adapter")
    schema = option_schema(runtime)
    flags = runtime.get("capabilities", {}).get("flags", [])
    for k, v in profile["config"].items():
        if k in OWNED or not re.fullmatch(r"[a-z][a-z0-9-]*", k):
            errors.append(f"Supervisor-owned or invalid option: {k}")
        if k in IGNORED:
            errors.append(f"Residency option belongs to the deployment: {k}")
        if (
            runtime["execution_kind"] == "native"
            and flags
            and k not in flags
            and not (isinstance(v, bool) and f"no-{k}" in flags)
        ):
            errors.append(f"Installed runtime does not advertise --{k}")
        field = schema.get(k, {})
        if field.get("type") in ("integer", "number"):
            valid_type = (
                type(v) is int
                if field["type"] == "integer"
                else type(v) in (int, float)
            )
            if not valid_type or not field["min"] <= v <= field["max"]:
                errors.append(f"{k} is outside the typed range")
        if field.get("choices") and v not in field["choices"]:
            errors.append(f"Invalid {k}")
    for arg in profile["raw_args"]:
        if (
            "\x00" in arg
            or arg.startswith("-")
            and arg.lstrip("-").split("=")[0] in OWNED | IGNORED
        ):
            errors.append("Advanced flags may not override supervisor-owned options")
    config = profile["config"]
    if config.get("parallel") == 0:
        errors.append("Parallel slots must be positive or -1 for automatic selection")
    meta, arch = artifact.get("metadata", {}), artifact.get("architecture", "")
    hf = meta.get("config", {}).get("text_config") or meta.get("config", {})
    context = meta.get(f"{arch}.context_length") or hf.get("max_position_embeddings")
    layers = meta.get(f"{arch}.block_count") or hf.get("num_hidden_layers")

    def number(key, default):
        value = config.get(key, default)
        return value if type(value) in (int, float) else default

    parallel = max(1, number("parallel", 1))
    if type(context) is int and context > 0:
        key = "ctx-size" if runtime["engine"] == "llama.cpp" else "max-model-len"
        maximum = context * parallel if key == "ctx-size" else context
        if number(key, 0) > maximum:
            errors.append(f"{key} exceeds the model context limit ({maximum})")
    if (
        "ctx-size" in config
        and number("ctx-size", 0) > 0
        and number("ctx-size", 0) < parallel * 32
    ):
        errors.append("Context pool must provide at least 32 tokens per parallel slot")
    # An omitted flag uses the engine's default, not a historical UI preset.
    # Without probed evidence, leave the combination to the engine to validate.
    batch = config.get("batch-size", schema.get("batch-size", {}).get("engine_default"))
    ubatch = config.get(
        "ubatch-size", schema.get("ubatch-size", {}).get("engine_default")
    )
    if type(batch) is int and type(ubatch) is int and ubatch > batch:
        errors.append("Physical batch must not exceed batch size")
    for minimum, maximum in (
        ("spec-draft-n-min", "spec-draft-n-max"),
        ("draft-min", "draft-max"),
    ):
        if (
            minimum in config
            and maximum in config
            and number(minimum, 0) > number(maximum, 0)
        ):
            errors.append(f"{minimum} must not exceed {maximum}")
    if type(layers) is int and number("n-cpu-moe", 0) > layers:
        errors.append("CPU expert layers must not exceed the model layer count")
    gpu_layers = config.get("gpu-layers", "auto")
    if gpu_layers == "auto" and "gpu-layers" in config and flags and "fit" not in flags:
        errors.append(
            "Installed runtime does not advertise automatic fit; omit GPU layers or set an explicit count"
        )
    if gpu_layers not in ("all", "auto"):
        if not re.fullmatch(r"\d+", str(gpu_layers)) or (
            type(layers) is int and int(gpu_layers) > layers
        ):
            errors.append(
                "GPU layer count must be between zero and the model layer count"
            )
    if config.get("flash-attn") == "off" and config.get("cache-type-v", "f16") != "f16":
        errors.append("Quantized V cache requires flash attention")
    constrained = {
        "ctx-size",
        "max-model-len",
        "parallel",
        "gpu-layers",
        "batch-size",
        "ubatch-size",
        "cache-type-k",
        "cache-type-v",
        "flash-attn",
    }
    if runtime["engine"] != "custom" and any(
        arg.startswith("--") and arg[2:].split("=")[0] in constrained
        for arg in profile["raw_args"]
    ):
        errors.append(
            "Use typed configuration fields for context, memory and batch options"
        )
    if profile["raw_args"] and runtime["engine"] != "custom":
        for arg in profile["raw_args"]:
            if (
                arg.startswith("-")
                and not arg.startswith("--")
                and not re.fullmatch(r"-\d+(\.\d+)?", arg)
            ):
                errors.append("Advanced options must use full --long names")
    if selection is not None and selection.get("source") not in (None, "", "automatic"):
        if selection.get("asset") is None:
            errors.append(
                f"Selected {selection.get('source')} template is missing; "
                "refresh templates or choose Automatic"
            )
        conflict = templates.detect_conflict(profile)
        if conflict:
            errors.append(
                f"{conflict}: remove the manual flag or set the template selector to Automatic"
            )
    return errors


def launch_spec(deployment, profile, artifact, runtime, workdir, store):
    selection = templates.effective_selection(deployment, artifact, store)
    errors = validate_profile(profile, artifact, runtime, selection)
    if errors:
        raise ValueError("; ".join(errors))
    model_path = artifact["local_path"]
    container = runtime["execution_kind"] != "native"
    mount = Path(model_path) if Path(model_path).is_dir() else Path(model_path).parent
    model = (
        "/models/" + Path(model_path).name
        if container and Path(model_path).is_file()
        else "/models"
        if container
        else model_path
    )
    env = environment(runtime)
    # Native --device selection needs visibility of all eligible engine devices.
    # A deployment GPU is only a restriction when explicitly selected.
    if deployment.get("gpu") is not None:
        env["CUDA_VISIBLE_DEVICES"] = str(deployment["gpu"])
    engine = runtime["engine"]
    if engine == "llama.cpp":
        args = [
            "--model",
            model,
            "--host",
            "0.0.0.0" if container else "127.0.0.1",
            "--port",
            str(deployment["port"]),
            "--alias",
            deployment["alias"],
            "--no-ui",
            "--metrics",
        ]
        if runtime_protocol.native_idle_sleep(deployment, runtime) and not any(
            deployment["id"] in unit["member_ids"]
            for unit in store.list("deployment_set")
        ):
            args.extend(["--sleep-idle-seconds", str(deployment["idle_timeout"])])
    elif engine == "vllm":
        args = (["--model", model] if container else ["serve", model]) + [
            "--host",
            "0.0.0.0" if container else "127.0.0.1",
            "--port",
            str(deployment["port"]),
            "--served-model-name",
            deployment["alias"],
        ]
    elif engine == "sglang":
        args = [
            "--model-path",
            model,
            "--host",
            "0.0.0.0" if container else "127.0.0.1",
            "--port",
            str(deployment["port"]),
            "--served-model-name",
            deployment["alias"],
        ]
    else:
        values = {
            "model": model,
            "port": str(deployment["port"]),
            "alias": deployment["alias"],
            "host": "0.0.0.0" if container else "127.0.0.1",
        }
        args = [part.format_map(values) for part in runtime["command_template"]]
        if not args:
            raise ValueError("Custom runtime requires a trusted command template")
    template_info = None
    if (
        templates.supports_template_flag(runtime)
        and selection.get("source") not in (None, "automatic")
        and selection.get("asset")
    ):
        asset = selection["asset"]
        if asset.get("status") != "available":
            raise ValueError(
                f"Selected template {selection.get('description')} is not available; "
                "refresh templates or choose Automatic"
            )
        native_path = Path(asset["file_path"]).resolve()
        if not native_path.is_file():
            raise ValueError(f"Selected template file not found: {native_path}")
        template_info = {
            "flag": templates.template_flag_name(runtime),
            "native": str(native_path),
            "container": f"/templates/{native_path.name}",
        }
    if template_info:
        args.extend(
            [
                f"--{template_info['flag']}",
                template_info["container"] if container else template_info["native"],
            ]
        )
    extra_mounts = []
    if template_info and container:
        extra_mounts.append((template_info["native"], template_info["container"]))
    for key, value in sorted(profile["config"].items()):
        if key == "metrics":
            continue
        if container and key in {
            "mmproj",
            "spec-draft-model",
            "model-draft",
            "chat-template-file",
        }:
            path = Path(value).expanduser().resolve()
            if not path.is_file():
                raise ValueError(f"Missing auxiliary artifact: {key}")
            target = f"/auxiliary/{len(extra_mounts)}-{path.name}"
            extra_mounts.append((str(path), target))
            value = target
        if isinstance(value, bool):
            if key in {"fit", "flash-attn"}:
                args.extend(["--" + key, "on" if value else "off"])
            else:
                args.append("--" + (key if value else "no-" + key))
        else:
            args.extend(
                [
                    "--" + key,
                    json.dumps(value, separators=(",", ":"))
                    if isinstance(value, (dict, list))
                    else str(value),
                ]
            )
    args += profile["raw_args"]
    if container:
        prefix = [
            runtime["execution_kind"],
            "run",
            "--rm",
            "--name",
            "menagerie-" + deployment["id"],
            "--label",
            "menagerie.owner=" + str(workdir),
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--shm-size=1g",
            "-p",
            f"127.0.0.1:{deployment['port']}:{deployment['port']}",
            "-v",
            f"{mount}:/models:ro",
        ]
        gpu_args = (
            [
                "--gpus",
                "all"
                if deployment.get("gpu") is None
                else f"device={deployment['gpu']}",
            ]
            if runtime["execution_kind"] == "docker"
            else [
                "--device",
                f"nvidia.com/gpu={deployment['gpu'] if deployment.get('gpu') is not None else 'all'}",
            ]
        )
        if (
            profile["config"].get("device") != "none"
            and str(profile["config"].get("gpu-layers")) != "0"
            and runtime.get("managed", {}).get("backend") != "cpu"
        ):
            prefix += gpu_args
        for source, target in extra_mounts:
            prefix += ["-v", f"{source}:{target}:ro"]
        for key, value in runtime.get("env", {}).items():
            prefix += ["-e", f"{key}={value}"]
        args = prefix + [runtime["executable"]] + args
    else:
        args = [runtime["executable"]] + args
    return {"argv": args, "env": env, "cwd": str(workdir)}
