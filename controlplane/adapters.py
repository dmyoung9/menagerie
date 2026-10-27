"""Version-probed runtime adapters. No shell interpolation or downloaded code execution."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import struct

FIELDS = {
    "mmproj": {"type": "string", "label": "Multimodal projector path"},
    "ctx-size": {"type": "integer", "default": 8192, "min": 32, "max": 1048576, "units": "tokens", "label": "Context pool"},
    "parallel": {"type": "integer", "default": 1, "min": 1, "max": 128, "label": "Parallel slots"},
    "gpu-layers": {"type": "string", "default": "all", "label": "GPU layers"},
    "cache-type-k": {"type": "enum", "choices": ["f16", "q8_0", "q4_0"], "default": "q8_0", "label": "K cache"},
    "cache-type-v": {"type": "enum", "choices": ["f16", "q8_0", "q4_0"], "default": "q8_0", "label": "V cache"},
    "batch-size": {"type": "integer", "min": 1, "max": 8192, "default": 512, "label": "Batch size"},
    "ubatch-size": {"type": "integer", "min": 1, "max": 8192, "default": 256, "label": "Physical batch"},
    "threads": {"type": "integer", "min": 1, "max": 256, "default": 6, "label": "CPU threads"},
    "threads-batch": {"type": "integer", "min": 1, "max": 256, "default": 6, "label": "Batch threads"},
    "flash-attn": {"type": "enum", "choices": ["on", "off", "auto"], "default": "on", "label": "Flash attention"},
    "temp": {"type": "number", "min": 0, "max": 5, "default": 1, "label": "Temperature"},
    "reasoning-budget": {"type": "integer", "min": -1, "max": 1048576, "default": 4096, "label": "Reasoning budget"},
    "n-cpu-moe": {"type": "integer", "min": 0, "max": 256, "default": 0, "label": "CPU expert layers (adapter-specific)"},
}
OWNED = {"model", "model-path", "served-model-name", "m", "host", "port", "alias", "a", "api-key", "api-key-file", "models-preset", "models-dir", "models-max", "path", "log-file", "logdir", "daemon", "rpc", "model-url", "hf-repo", "hf-file", "hf-token", "trust-remote-code"}
IGNORED = {"load-on-startup", "stop-timeout", "sleep-idle-seconds"}
ENV_KEYS = {"LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "GGML_CUDA_ENABLE_UNIFIED_MEMORY", "OMP_NUM_THREADS", "HF_HOME", "XDG_CACHE_HOME", "TRITON_CACHE_DIR", "CUDA_CACHE_PATH", "VLLM_CACHE_ROOT", "VLLM_WORKER_MULTIPROC_METHOD"}


async def command(argv, env=None, timeout=30):
    process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        process.kill()
        await process.wait()
        raise
    text = output.decode(errors="replace")
    if process.returncode:
        raise ValueError(f"Command failed ({process.returncode}): {text[-2000:]}")
    return text


def environment(runtime):
    unknown = set(runtime.get("env", {})) - ENV_KEYS
    if unknown:
        raise ValueError(f"Unsupported environment keys: {sorted(unknown)}")
    env = {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "LANG", "XDG_RUNTIME_DIR"}}
    env.update(runtime.get("env", {}))
    return env


async def probe(runtime):
    environment(runtime)
    if not runtime.get("trust"):
        raise ValueError("Runtime execution requires explicit source trust")
    if runtime["execution_kind"] != "native":
        if not re.search(r"@sha256:[0-9a-f]{64}$", runtime["executable"]):
            raise ValueError("Container images must be pinned by sha256 digest")
        await command([runtime["execution_kind"], "image", "inspect", runtime["executable"]])
        formats = ["gguf"] if runtime["engine"] in ("llama.cpp", "prism") else runtime.get("formats", ["gguf"]) if runtime["engine"] == "custom" else ["safetensors"]
        return {"version": runtime["executable"], "flags": [], "formats": formats, "provenance": "local image inspection; runtime options require launch verification"}
    path = Path(runtime["executable"]).expanduser().resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("Runtime executable does not exist or is not executable")
    env = environment(runtime)
    help_args = ["serve", "--help=all"] if runtime["engine"] == "vllm" else ["--help"]
    text = await command([str(path), *help_args], env, 120 if runtime["engine"] == "vllm" else 45)
    flags = sorted(set(re.findall(r"--([a-zA-Z0-9][a-zA-Z0-9-]*)", text)))
    version = await command([str(path), "--version"], env, 20) if runtime["engine"] in ("llama.cpp", "prism") else runtime.get("version") or "unverified"
    return {"version": version.strip()[-1500:], "flags": flags,
            "formats": ["gguf"] if runtime["engine"] in ("llama.cpp", "prism") else runtime.get("formats", ["gguf"]) if runtime["engine"] == "custom" else ["safetensors"],
            "sha256": await asyncio.to_thread(file_hash, path), "provenance": "installed executable --help/--version", "schema": option_schema(runtime, flags)}


def option_schema(runtime, flags=None):
    flags = flags if flags is not None else runtime.get("capabilities", {}).get("flags", [])
    if runtime["engine"] in ("llama.cpp", "prism"):
        return {k: v | {"restart_required": True} for k, v in FIELDS.items() if k in flags}
    return {"max-model-len": {"type": "integer", "min": 512, "max": 1048576, "default": 8192, "restart_required": True}, "gpu-memory-utilization": {"type": "number", "min": .05, "max": .95, "default": .5, "restart_required": True}} if runtime["engine"] == "vllm" else {}


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def inspect_artifact(path, checksum=False):
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise ValueError("Artifact path does not exist")
    if p.is_dir():
        files = list(p.glob("*.safetensors"))
        if not files:
            raise ValueError("Directory must contain safetensors weights")
        config = json.loads((p / "config.json").read_text()) if (p / "config.json").exists() else {}
        tokenizer = p / "tokenizer_config.json"
        template = p / "chat_template.jinja"
        hints = {}
        if tokenizer.is_file() and tokenizer.stat().st_size <= 1024 * 1024:
            hints["tokenizer_config"] = json.loads(tokenizer.read_text())
        if template.is_file() and template.stat().st_size <= 1024 * 1024:
            hints["chat_template"] = template.read_text()
        manifest = {str(f.relative_to(p)): file_hash(f) for f in sorted(p.rglob("*")) if f.is_file()} if checksum else {}
        digest = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest() if manifest else None
        return {"local_path": str(p), "name": p.name, "format": "safetensors", "size_bytes": sum(f.stat().st_size for f in p.rglob("*") if f.is_file()), "architecture": config.get("model_type"), "metadata": {"config": config, "file_sha256": manifest, **hints}, "sha256": digest}
    metadata = gguf_metadata(p)
    return {"local_path": str(p), "name": Path(path).stem, "format": "gguf", "size_bytes": p.stat().st_size,
            "sha256": file_hash(p) if checksum else None, "architecture": metadata.get("general.architecture"),
            "quantization": str(metadata.get("general.file_type", "unknown")), "metadata": metadata}


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
            formats = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}
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


def validate_profile(profile, artifact, runtime):
    errors = []
    if artifact["format"] != "unknown" and artifact["format"] not in runtime.get("capabilities", {}).get("formats", []):
        errors.append("Artifact format is not supported by the probed adapter")
    from .engine_catalog import recommend
    if recommend(artifact)["engine"] == "prism" and runtime["engine"] == "llama.cpp":
        errors.append("These ternary weights need specialized kernels; select Prism rather than stock llama.cpp")
    schema = option_schema(runtime)
    flags = runtime.get("capabilities", {}).get("flags", [])
    for k, v in profile["config"].items():
        if k in OWNED or not re.fullmatch(r"[a-z][a-z0-9-]*", k):
            errors.append(f"Supervisor-owned or invalid option: {k}")
        if k in IGNORED:
            errors.append(f"Residency option belongs to the deployment: {k}")
        if runtime["execution_kind"] == "native" and flags and k not in flags and not (isinstance(v, bool) and f"no-{k}" in flags):
            errors.append(f"Installed runtime does not advertise --{k}")
        field = schema.get(k, {})
        if field.get("type") in ("integer", "number"):
            valid_type = type(v) is int if field["type"] == "integer" else type(v) in (int, float)
            if not valid_type or not field["min"] <= v <= field["max"]:
                errors.append(f"{k} is outside the typed range")
        if field.get("choices") and v not in field["choices"]:
            errors.append(f"Invalid {k}")
    for arg in profile["raw_args"]:
        if "\x00" in arg or arg.startswith("-") and arg.lstrip("-").split("=")[0] in OWNED:
            errors.append("Advanced flags may not override supervisor-owned options")
    config = profile["config"]
    meta, arch = artifact.get("metadata", {}), artifact.get("architecture", "")
    hf = meta.get("config", {}).get("text_config") or meta.get("config", {})
    context = meta.get(f"{arch}.context_length") or hf.get("max_position_embeddings")
    layers = meta.get(f"{arch}.block_count") or hf.get("num_hidden_layers")
    def number(key, default):
        value = config.get(key, default)
        return value if type(value) in (int, float) else default
    parallel = max(1, number("parallel", 1))
    if type(context) is int and context > 0:
        key = "ctx-size" if runtime["engine"] in ("llama.cpp", "prism") else "max-model-len"
        maximum = context * parallel if key == "ctx-size" else context
        if number(key, 0) > maximum:
            errors.append(f"{key} exceeds the model context limit ({maximum})")
    if "ctx-size" in config and number("ctx-size", 8192) < parallel * 32:
        errors.append("Context pool must provide at least 32 tokens per parallel slot")
    if number("ubatch-size", 256) > number("batch-size", 512):
        errors.append("Physical batch must not exceed batch size")
    gpu_layers = config.get("gpu-layers", "all")
    if gpu_layers != "all":
        if not re.fullmatch(r"\d+", str(gpu_layers)) or (type(layers) is int and int(gpu_layers) > layers):
            errors.append("GPU layer count must be between zero and the model layer count")
    if runtime.get("managed", {}).get("backend") == "cpu" and gpu_layers != "0" and gpu_layers != 0:
        errors.append("This CPU engine requires GPU layers set to zero")
    if config.get("flash-attn") == "off" and config.get("cache-type-v", "f16") != "f16":
        errors.append("Quantized V cache requires flash attention")
    constrained = {"ctx-size", "max-model-len", "parallel", "gpu-layers", "batch-size", "ubatch-size", "cache-type-k", "cache-type-v", "flash-attn"}
    if runtime["engine"] != "custom" and any(arg.startswith("--") and arg[2:].split("=")[0] in constrained for arg in profile["raw_args"]):
        errors.append("Use typed configuration fields for context, memory and batch options")
    if profile["raw_args"] and runtime["engine"] != "custom":
        for arg in profile["raw_args"]:
            if arg.startswith("-") and not arg.startswith("--") and not re.fullmatch(r"-\d+(\.\d+)?", arg):
                errors.append("Advanced options must use full --long names")
    return errors


def launch_spec(deployment, profile, artifact, runtime, workdir):
    errors = validate_profile(profile, artifact, runtime)
    if errors:
        raise ValueError("; ".join(errors))
    model_path = artifact["local_path"]
    container = runtime["execution_kind"] != "native"
    mount = Path(model_path) if Path(model_path).is_dir() else Path(model_path).parent
    model = "/models/" + Path(model_path).name if container and Path(model_path).is_file() else "/models" if container else model_path
    env = environment(runtime)
    env["CUDA_VISIBLE_DEVICES"] = str(deployment["gpu"])
    engine = runtime["engine"]
    if engine in ("llama.cpp", "prism"):
        args = ["--model", model, "--host", "0.0.0.0" if container else "127.0.0.1", "--port", str(deployment["port"]), "--alias", deployment["alias"], "--no-ui", "--metrics"]
    elif engine == "vllm":
        args = (["--model", model] if container else ["serve", model]) + ["--host", "0.0.0.0" if container else "127.0.0.1", "--port", str(deployment["port"]), "--served-model-name", deployment["alias"]]
    elif engine == "sglang":
        args = ["--model-path", model, "--host", "0.0.0.0" if container else "127.0.0.1", "--port", str(deployment["port"]), "--served-model-name", deployment["alias"]]
    else:
        values = {"model": model, "port": str(deployment["port"]), "alias": deployment["alias"], "host": "0.0.0.0" if container else "127.0.0.1"}
        args = [part.format_map(values) for part in runtime["command_template"]]
        if not args:
            raise ValueError("Custom runtime requires a trusted command template")
    extra_mounts = []
    for key, value in sorted(profile["config"].items()):
        if key == "metrics":
            continue
        if container and key in {"mmproj", "spec-draft-model", "model-draft", "chat-template-file"}:
            path = Path(value).expanduser().resolve()
            if not path.is_file():
                raise ValueError(f"Missing auxiliary artifact: {key}")
            target = f"/auxiliary/{len(extra_mounts)}-{path.name}"
            extra_mounts.append((str(path), target))
            value = target
        if isinstance(value, bool):
            args.append("--" + (key if value else "no-" + key))
        else:
            args.extend(["--" + key, json.dumps(value, separators=(",", ":")) if isinstance(value, (dict, list)) else str(value)])
    args += profile["raw_args"]
    if container:
        prefix = [runtime["execution_kind"], "run", "--rm", "--name", "menagerie-" + deployment["id"], "--label", "menagerie.owner=" + str(workdir), "--cap-drop=ALL", "--security-opt=no-new-privileges", "--shm-size=1g", "-p", f"127.0.0.1:{deployment['port']}:{deployment['port']}", "-v", f"{mount}:/models:ro"]
        prefix += ["--gpus", f"device={deployment['gpu']}"] if runtime["execution_kind"] == "docker" else ["--device", f"nvidia.com/gpu={deployment['gpu']}"]
        for source, target in extra_mounts:
            prefix += ["-v", f"{source}:{target}:ro"]
        for key, value in runtime.get("env", {}).items():
            prefix += ["-e", f"{key}={value}"]
        args = prefix + [runtime["executable"]] + args
    else:
        args = [runtime["executable"]] + args
    return {"argv": args, "env": env, "cwd": str(workdir)}
