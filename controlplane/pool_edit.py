"""Pool-edit contract for the model-first UI (Stage 1 of the plan).

Three pure, read-only helpers that the Stage 4 API and dashboard call to
decide *before* anything is changed:

- ``eligible_for_pool`` — whether a configuration can join an existing native
  default pool. Deterministic, non-mutating, and a "hard error" on every
  incompatibility (runtime/build, device, protocol/format, policy, raw or
  shared-router configuration). The caller must surface the errors and let the
  user re-select; these helpers never propose or apply a configuration change
  to force a fit.

- ``action_scope`` — the *actual* scope of a requested per-model action. A
  native pool has no member-level unload: every requested action (stop,
  unload, enable, disable, restart) lands on the whole pool. This helper
  returns that honest scope so the UI never labels a whole-pool stop as a
  per-model unload.

- ``eviction_candidates`` — policy-gated, consent-required idle models that
  could be unloaded to make room for a new load. Returns candidates only;
  stopping is a separate, reviewed operation.

None of these touch the store or the runtime; they return data for review.
"""

from . import deployment_sets

# Settings the pool/router owns; a single member's profile must never carry them.
SHARED_ROUTER_SETTINGS = frozenset(
    (
        "models-preset",
        "models-dir",
        "models-max",
        "models-autoload",
        "models-memory-margin",
        "host",
        "port",
    )
)

# A member is "loaded" (and thus unloadable) in any of these states.
ACTIVE_STATES = {"QUEUED", "STARTING", "LOADING", "READY", "DEGRADED", "STOPPING"}

# Treated as fully idle: a member with no recorded last use.
_NEVER_USED_SECONDS = 7 * 86_400

_ACTION_LABELS = {
    "stop": "unload",
    "unload": "unload",
    "stop_pool": "unload the whole pool",
    "pool_stop": "unload the whole pool",
    "enable": "re-enable client access to",
    "disable": "disable client access to",
    "restart": "restart",
    "reload": "reload",
    "reload_router": "reload the shared pool",
}


def _lookup(store, kind, ident):
    try:
        return store.get(kind, ident)
    except KeyError:
        return None


def _resolve_unit(unit, store):
    """Return a *resolved* unit (with ``members``/``member_ids``/``multi_model``)
    from either a resolved unit dict or a unit/deployment id."""
    if isinstance(unit, dict) and unit.get("member_ids") is not None:
        return unit
    ident = (
        unit
        if isinstance(unit, str)
        else (unit.get("id") if isinstance(unit, dict) else None)
    )
    if ident is None:
        return unit if isinstance(unit, dict) else None
    return deployment_sets.unit_for(store, ident)


