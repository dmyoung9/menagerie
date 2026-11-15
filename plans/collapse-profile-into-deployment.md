# Collapse the `profile` entity into the deployment

## Intent

Remove the separate `profile` record from the Menagerie data model. A `profile` is the
pairing of **(artifact · runtime · config · raw_args · catalog)** and is currently
*derived* from a deployment at save/stop time (`api.py:972-996`) and *frozen* into a per-
deployment `profile_snapshot` on stop (`api.py:996,1023`). It has no user-facing UI in the
installed 3.0.0 (the nav is Overview/Models/Deployments/Activity/Settings; the `profiles`
slice is polled but never rendered). The user wants it gone.

**Decisions (owner, 2026-11-14):**
- **Drop** the 1 orphaned `profile` (the deleted mainline "Bonsai 2 (27B)", id `6b9f7cf0…`)
  and **discard all `profile` revision history** (no UI reads `GET /api/profiles/{id}/revisions`).
  Going forward, config history lives in each deployment's own versioned revision history.
- **Remove the `Profile` registry entity entirely.** Deployments carry the five fields
  directly. The serving layer keeps its per-deployment `profile_snapshot` field (it is a
  *frozen-at-load* temporal copy, not the entity) but **re-sources it from the deployment's
  own folded fields** instead of `store.get("profile", d["profile_id"])`. Serving behaviour is
  unchanged.

This is **two independent changes** that must land together:
1. **Code** — collapse the data model (schema + write path + serving + endpoints + frontend).
2. **Data** — a one-time registry migration that folds the 11 live profiles into their
   deployments, deletes the orphan, and deletes all `profile` history.

---

## Key facts for the implementer

- **Stored rows are raw dicts.** `Record` uses `ConfigDict(extra="forbid")` for *input*
  validation, but the `objects.data` column holds a free dict that also carries `state`,
  `profile_snapshot`, `revision`, etc. So a deployment row gains `artifact_id, runtime_id,
  config, raw_args, catalog` as raw-dict keys; only the *input* `Deployment` model needs them
  added (so the API accepts them in the body).
- **The `Profile` Pydantic model is only used for** (a) registry input validation of a profile
  record, and (b) the `POST /api/profiles` body. The adapters (`adapters.validate_profile`,
  `catalog.normalize`, `adapters.launch_spec`) and the snapshot all take **plain dicts**, so they
  keep working unchanged once they receive the deployment's folded fields.
- **`profile_snapshot` is read widely and must keep the same shape** (keys `artifact_id,
  runtime_id, config, raw_args, catalog`): read at `manager.py` (413,479,550,627,656,681,882,
  1081,1173,1364), `pool_edit.py` (98-114), `runtime_pool.py` (28-97), `model_setup.py`
  (150-161), `resources.py` (46-49), `api.py` (437,832,1530,1593,1722,1951,2041,2122).
  **Only the sites that *write* it (built from a profile) change.**
- **`store.delete(kind, id)` deletes only `objects`, not `revisions`.** Discarding profile
  history requires explicit `DELETE FROM revisions WHERE kind='profile'`.
- **`objects` stores a `revision` column; `revisions` holds the full history.** `store.put`
  bumps `objects.revision = max(current, historical_max)+1` and appends to `revisions`. In the
  migration (raw SQL, daemon stopped) bump each folded deployment's `objects.revision` by +1
  and insert a matching `revisions` row so the deployment history stays contiguous.
- The **"desired"/pending** machinery stores per-member `profile_snapshot` in `kind='desired'`
  rows (keyed by unit id): `model_setup.py` (`desired(store, unit_id)` → `store.get("desired", unit_id)`)
  and `apply_ops.py`. These must also be folded (or re-derived) — see step 7.

---

## Implementation Steps

### 1. Data model — `controlplane/schema.py`
- In the `Deployment` class (line 175+):
  - **Remove:** `profile_id: str | None = None` (line 177) and `configuration: Profile | None = None`.
  - **Add:** `artifact_id: str`, `runtime_id: str`, `config: dict = Field(default_factory=dict)`,
    `raw_args: list[str] = Field(default_factory=list)`, `catalog: dict = Field(default_factory=dict)`.
- **Remove** the `Profile` class entirely (schema.py, ~line 151: `class Profile(Record)` with
  `name, artifact_id, runtime_id, config, raw_args, catalog`). Update every import that pulls
  `Profile` (e.g. `controlplane/api.py` line 41; test imports — see step 9).
