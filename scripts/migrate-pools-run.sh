#!/usr/bin/env bash
#
# migrate-pools-run.sh — ONE-TIME, unattended runner for the pool-ownership
# registry migration + new-app install + daemon restart.
#
# Why it is safe to run while I (the agent) am offline:
#   * The single IRREVERSIBLE step (the registry rewrite) runs LAST, immediately
#     before `start`. Everything before it (build / app install) is either a
#     no-op or reversible with `install.sh --rollback`.
#   * Invariant: code and data must always agree (OLD/OLD or NEW/NEW) — never
#     NEW-data/OLD-code or OLD-data/NEW-code. On any failure at/after the
#     migration we restore the pre-migration registry AND roll the app back to
#     `previous`, then start the OLD (known-good) daemon.
#   * Every step is written to $REPORT_DIR/run.log; a machine-readable
#     $REPORT_DIR/status.txt is the first thing the session reads on resume.
#
# Exit codes:
#   0  SUCCESS — NEW code + NEW data; daemon healthy; pool shape verified.
#   1  ABORTED/RECOVERED to OLD/OLD with the OLD daemon running (safe; inspect
#       the log to see which step failed and why).
#   2  HARD FAIL — could not return to a RUNNING OLD/OLD state (inspect log).
#
set -uo pipefail   # deliberately NOT -e: every branch must end in a safe state.

# Paths are derived or overridable so the runner is safe to commit without the
# owner's machine-specific layout. Override with WORKTREE / STATE / APP env vars.
WORKTREE="${WORKTREE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE="${STATE:-$HOME/.local/state/menagerie}"
REG="${STATE}/registry.sqlite3"
APP="${APP:-$HOME/.local/share/menagerie/app}"
API_PORT=8017
SERVICE="menagerie.service"
WHEEL="${WORKTREE}/dist/menagerie-3.0.0-py3-none-any.whl"
CONSTRAINTS="${WORKTREE}/dist/menagerie-3.0.0-requirements.txt"

TS="$(date +%Y%m%d-%H%M%S)"
REPORT_DIR="${HOME}/menagerie-migration-${TS}"
LOG="${REPORT_DIR}/run.log"
STATUS_FILE="${REPORT_DIR}/status.txt"
REG_BAK="${REPORT_DIR}/registry.sqlite3.prebak"
mkdir -p "$REPORT_DIR"
: > "$LOG"

