from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
import re


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = None

    @field_validator("id")
    @classmethod
    def safe_id(cls, value):
        if value is not None and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}", value):
            raise ValueError("Use letters, numbers, dots, hyphens or underscores for IDs")
        return value


class Artifact(Record):
    name: str
    local_path: str
    source: str = "local"
    repo: str | None = None
    source_revision: str | None = None
    format: Literal["gguf", "safetensors", "ollama", "unknown"] = "gguf"
    quantization: str | None = None
    architecture: str | None = None
    sha256: str | None = None
    size_bytes: int = 0
    metadata: dict = Field(default_factory=dict)


class Runtime(Record):
    name: str
    engine: Literal["llama.cpp", "prism", "vllm", "sglang", "custom"]
    execution_kind: Literal["native", "docker", "podman"] = "native"
    executable: str
    version: str | None = None
    commit: str | None = None
    fork_url: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    command_template: list[str] = Field(default_factory=list)
    formats: list[Literal["gguf", "safetensors"]] = Field(default_factory=lambda: ["gguf"])
    trust: bool = False


class Profile(Record):
    name: str
    artifact_id: str
    runtime_id: str
    config: dict = Field(default_factory=dict)
    raw_args: list[str] = Field(default_factory=list)
    catalog: dict = Field(default_factory=dict)


class Deployment(Record):
    name: str
    profile_id: str
    alias: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,159}$")
    port: int = Field(ge=1024, le=65535)
    residency: Literal["pinned", "on-demand", "evictable"] = "on-demand"
    priority: int = Field(default=50, ge=0, le=100)
    idle_timeout: int = Field(default=300, ge=0, le=86400)
    reservation_mib: int = Field(default=0, ge=0)
    allow_eviction: bool = False
    allow_uncertain: bool = False
    enabled: bool = True
    gpu: int = Field(default=0, ge=0, le=31)
    queue_timeout: int = Field(default=300, ge=1, le=1800)


class Group(Record):
    name: str
    deployment_ids: list[str]
    authorized_stops: list[str] = Field(default_factory=list)


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sample_seconds: float = Field(default=2, ge=1, le=60)
    retention_days: int = Field(default=7, ge=1, le=90)
    summary_days: int = Field(default=90, ge=1, le=365)
    history_quota_mib: int = Field(default=512, ge=16, le=16384)
    gpu_headroom_mib: int = Field(default=2048, ge=2048)
    ram_headroom_mib: int = Field(default=4096, ge=4096)
    temperature_limit: int = Field(default=85, ge=60, le=85)
    max_queue: int = Field(default=32, ge=1, le=256)
    expose_on_demand: bool = True