- Keep the **profile-shaped dict** as the internal snapshot/input shape: introduce a small
  helper (in `schema.py` or `resources.py`) so the five keys are not scattered:
  ```python
  PROFILE_FIELDS = ("artifact_id", "runtime_id", "config", "raw_args", "catalog")


  def profile_view(d: dict) -> dict:
      return {k: d.get(k, {}) for k in PROFILE_FIELDS}
  ```

### 2. Write path — `controlplane/api.py`, `save_member` (lines ~911-996)
Replace the profile-materialization block with folded-field validation:
```python
# (old: configuration = data.pop("configuration", None) … build/store a Profile …
#       data["profile_id"] = snapshot["id"])
if not data.get("artifact_id") or not data.get("runtime_id"):
    raise ValueError("Deployment requires artifact_id and runtime_id")
artifact = store.get("artifact", data["artifact_id"], c)
runtime = store.get("runtime", data["runtime_id"], c)
errors = adapters.validate_profile(profile_view(data), artifact, runtime)
if errors:
    raise ValueError("; ".join(errors))
data["catalog"] = normalize(profile_view(data), data["alias"])  # catalog.py:normalize
data.pop("profile_id", None)  # drop legacy key
```
- The "private revision backing / never mutate another deployment's recipe" guard
  (`api.py:985-992`) is **deleted** — with no shared-profile concept, each deployment's config
  is its own; the guard has no referent.
- The **"deployment configuration required"** check (`api.py:982`: `elif not data.get("profile_id")`)
  is replaced by the `artifact_id`/`runtime_id` check above.
- **Stop/start snapshot** (`api.py:996,1023`): replace `snapshot = store.get("profile", data["profile_id"], c)`
  with `snapshot = profile_view(data)`, then keep `data.update(state="STOPPED",
  profile_snapshot=snapshot, reservation_active=0)`.
