"""Evidence-based model hints, separate from deployment capability declarations."""
import re


def inspect(metadata):
    config = metadata.get("config", {})
    tokenizer = metadata.get("tokenizer_config", {})
    template = metadata.get("tokenizer.chat_template") or metadata.get("chat_template") or tokenizer.get("chat_template", "")
    if not isinstance(template, str):
        template = str(template)
    evidence = []
    inputs = ["text"]
    for modality in ("vision", "audio", "video"):
        if config.get(modality + "_config") or metadata.get(modality + "_config"):
            inputs.append("image" if modality == "vision" else modality)
            evidence.append(f"{modality}_config")
    toggle = bool(re.search(r"\benable_thinking\b", template))
    effort = sorted(set(re.findall(r'''reasoning_effort\s*==\s*['"](none|low|medium|high)['"]''', template)
                        + re.findall(r'''['"](none|low|medium|high)['"]\s*==\s*reasoning_effort''', template)))
    reasoning = toggle or bool(effort) or bool(re.search(r"<think>|<\|(?:think|analysis)\|>", template))
    if reasoning:
        evidence.append("chat template reasoning markers" if not toggle else "chat template enable_thinking control")
    if effort:
        evidence.append("chat template reasoning_effort levels: " + ", ".join(effort))
    tools = bool(re.search(r"\btools\b", template))
    if tools:
        evidence.append("chat template tools variable")
    upstream = metadata.get("discovery", {})
    return {"input": list(dict.fromkeys(inputs + upstream.get("input", []))), "output": ["text"],
            "tools": tools or upstream.get("tools", False), "reasoning": reasoning or upstream.get("reasoning", False),
            "thinking_toggle": toggle or upstream.get("thinking_toggle", False),
            "reasoning_effort": sorted(set(effort + upstream.get("reasoning_effort", []))),
            "evidence": evidence + upstream.get("evidence", []), "dependencies": upstream.get("dependencies", []),
            "note": "Detected model hints, not proof of engine support. Confirm before advertising to clients."}


def ollama(info):
    caps = info.get("capabilities", [])
    return {"input": ["text"] + (["image"] if "vision" in caps else []), "output": ["text"],
            "tools": "tools" in caps, "reasoning": "thinking" in caps, "thinking_toggle": False,
            "evidence": ["Ollama /api/show capabilities"], "dependencies": [],
            "note": "Declared by Ollama for its runtime; thinking does not guarantee an off switch. Ollama manages package dependencies."}