def eligible_for_pool(proposed, unit, store):
    """Deterministically check whether ``proposed`` can join ``unit`` unchanged.

    Returns a list of human-readable hard errors; an empty list means the
    member fits the pool as-is. Non-empty results are *hard* — the UI must
    present them and let the user choose a compatible pool or reconfigure;
    this helper never changes the engine, device, format, or settings to fit.

    Compatibility dimensions (all must hold), per the plan:
      * runtime installation/build (same, native, router-capable),
      * device visibility/environment (same device),
      * supported protocol (artifact format the runtime accepts),
      * policy (a user-requested residency conflicting with an on-demand pool),
      * configuration constraints (no raw args, no shared router settings).
    """
    errors = []
    proposed_profile = proposed.get("profile_snapshot") or {}
    proposed_runtime_id = proposed_profile.get("runtime_id")
    proposed_artifact_id = proposed_profile.get("artifact_id")
    proposed_gpu = proposed.get("gpu")
    proposed_raw = proposed_profile.get("raw_args") or []
    proposed_config = proposed_profile.get("config") or {}
    proposed_residency = proposed.get("residency")
    pool_residency = unit.get("residency")
    members = unit.get("members") or []
    pool_runtime_id = None
    pool_gpu = None

    # A native pool must share exactly one runtime installation.
    if members:
        pool_runtime_id = members[0].get("profile_snapshot", {}).get("runtime_id")
        pool_gpu = members[0].get("gpu")
        if len({m.get("profile_snapshot", {}).get("runtime_id") for m in members}) != 1:
            errors.append(
                "The existing pool is internally inconsistent: its members use "
                "more than one runtime installation."
            )
        if len({m.get("gpu") for m in members}) != 1:
            errors.append(
                "The existing pool is internally inconsistent: its members use "
                "more than one device."
            )

    if proposed_runtime_id is None:
        errors.append("The proposed configuration has no linked runtime installation.")
    else:
        runtime = _lookup(store, "runtime", proposed_runtime_id)
        if runtime is None:
            errors.append(f"Unknown runtime installation: {proposed_runtime_id}")
        else:
            if runtime.get("execution_kind") != "native":
                errors.append(
                    "Native pools require a native installation, not a container."
                )
            if not runtime.get("capabilities", {}).get("mechanisms", {}).get("router"):
                errors.append(
                    "The runtime does not advertise model routing; a native pool "
                    "shares one router process."
                )
            formats = runtime.get("capabilities", {}).get("formats") or []
            if proposed_artifact_id is not None:
                artifact = _lookup(store, "artifact", proposed_artifact_id)
                format_ = artifact.get("format") if artifact else None
                if format_ and format_ != "unknown" and format_ not in formats:
                    errors.append(
                        f"Artifact format {format_!r} is not supported by the "
                        "runtime; the proposed model cannot run on this pool."
                    )
            if members and proposed_runtime_id != pool_runtime_id:
                errors.append(
                    "The proposed model uses a different runtime installation than "
                    "the pool; a native pool shares a single engine build."
                )

    # Device visibility/environment must match the pool's device.
    if members and proposed_gpu != pool_gpu:
        errors.append(
            "The proposed model targets device "
            f"{proposed_gpu!r} but the pool serves {pool_gpu!r}; device "
            "visibility must match."
        )

    # Policy: a user-requested residency must not conflict with an on-demand
    # default pool (the pool's residency is authoritative and is on-demand).
    if pool_residency == "on-demand" and proposed_residency not in (None, "on-demand"):
        errors.append(
            f"The proposed model requests {proposed_residency!r} residency; a "
            "native default pool shares one on-demand residency policy. Assign it "
            "to a matching supervised group instead."
        )

    # Configuration constraints: no raw args and no shared router settings.
    if proposed_raw:
        errors.append(
            "The proposed model uses raw arguments; native pools require named "
            "configuration options."
        )
    shared = SHARED_ROUTER_SETTINGS.intersection(proposed_config.keys())
    if shared:
        errors.append(
            "Shared router settings belong to the pool, not the individual model; "
            f"remove {sorted(shared)} from the model configuration."
        )

    return sorted(set(errors))


def action_scope(action, unit, store, member_id=None):
    """The honest scope of ``action`` on ``unit``.

    ``unit`` may be a resolved unit dict or a unit/deployment id. If a single
    ``member_id`` is supplied it must be part of the unit.

    A native multi-model pool has **no member-level unload mechanism**, so every
    action (stop/unload, enable, disable, restart) actually affects the **whole
    unit**. This helper returns that scope so the UI can label the action
    honestly (a pool stop is a pool stop, never "unloads model X") and can
    offer the matching review/consent. For a standalone (single-member) unit,
    the action is member-level.

    Returns ``{action, unit_id, unit_name, member_id, member_ids, affects,
    is_whole_unit, multi_model, member_level, scope_label}``.
    """
    resolved = _resolve_unit(unit, store)
    if resolved is None:
        raise ValueError("Unknown unit")
    member_ids = list(resolved.get("member_ids", []))
    members = resolved.get("members") or []
    multi = bool(resolved.get("multi_model"))
    if member_id is not None and member_id not in member_ids:
        raise ValueError(
            f"Member {member_id!r} is not part of unit {resolved.get('id')!r}."
        )

    if multi:
        # The runtime cannot unload one member independently of the pool.
        affects = list(member_ids)
        is_whole_unit = True
        member_level = False
        label = (
            _ACTION_LABELS.get(action, action)
            + f" the pool {resolved.get('name')!r} — this affects all "
            f"{len(affects)} models in the pool."
        )
    else:
        affects = [member_id] if member_id is not None else (member_ids[:1] or [])
        is_whole_unit = False
        member_level = True
        member_name = next(
            (m.get("name") for m in members if m.get("id") == member_id), None
        ) or (members[0].get("name") if members else None)
        label = (
            _ACTION_LABELS.get(action, action)
            + f" the model {member_name or member_id or resolved.get('id')!r}."
        )

    return {
        "action": action,
        "unit_id": resolved.get("id"),
        "unit_name": resolved.get("name"),
        "member_id": member_id,
        "member_ids": affects,
        "affects_count": len(affects),
        "is_whole_unit": is_whole_unit,
        "multi_model": multi,
        "member_level": member_level,
        "scope_label": label,
    }