- **Restore handlers** (`api.py` ~1530-1608, `profile_id=p["id"]` at 1565/1607): these restore
  from a profile by id. Rewrite to read the folded fields off the deployment (a restored
  unit's config is its own `artifact_id/runtime_id/config/raw_args/catalog`), not a profile row.

### 3. Serving/pool reads — keep `profile_snapshot`, fix the one fetch
- All `d["profile_snapshot"][… ]` read-sites (step-3 list above) are **unchanged** — the dict
  shape is identical.
- The one site that *fetches a profile* to fill config: `resources.py:244`
  `or manager.store.get("profile", d["profile_id"])` → change to `profile_view(d)`
  (the deployment itself is now the source).

### 4. Desired / pending state — `model_setup.py`, `apply_ops.py`, `queued_apply.py`
- `model_setup.py` builds/reads per-member `profile_snapshot` from desired rows. Ensure the
  code that *writes* a `kind='desired'` row (from the wizard save / `model_setup` apply path)
  projects each member's folded fields into its `profile_snapshot` (same `profile_view`),
  not a profile record. The `fingerprint(snap)`, `apply_ops._strip`, and "desired-vs-applied
  delta" logic operate on the member dicts and are unchanged.
- Confirm no desired row still carries `profile_id` after a save (grep `profile_id` in these
  modules; any remainder is a bug).

### 5. Remove the profile endpoints — `controlplane/api.py`
- Delete `POST /api/profiles` (lines 880-891) and `GET /api/profiles/{ident}/revisions`
  (lines 893-895).
- Remove `"profiles": "profile"` from the `kinds` map (line ~385) so
  `GET /api/registry/profiles` 404s.
- Ensure nothing else writes `kind="profile"` (grep `store.put("profile"`, `store.delete("profile"`)
  across the codebase; the only writer was the removed block.

### 6. Frontend
- **`frontend/src/types/index.ts`**: drop `Profile` and `ProfileDraft` types. On the `Deployment`
  type, remove `profile_id` and add `artifact_id: string`, `runtime_id: string`,
  `config: Record<string, JsonValue>`, `raw_args: string[]`, `catalog: Record<string, JsonValue>`.
- **`frontend/src/contracts.ts`**: remove the `profile` / `profileDraft` zod schemas and any
  `deployment.profile_id` / `deployment.configuration: Profile` fields; add the five folded
  fields to the `deployment` contract.
- **`frontend/src/editor-state.ts`**: remove the `profiles` editor state and `profileDraft`.
- **`frontend/src/App.tsx`**: remove the `profiles` slice — the `ENDPOINTS.profiles` entry
  (line 203-206), the `profiles: Profile[]` state (267/293/313/542), the
  `readApi('/api/profiles/${revisionId}/revisions', …)` effect (lines ~418-445), the revision
  modal path, and the `profiles: 'profile'` kind mapping (line 1304). (The nav never listed
  "profiles", so there is no nav item to delete.)
- **`frontend/src/DeploymentWizard.tsx`**: the save POST to `/api/model-setups` currently sends
  a top-level `configuration: {name, artifact_id, runtime_id, config, raw_args, catalog}`.
  Change it to send `artifact_id, runtime_id, config, raw_args, catalog` at top level of the
  deployment body (drop the `configuration` wrapper and the redundant `name` inside it). The
  inline `buildConfig()` and the `preview` construction (which build the config) are unchanged.
- **`frontend/src/Editors.tsx`**: remove the `kind === 'profiles'` branch — the profile form
  (~line 1620), the "Save revision" path (line 1756), and related draft mapping.
- **Unchanged** (they read the *serving* `profile_snapshot`, which keeps its shape):
  `ServingDeployments.tsx`, `Views.tsx`, `components/resource-history.tsx`,
  `components/history-settings.tsx`, `components/deployment-performance.tsx`.
- **Verify** the **Models** view (lists artifacts + their deployments) renders after the change
  and does not reference raw `profiles`.

### 7. Data migration (one-time, against the live registry)
Create a standalone script (e.g. `scripts/migrate_profile_collapse.py`, run from the repo root
against `~/.local/state/menagerie/`). It uses raw SQL on `registry.sqlite3` (daemon stopped).
For each `objects` row `kind='deployment'`:
1. Parse `data`; read `profile_id`.
2. If `profile_id` is set: load the profile row (`objects` kind='profile', id=profile_id);
   copy `artifact_id, runtime_id, config, raw_args, catalog` into the deployment dict.
3. `del deployment["profile_id"]`.
4. Bump the deployment's `objects.revision` by +1 and `INSERT` a matching row into `revisions`
   (same data/ts) to keep history contiguous.
5. **Also** convert each `kind='desired'` row: for every member that has a `profile_id`,
   fold the referenced profile's fields into that member and drop `profile_id` (same as above).
   This matters only if a unit had a pending delta at migration time; with none pending it is a no-op.
6. **Delete all profiles**: `DELETE FROM objects WHERE kind='profile'` (includes the orphan
   `6b9f7cf0…`) and `DELETE FROM revisions WHERE kind='profile'`.
Then **assert**: zero `profile` rows in `objects` and `revisions`; every deployment has all five
fields and no `profile_id`.

### 8. Rollback / backup
- Before the migration: **stop the daemon**, then copy the entire `~/.local/state/menagerie/`
  dir to a timestamped `.bak` (this is the rollback point). The migration script may also
  call `Store.backup()` (copies `registry.sqlite3` via `sqlite3.backup`).
- **Rollback** = restore the `.bak` registry **and** revert to the previous app build (the
  old release is retained at `app/previous` per the existing convention). Both halves must
  agree — restored (profile_id) data requires the old code; folded data requires the new code.

### 9. Run sequence (owner runs, in this order)
1. Stop the Menagerie daemon.
2. Back up the state dir (`.bak`).
3. Run the migration script; it prints its post-asserts.
4. Build the new code (repo is now the collapsed version) and install it: new build at
   `app/current`, prior retained at `app/previous`.
5. Start the daemon.
6. Run the verification checks below.

---

## Verification Criteria (state-based; **no live inference in CI**, no thermal/hardware-fit claims)

**Migration (read-only, daemon stopped, before installing new code):**
- [ ] No `profile` rows in `objects` or `revisions`.
- [ ] All 11 deployments have `artifact_id`, `runtime_id`, `config`, `raw_args`, `catalog`; none has `profile_id`.
- [ ] No orphan profile remains.

**After install + daemon start (state-level):**
- [ ] `GET /api/status` → healthy.
- [ ] `GET /api/registry/profiles` → **404**; `POST /api/profiles` → **404**;
    `GET /api/profiles/<id>/revisions` → **404**.
- [ ] `GET /api/registry/deployments` returns deployments with the five folded fields; a sample
    row has no `profile_id`.
- [ ] Both engine pools unchanged: `GET /api/serving-deployments` shows LFM3 = 6 members
    `READY`, Ternary Bonsai = 5 members `READY`, `engine_pool=true`, priority 50, 0 standalone.
- [ ] **Snapshot re-sourcing**: `POST /api/serving-deployments/<id>/stop` on one deployment (e.g.
    a 9B) → its row gains a `profile_snapshot` with `artifact_id/runtime_id/config/raw_args/catalog`
    sourced from the deployment's own fields, and still no `profile_id`; then restart it →
    returns to `READY`. (This *loads* the model — a warm reload, proportionate and consistent
    with the prior engine-pool migration; it is a state transition, not a token-generation
    test. If the owner prefers strictly no-model-load, skip and rely on the registry + pool
    state checks.)
- [ ] A serving deployment's `profile_hash` (via `GET /api/status` host metrics or the serving
    row) is computable from the folded `profile_snapshot` — i.e. pools still fingerprint correctly.