log(){ printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

# ---------------------------------------------------------------------------
APP_INSTALLED=0   # became 1 once install.sh swapped current->new
DATA_MIGRATED=0   # became 1 once the registry rewrite committed

start_daemon(){
  log "systemctl --user start $SERVICE ..."
  systemctl --user start "$SERVICE" 2>&1 | tee -a "$LOG"
  local i
  for i in $(seq 1 60); do
    if systemctl --user is-active --quiet "$SERVICE"; then sleep 2; return 0; fi
    sleep 2
  done
  log "daemon not active within ~120s"
  return 1
}

wait_stop(){
  log "systemctl --user stop $SERVICE ..."
  systemctl --user stop "$SERVICE" 2>&1 | tee -a "$LOG"
  local i
  for i in $(seq 1 46); do
    if systemctl --user is-active --quiet "$SERVICE"; then sleep 2; else
      log "daemon stopped."
      return 0
    fi
  done
  log "WARNING: $SERVICE still active after 90s"
  return 1
}

# Pre-migration failure: nothing irreversible happened. Restore the OLD daemon.
abort_clean(){
  log "ABORT BEFORE IRREVERSIBLE STEP: $*"
  log "current -> $(readlink -f "$APP/current")   previous -> $(readlink -f "$APP/previous")"
  if start_daemon; then
    sleep 3
    if systemctl --user is-active --quiet "$SERVICE"; then
      printf 'STATUS: ABORTED before migration; OLD daemon restored; no data/code changes.\n' > "$STATUS_FILE"
      log "RESULT: $(cat "$STATUS_FILE")"
      exit 1
    fi
  fi
  printf 'STATUS: FAILED — abort ran but OLD daemon not running. Log: %s\n' "$LOG" > "$STATUS_FILE"
  log "RESULT: $(cat "$STATUS_FILE")"
  exit 2
}

# At/after-migration failure: restore data + roll app back + start OLD daemon.
recover(){
  log "=== RECOVERY: restore to OLD/OLD and start OLD daemon ==="
  wait_stop
  if [[ "$DATA_MIGRATED" -eq 1 ]]; then
    log "Restoring pre-migration registry from $REG_BAK ..."
    rm -f "$REG-wal" "$REG-shm"
    cp "$REG_BAK" "$REG"
    if [[ -f "${REG_BAK}-wal" ]]; then cp "${REG_BAK}-wal" "${REG}-wal"; fi
    chmod 600 "$REG"
    log "Registry restored."
  fi
  if [[ "$APP_INSTALLED" -eq 1 ]]; then
    log "install.sh --rollback ..."
    bash "$WORKTREE/install.sh" --rollback >>"$LOG" 2>&1
    log "current -> $(readlink -f "$APP/current")   previous -> $(readlink -f "$APP/previous")"
  fi
  if start_daemon; then
    sleep 3
    if systemctl --user is-active --quiet "$SERVICE"; then
      printf 'STATUS: RECOVERED to OLD/OLD; OLD daemon running; NEW build NOT applied. Inspect %s before retry.\n' "$LOG" > "$STATUS_FILE"
      log "RESULT: $(cat "$STATUS_FILE")"
      exit 1
    fi
  fi
  printf 'STATUS: FAILED — recovery ran but OLD daemon not running. Log: %s\n' "$LOG" > "$STATUS_FILE"
  log "RESULT: $(cat "$STATUS_FILE")"
  exit 2
}

# State-based shape checks (no inference). New code must serve the pool rows.
verify(){
  local code body
  log "Verify (state-based; no inference):"
  curl -fsS "http://127.0.0.1:${API_PORT}/api/status" >/dev/null 2>&1 \
    && log "  OK  /api/status 200" || { log "  FAIL /api/status"; return 1; }

  # Pools: two engine pools, each now owns runtime_id + a non-null port.
  body="$(curl -fsS "http://127.0.0.1:${API_PORT}/api/registry/deployment_sets")" \
    || { log "  FAIL /api/registry/deployment_sets not 200"; return 1; }
  if printf '%s' "$body" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
ok = isinstance(rows, list) and len(rows) == 2
for r in (rows if ok else []):
    if not r.get("engine_pool"):
        ok = False; break
    if not r.get("runtime_id") or r.get("port") is None:
        ok = False; break
print(("  OK %d engine pools own runtime_id+port" % len(rows)) if ok else "  FAIL pool shape")
sys.exit(0 if ok else 1)
' >>"$LOG" 2>&1; then :; else
    log "  FAIL pool shape"; return 1; fi

  # Members: 11 pooled members, each port=null, runtime_id present.
  body="$(curl -fsS "http://127.0.0.1:${API_PORT}/api/registry/deployments")" \
    || { log "  FAIL /api/registry/deployments not 200"; return 1; }
  if printf '%s' "$body" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
ok = isinstance(rows, list) and len(rows) == 11
if ok:
    for r in rows:
        if r.get("port") is not None:
            ok = False; break
        if not r.get("engine_pool"):
            ok = False; break
        if not r.get("runtime_id"):
            ok = False; break
print(("  OK %d pooled members: engine_pool, port=null, runtime_id present" % len(rows)) if ok else "  FAIL member shape")
sys.exit(0 if ok else 1)
' >>"$LOG" 2>&1; then :; else
    log "  FAIL member shape"; return 1; fi

  curl -fsS "http://127.0.0.1:${API_PORT}/api/serving-deployments" >/dev/null 2>&1 \
    && log "  OK  /api/serving-deployments 200" || { log "  FAIL /api/serving-deployments"; return 1; }
  return 0
}

log "==== pools-ownership migration runner ===="
log "worktree: $WORKTREE | state: $STATE | api port: $API_PORT"
log "report:   $REPORT_DIR"

# 1. stop
if ! wait_stop; then abort_clean "daemon would not stop in time"; fi

# 2. backup registry (consistent: daemon stopped)
log "Backing up registry (daemon stopped) -> $REG_BAK"
if ! cp "$REG" "$REG_BAK"; then abort_clean "registry backup copy failed"; fi
if [[ -f "${REG}-wal" ]]; then cp "${REG}-wal" "${REG_BAK}-wal"; fi
log "Registry backup done: $(du -h "$REG_BAK" | cut -f1)"

# 3. ensure the NEW wheel is built
if ! [[ -f "$WHEEL" ]]; then
  log "Building wheel (uv build) ..."
  ( cd "$WORKTREE" && uv build ) >>"$LOG" 2>&1
  if [[ $? -ne 0 ]]; then abort_clean "uv build failed"; fi
fi
if ! [[ -f "$WHEEL" ]]; then abort_clean "wheel $WHEEL missing after build"; fi
if ! [[ -f "$CONSTRAINTS" ]]; then abort_clean "constraints $CONSTRAINTS missing"; fi
log "Wheel ready: $WHEEL"

# 4. install the new app (swaps current->new, previous->old); daemon stays stopped
log "install.sh --wheel ... --yes (swaps current->new, keeps previous) ..."
bash "$WORKTREE/install.sh" --wheel "$WHEEL" --constraints "$CONSTRAINTS" --yes >>"$LOG" 2>&1
if [[ $? -ne 0 ]]; then abort_clean "install.sh failed (app not swapped; daemon will be OLD)"; fi
APP_INSTALLED=1
log "App installed. current -> $(readlink -f "$APP/current")   previous -> $(readlink -f "$APP/previous")"

# 5a. dry-run the registry rewrite (preview only; rolls back itself)
log "Dry-run registry migration (scripts/migrate_pools_ownership.py) ..."
python3 "$WORKTREE/scripts/migrate_pools_ownership.py" --dry-run --state "$STATE" >>"$LOG" 2>&1
if [[ $? -ne 0 ]]; then abort_clean "migration dry-run failed (no changes yet)"; fi

# 5b. apply the registry migration (IRREVERSIBLE — only now, code already NEW)
log "Applying registry migration (scripts/migrate_pools_ownership.py) ..."
python3 "$WORKTREE/scripts/migrate_pools_ownership.py" --state "$STATE" >>"$LOG" 2>&1
if [[ $? -ne 0 ]]; then recover; else DATA_MIGRATED=1; fi
log "Registry migration committed; DATA_MIGRATED=$DATA_MIGRATED"

# 6. start the daemon on NEW code + NEW data
if ! start_daemon; then recover; fi

# 7. verify the NEW shape over the API
if ! verify; then recover; fi

printf 'STATUS: SUCCESS — NEW code + NEW data; daemon healthy; pool shape verified.\n' > "$STATUS_FILE"
log "RESULT: $(cat "$STATUS_FILE")"
exit 0
