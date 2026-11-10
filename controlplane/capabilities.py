"""Evidence-based model hints, separate from deployment capability declarations."""

import math
import re
from copy import deepcopy

from .schema import Capability


def finding(value=None, *, source=None, detail="", confidence="medium", status=None):
    return Capability(
        status=status or ("supported" if value is not None else "unknown"),
        value=value,
        evidence=[{"source": source, "detail": detail, "confidence": confidence}]
        if source
        else [],
    ).model_dump(exclude_none=True)


def template_text(metadata):
    """Only inspect actual template strings, never repr() of untrusted metadata."""
    tokenizer = metadata.get("tokenizer_config")
    tokenizer = tokenizer if isinstance(tokenizer, dict) else {}
    raw = (
        metadata.get("tokenizer.chat_template")
        or metadata.get("chat_template")
        or tokenizer.get("chat_template", "")
    )
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        return "\n".join(
            entry["template"]
            for entry in raw
            if isinstance(entry, dict) and isinstance(entry.get("template"), str)
        )
    return ""


def structured(metadata):
    """Conservative model findings. No model-name heuristics or absence-as-denial."""
    template = re.sub(r"{#.*?#}", "", template_text(metadata), flags=re.DOTALL)
    expressions = "\n".join(
        re.findall(r"{[{%]-?(.*?)-?[%}]}", template, flags=re.DOTALL)
    )
    toggle = bool(re.search(r"\benable_thinking\b", expressions))
    levels = sorted(
        set(
            re.findall(
                r"""reasoning_effort\s*==\s*['"]([\w.-]{1,64})['"]|['"]([\w.-]{1,64})['"]\s*==\s*reasoning_effort""",
                expressions,
            )
        )
    )
    levels = sorted({a or b for a, b in levels})
    markers = bool(re.search(r"<think>|<\|(?:think|analysis)\|>", template))
    evidence = dict(
        source="tokenizer", detail="Inspected chat template; not an inference test"
    )
    findings = {
        key: finding()
        for key in (
            "reasoning",
            "reasoning_control",
            "reasoning_mechanism",
            "reasoning_output",
            "reasoning_budget",
            "client_compatibility",
            "tools",
            "input_image",
            "input_audio",
            "input_video",
            "output_image",
            "output_audio",
            "output_video",
        )
    }
    if toggle or levels or markers:
        findings["reasoning"] = finding(True, **evidence)
    if toggle or levels:
        findings["reasoning_control"] = finding(
            {
                "type": "custom"
                if toggle and levels
                else "toggle"
                if toggle
                else "effort-levels",
                "levels": levels,
            },
            **evidence,
        )
        findings["reasoning_mechanism"] = finding("template-argument", **evidence)
    # A marker proves a template format, not that generated reasoning is separated.
    if re.search(r"\btools\b", template):
        findings["tools"] = finding(True, **evidence)
    config = metadata.get("config")
    config = config if isinstance(config, dict) else {}
    for name, modality in (("vision", "image"), ("audio", "audio"), ("video", "video")):
        if isinstance(
            config.get(name + "_config", metadata.get(name + "_config")), dict
        ):
            findings["input_" + modality] = finding(
                True, source="artifact", detail=name + "_config"
            )
    upstream = metadata.get("discovery")
    upstream = upstream if isinstance(upstream, dict) else {}
    # Retain collected structured publisher evidence, including disagreement.
    published_findings = upstream.get("findings", {})
    for key, value in (
        published_findings.items() if isinstance(published_findings, dict) else []
    ):
        if key not in findings or not isinstance(value, dict):
            continue
        try:
            published = Capability.model_validate(value).model_dump(exclude_none=True)
        except ValueError:
            continue
        current = findings[key]
        if current["status"] == "unknown" and not current["evidence"]:
            findings[key] = published
        else:
            current["evidence"] += [
                e for e in published["evidence"] if e not in current["evidence"]
            ]
            if published["status"] not in {"unknown", current["status"]}:
                current["status"] = "unknown"
                current["conflicting"] = True
    return findings


def recommendations(metadata, schema=None):
    """Published generation config is optional advice, not a runtime default."""
    published = metadata.get("generation_config")
    if not isinstance(published, dict):
        upstream = metadata.get("discovery", {})
        entries = (
            upstream.get("recommendations", []) if isinstance(upstream, dict) else []
        )
        published = (
            {
                entry["parameter"]: entry["value"]
                for entry in entries
                if isinstance(entry, dict)
                and isinstance(entry.get("parameter"), str)
                and type(entry.get("value")) in (int, float)
            }
            if isinstance(entries, list)
            else {}
        )
    mapping = {
        "temperature": "temp",
        "top_p": "top-p",
        "top_k": "top-k",
        "min_p": "min-p",
        "repetition_penalty": "repeat-penalty",
    }
    result = []
    for source_key, key in mapping.items():
        value = published.get(source_key, published.get(key))
        if type(value) not in (float, int) or not math.isfinite(value):
            continue
        field = (schema or {}).get(key)
        compatible = None if schema is None else bool(field)
        if field:
            compatible = field.get("min", float("-inf")) <= value <= field.get(
                "max", float("inf")
            ) and (field.get("type") != "integer" or type(value) is int)
        result.append(
            {
                "parameter": key,
                "value": value,
                "compatible": compatible,
                "source": "artifact",
                "detail": "Published generation_config.json: " + source_key,
            }
        )
    return result