**Frontend:**
- [ ] `npm run typecheck && npm run lint && npm run build` green; Playwright smoke: no "profiles"
    nav item; the Deployment Wizard creates a deployment that stores the five folded fields
    (verify via `GET /api/registry/deployments`); the Models view renders.

**Regression (state-based):**
- [ ] Pool/eviction logic still groups members by the (now-folded) snapshot runtime:
    `runtime_pool`/`pool_edit` unit tests pass; a `GET /api/serving-deployments` reflects
    correct shared-runtime grouping.
- [ ] No 500s on the serving/pool endpoints; `GET /api/status` request totals unchanged in shape.

**Repo checks (per `docs/development.md` / `docs/testing.md`):**
- [ ] Backend: Ruff lint/format + pytest green (tests updated per step 9-note below).
- [ ] Frontend: typecheck, ESLint, Prettier, build, unit, Playwright.
- [ ] Plugin checks unaffected (the plugin does not touch profiles).

---

## References

- **Store schema & semantics** — `controlplane/store.py`: `objects`/`revisions` tables
  (lines 52-57), `put` (bumps revision + appends history; `expected` check), `delete`
  (objects only), `history` (reads `revisions`).
- **Write path to rewrite** — `controlplane/api.py` `save_member` lines 911-996 (profile
  materialization + private-revision guard); stop/start snapshot lines 996/1023; restore
  handlers ~1530-1608.
- **Snapshot read-sites** (keep unchanged) — `manager.py`, `pool_edit.py`, `runtime_pool.py`,
  `model_setup.py`, `resources.py`, `api.py` (list in step-3 key facts).
- **Adapters unchanged in signature** — `adapters.validate_profile(profile, artifact, runtime)`,
  `adapters.launch_spec(deployment, profile, artifact, runtime, workdir, store)`,
  `catalog.normalize(profile, alias)` all take plain dicts.
- **Precedent for a data migration with backup + state verification** —
  `journal/2026-11-13-menagerie-engine-pool-migration.md` (self-detaching worker, stop→edit→
  start, pre-migration backup, post-migration read-only registry asserts, state-only claims).
- **Check contract** — `docs/development.md` (checks/builds), `docs/testing.md` (integration
  checks; no live inference in CI).
- **Owner decisions (2026-11-14):** drop orphaned profile + all profile revision history; remove
  the `Profile` entity entirely (serving re-sources `profile_snapshot` from the deployment).

### Tests to update / remove (step "Tests")
- `tests/test_product_api.py` — the `POST /api/profiles` (line 112) and
  `GET /api/profiles?expected=1` (line 136) tests become deployment-creation tests (send the five
  folded fields, assert they land on the deployment row).
- `tests/test_controlplane.py` — `GET /api/profiles?expected=0` (line 383) → update.
- `tests/test_frontend_contracts.py` — construct deployments with the five folded fields
  (drop `configuration: Profile(...)` at line 172); remove the
  `GET /api/profiles/profile/revisions` call (line 166).
- `tests/test_configuration_contracts.py` — the `Profile(...)` construction (line 18) → a
  profile-shaped dict / deployment fields; `validate_profile` still takes a dict.
- Add a test asserting a fresh registry with 0 profiles creates a deployment that stores the
  five folded fields and that a stop populates `profile_snapshot` from them.