def eviction_candidates(
    units,
    selected_ids=(),
    inflight=None,
    last_use=None,
    now=None,
    incoming_priority=None,
):
    """Policy-gated, consent-required idle-eviction candidates.

    Given resolved ``units`` and the deployment ids that *need* room (``selected_ids``),
    return the units whose idle members could be unloaded to make room. This is
    a *proposal*, not an action: every entry carries ``requires_consent: True``
    and the UI must show the affected models and obtain separate launch-review
    consent before stopping anything.

    Gates (a unit is only a candidate if ALL hold):
      1. it is not one of the units being started (never evict what you're loading);
      2. it permits eviction (``allow_eviction`` — explicit user consent to eviction);
      3. its residency is not pinned (pinned/atomic groups are never evicted);
      4. the unit's priority is strictly below the incoming work's (the optional
         ``incoming_priority`` gate — never evict work as important as what's
         being added);
      5. at least one member is loaded (ACTIVE), not busy (no in-flight requests),
         and idle longer than the unit's ``idle_timeout``.

    Returns candidates sorted most-idle first, then lowest priority, then name.
    A member with no recorded last use is treated as fully idle.

    ``units`` must be resolved units (from ``deployment_sets.units()``) or a list
    of them; ``inflight`` is ``{deployment_id: request_count}``, ``last_use`` is
    ``{deployment_id: monotonic_ts}``, and ``now`` is a monotonic timestamp
    (defaults to ``time.monotonic()``).
    """
    import time

    if now is None:
        now = time.monotonic()
    selected = set(selected_ids)
    inflight = inflight or {}
    last_use = last_use or {}

    # If no explicit incoming priority was given, derive a conservative bar from
    # the units being started (the *lowest* incoming priority), so we only ever
    # evict strictly less-important work. When it can't be derived, no gate.
    if incoming_priority is None:
        incoming = [u for u in units if u and set(u.get("member_ids", [])) & selected]
        if incoming:
            incoming_priority = min(u.get("priority", 50) for u in incoming)
        else:
            incoming_priority = None

    def idle_seconds(mid):
        ts = last_use.get(mid)
        if ts is None:
            return _NEVER_USED_SECONDS
        return max(0.0, now - ts)

    candidates = []
    for u in units:
        if not isinstance(u, dict):
            continue
        member_ids = list(u.get("member_ids", [])) or []
        members = u.get("members") or []
        if not member_ids:
            continue
        # Gate 1: never evict the unit being started.
        if set(member_ids) & selected:
            continue
        # Gates 2/3: policy gates (consent + non-pinned).
        if not u.get("allow_eviction"):
            continue
        if u.get("residency") == "pinned":
            continue
        # Gate 4: priority gate (strictly below the incoming work).
        if incoming_priority is not None and u.get("priority", 50) >= incoming_priority:
            continue
        # Gate 5: at least one loaded, idle, non-busy member.
        idle_timeout = u.get("idle_timeout", 300)
        evictable_members = []
        member_idles = []
        for d in members:
            mid = d.get("id")
            secs = idle_seconds(mid)
            member_idles.append((mid, secs))
            if d.get("state") not in ACTIVE_STATES:
                continue
            if inflight.get(mid, 0) > 0:
                continue
            if secs > idle_timeout:
                evictable_members.append(mid)
        if not evictable_members:
            continue
        # Unit recency = when the *most recently used* member was last used,
        # i.e. now - max(last_use). Expressed as "idle since" that use.
        last_uses = [
            ts
            for mid, ts in member_idles
            for ts in [last_use.get(mid)]
            if ts is not None
        ]
        most_recent = max(last_uses) if last_uses else 0.0
        unit_idle = max(0.0, now - most_recent)
        candidates.append(
            {
                "unit_id": u.get("id"),
                "unit_name": u.get("name"),
                "member_ids": member_ids,
                "evictable_members": evictable_members,
                "member_idle_seconds": dict(member_idles),
                "idle_seconds": round(unit_idle, 2),
                "priority": u.get("priority", 50),
                "residency": u.get("residency"),
                "requires_consent": True,
            }
        )

    candidates.sort(
        key=lambda c: (
            -c["idle_seconds"],
            c["priority"],
            c.get("unit_name") or "",
            c.get("unit_id") or "",
        )
    )
    return candidates