def effective(
    artifact,
    runtime,
    profile,
    *,
    template=None,
    template_source="tokenizer",
    observation=None,
):
    """Resolve model and deployment evidence without mutating configuration."""
    metadata = dict(artifact.get("metadata", {}))
    model = structured(metadata)
    deployed = deepcopy(model)
    if template is not None:
        selected = structured({"chat_template": template})
        for key in (
            "reasoning",
            "reasoning_control",
            "reasoning_mechanism",
            "reasoning_output",
            "reasoning_budget",
            "tools",
        ):
            deployed[key] = selected[key]
            for evidence in deployed[key]["evidence"]:
                evidence["source"] = template_source
                evidence["detail"] = (
                    "Selected deployment template: " + evidence["detail"]
                )
    warnings = []
    flags = set(runtime.get("capabilities", {}).get("flags", []))
    for key, entry in deployed.items():
        if entry["status"] == "supported":
            entry["status"] = "unknown"
            entry["evidence"].append(
                {
                    "source": "runtime",
                    "confidence": "low",
                    "detail": "Model evidence detected; effective support on the selected executable is not yet observed",
                }
            )
    # llama.cpp GGUF image input needs a projector. Other engines have their own
    # artifact/lifecycle semantics; do not impose llama's requirement on them.
    image = deployed["input_image"]
    if (
        runtime.get("engine") == "llama.cpp"
        and model["input_image"]["status"] == "supported"
    ):
        projector = profile.get("config", {}).get("mmproj")
        if not projector:
            image["status"] = "unsupported"
            image.pop("value", None)
            image["evidence"].append(
                {
                    "source": "runtime",
                    "confidence": "high",
                    "detail": "Image input unavailable: select a projector and an executable advertising --mmproj",
                }
            )
            warnings.append(
                "Image-capable model requires a compatible projector and runtime support; launch remains available."
            )
        else:
            image["status"] = "unknown"
            image["evidence"].append(
                {
                    "source": "runtime",
                    "confidence": "low",
                    "detail": "Projector configured; "
                    + (
                        "--mmproj advertised"
                        if "mmproj" in flags
                        else "--mmproj support unknown"
                    )
                    + "; artifact compatibility and inference unverified",
                }
            )
    if observation:
        for key, value in observation.get("capabilities", {}).items():
            if key in deployed and type(value) is bool:
                previous = deployed[key]
                conflicting = previous.get("conflicting", False) or (
                    previous["status"] != "unknown"
                    and (previous["status"] == "supported") != value
                )
                deployed[key] = {
                    "status": "supported" if value else "unsupported",
                    "value": value,
                    "conflicting": conflicting,
                    "evidence": previous["evidence"]
                    + [
                        {
                            "source": "runtime",
                            "confidence": "high",
                            "detail": "Current session runtime reports "
                            + key
                            + "="
                            + str(value).lower(),
                        }
                    ],
                }
                if conflicting:
                    warnings.append(
                        key
                        + ": current runtime observation conflicts with earlier evidence"
                    )
    declared = profile.get("catalog", {}).get("model", {}).get("capabilities", {})
    for key in deployed:
        if key == "reasoning" and "reasoning" in declared:
            value = declared["reasoning"]
            value = value.get("supported") if isinstance(value, dict) else value
        elif key.startswith(("input_", "output_")):
            direction, modality = key.split("_", 1)
            if direction not in declared:
                continue
            value = modality in declared[direction]
        else:
            continue
        if type(value) is bool:
            deployed[key]["evidence"].append(
                {
                    "source": "user",
                    "confidence": "low",
                    "detail": "Client declaration: "
                    + str(value).lower()
                    + "; not runtime verification",
                }
            )
            if (
                deployed[key]["status"] != "unknown"
                and (deployed[key]["status"] == "supported") != value
            ):
                deployed[key]["conflicting"] = True
                warnings.append(
                    key
                    + ": client declaration conflicts with detected deployment support"
                )
    from .adapters import option_schema

    return {
        "model": model,
        "effective": deployed,
        "warnings": warnings,
        "recommendations": recommendations(metadata, option_schema(runtime)),
    }


def inspect(metadata):
    config = metadata.get("config")
    config = config if isinstance(config, dict) else {}
    template = template_text(metadata)
    evidence = []
    inputs = ["text"]
    for modality in ("vision", "audio", "video"):
        if config.get(modality + "_config") or metadata.get(modality + "_config"):
            inputs.append("image" if modality == "vision" else modality)
            evidence.append(f"{modality}_config")
    toggle = bool(re.search(r"\benable_thinking\b", template))
    effort = sorted(
        set(
            re.findall(
                r"""reasoning_effort\s*==\s*['"]([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})['"]""",
                template,
            )
            + re.findall(
                r"""['"]([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})['"]\s*==\s*reasoning_effort""",
                template,
            )
        )
    )
    reasoning = (
        toggle
        or bool(effort)
        or bool(re.search(r"<think>|<\|(?:think|analysis)\|>", template))
    )
    if reasoning:
        evidence.append(
            "chat template reasoning markers"
            if not toggle
            else "chat template enable_thinking control"
        )
    if effort:
        evidence.append("chat template reasoning_effort levels: " + ", ".join(effort))
    tools = bool(re.search(r"\btools\b", template))
    if tools:
        evidence.append("chat template tools variable")
    upstream = metadata.get("discovery", {})
    upstream = upstream if isinstance(upstream, dict) else {}
    return {
        "input": list(dict.fromkeys(inputs + upstream.get("input", []))),
        "output": ["text"],
        "tools": tools or upstream.get("tools", False),
        "reasoning": reasoning or upstream.get("reasoning", False),
        "thinking_toggle": toggle or upstream.get("thinking_toggle", False),
        "reasoning_effort": sorted(set(effort + upstream.get("reasoning_effort", []))),
        "evidence": evidence + upstream.get("evidence", []),
        "dependencies": upstream.get("dependencies", []),
        "note": "Detected model hints, not proof of engine support. Confirm before advertising to clients.",
        "findings": structured(metadata),
        "recommendations": recommendations(metadata),
    }
