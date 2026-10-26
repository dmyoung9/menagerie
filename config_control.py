"""Typed preset drafts and crash-recoverable, explicitly requested shelf changes.

The dashboard can draft/queue in its own state directory. Only the separate
menagerie-apply@.service worker can write the shelf. No arbitrary paths, commands,
model artifacts, global defaults, or runtime safety limits are accepted from HTTP.
"""
import argparse
import configparser
from contextlib import contextmanager
import difflib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import threading
import time
import uuid

HOME = Path.home()
STATE = Path(os.environ.get('XDG_STATE_HOME', HOME / '.local/state')) / 'menagerie'
TRIALS = HOME / 'ai/qwen38-trials'
ACTIVE = ('queued', 'preflight', 'stopping', 'writing', 'starting', 'verifying', 'rolling_back')
TERMINAL = ('succeeded', 'rolled_back', 'failed', 'recovery_required', 'discarded')


def number(label, kind, low, high, step=1):
    return {'label': label, 'type': kind, 'min': low, 'max': high, 'step': step}


FIELDS = {
    'ctx-size': number('Total context pool', 'int', 1024, 262144, 1024),
    'parallel': number('Parallel slots', 'int', 1, 8),
    'cache-type-k': {'label': 'K cache precision', 'type': 'enum', 'choices': ['f16', 'q8_0', 'q4_0']},
    'cache-type-v': {'label': 'V cache precision', 'type': 'enum', 'choices': ['f16', 'q8_0', 'q4_0']},
    'batch-size': number('Logical batch size', 'int', 32, 4096, 32),
    'ubatch-size': number('Physical batch size', 'int', 32, 2048, 32),
    'threads': number('Decode CPU threads', 'int', 1, 24),
    'threads-batch': number('Prefill CPU threads', 'int', 1, 24),
    'n-cpu-moe': number('CPU expert layers (existing MoE preset only)', 'int', 0, 64),
    'cache-ram': number('Prompt cache RAM (MiB)', 'int', 0, 8192, 256),
    'ctx-checkpoints': number('Context checkpoints', 'int', 0, 64),
    'sleep-idle-seconds': number('Idle sleep (seconds)', 'int', 30, 3600, 30),
    'reasoning-budget': number('Reasoning token budget', 'int', 0, 8192, 128),
    'temp': number('Temperature', 'float', 0, 2, .05),
    'top-p': number('Top P', 'float', .01, 1, .01),
    'top-k': number('Top K', 'int', 0, 200),
    'min-p': number('Min P', 'float', 0, 1, .01),
    'presence-penalty': number('Presence penalty', 'float', -2, 2, .1),
    'repeat-penalty': number('Repeat penalty', 'float', .5, 2, .05),
}


class ControlError(Exception):
    def __init__(self, message, code=409):
        super().__init__(message)
        self.code = code


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def read_preset(path):
    return path.read_bytes().decode('utf-8')


def primitive_value(key, value):
    # Preserve JSON/template strings verbatim; only typed primitive fields can
    # have a trailing INI comment removed for validation and display.
    return re.split(r'\s+[;#]', value, maxsplit=1)[0].strip() if key in FIELDS and isinstance(value, str) else value


def parse(text):
    p = configparser.ConfigParser(interpolation=None, strict=True)
    try:
        p.read_string('[__global__]\n' + text)
    except configparser.Error as exc:
        raise ControlError(f'Preset cannot be edited safely: {exc}', 400) from exc
    if p.get('__global__', 'version', fallback='') != '1':
        raise ControlError('Only version=1 preset files are supported', 400)
    defaults = dict(p['*']) if p.has_section('*') else {}
    return {s: {k: primitive_value(k, v) for k, v in (defaults | dict(p[s])).items()}
            for s in p.sections() if s not in ('*', '__global__')}


def normalize(key, value):
    spec = FIELDS.get(key)
    if not spec or isinstance(value, (dict, list, bool)) or value is None:
        raise ControlError(f'Unsupported setting or value: {key}', 400)
    text = str(value).strip()
    if spec['type'] == 'enum':
        if text not in spec['choices']:
            raise ControlError(f'{key}: choose one of {spec["choices"]}', 400)
        return text
    try:
        n = float(text)
    except ValueError as exc:
        raise ControlError(f'{key}: number required', 400) from exc
    if not math.isfinite(n) or not spec['min'] <= n <= spec['max']:
        raise ControlError(f'{key}: expected {spec["min"]}–{spec["max"]}', 400)
    if spec['type'] == 'int' and not n.is_integer():
        raise ControlError(f'{key}: integer required', 400)
    return str(int(n)) if spec['type'] == 'int' else format(n, '.8g')


def patch_preset(base, model, changes):
    models = parse(base)
    if model not in models:
        raise ControlError('Choose an existing shelf.ini model section', 400)
    if not isinstance(changes, dict) or not 1 <= len(changes) <= len(FIELDS):
        raise ControlError('Provide a bounded, non-empty setting map', 400)
    normalized = {k: normalize(k, v) for k, v in changes.items()}
    if 'n-cpu-moe' in normalized and 'n-cpu-moe' not in models[model]:
        raise ControlError('CPU expert offload is only editable on an existing MoE preset', 400)
    proposed = models[model] | normalized
    if int(proposed.get('ctx-size', 0)) // int(proposed.get('parallel', 1)) < 1024:
        raise ControlError('At least 1,024 context tokens per slot are required', 400)
    if int(proposed.get('ubatch-size', 512)) > int(proposed.get('batch-size', 2048)):
        raise ControlError('Physical batch must not exceed logical batch', 400)
    # Only replace declared primitive values inside this one section. Unknown
    # options, artifacts, section order and comments remain byte-for-byte intact.
    lines = base.splitlines(keepends=True)
    newline = '\r\n' if '\r\n' in base else '\n'
    start = next((i for i, line in enumerate(lines) if line.strip() == f'[{model}]'), None)
    if start is None:
        raise ControlError('This editor requires a plain model section header on its own line', 400)
    end = next((i for i in range(start+1, len(lines)) if re.match(r'^\s*\[', lines[i])), len(lines))
    remaining = normalized.copy()
    for i in range(start+1, end):
        match = re.match(r'^(\s*)([\w-]+)(\s*=\s*)(.*?)(\r?\n)?$', lines[i])
        if match and match[2] in remaining:
            suffix = re.search(r'\s+[;#].*$', match[4])
            lines[i] = match[1] + match[2] + match[3] + remaining.pop(match[2]) + (suffix[0] if suffix else '') + (match[5] or '')
    if remaining:
        if end and not lines[end-1].endswith('\n'):
            lines[end-1] += newline
        lines[end:end] = [f'{k} = {v}{newline}' for k, v in remaining.items()]
    candidate = ''.join(lines)
    parse(candidate)
    if candidate == base:
        raise ControlError('No settings changed', 400)
    return candidate, normalized


@contextmanager
def db(state):
    c = sqlite3.connect(state / 'control.sqlite3', timeout=10)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA synchronous=FULL')
    try:
        with c:
            yield c
    finally:
        c.close()


def initialize(state):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with db(state) as c:
        c.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, created REAL NOT NULL, updated REAL NOT NULL,
            status TEXT NOT NULL, model TEXT NOT NULL, base_sha TEXT NOT NULL,
            candidate_sha TEXT NOT NULL, base TEXT NOT NULL, candidate TEXT NOT NULL,
            changes TEXT NOT NULL, detail TEXT NOT NULL, runtime_before TEXT,
            evidence TEXT, parent TEXT);
          CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs((1))
          WHERE status IN ('queued','preflight','stopping','writing','starting','verifying','rolling_back');
        ''')
    os.chmod(state / 'control.sqlite3', 0o600)


def job_id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
        raise ControlError('Invalid draft ID', 400)
    return value


class Store:
    def __init__(self, state=STATE, trials=TRIALS):
        self.state, self.trials = Path(state), Path(trials)
        self.path = self.trials / 'shelf.ini'
        initialize(self.state)

    @property
    def per_model(self):
        import shelf_bridge
        return shelf_bridge.enabled(self.trials)

    def require_legacy_editor(self):
        if self.per_model:
            raise ControlError('The shelf now uses shelf/models/*.toml. Edit those files and run shelf_config.py check/apply; this legacy INI editor is read-only.', 409)

    def current(self):
        if self.per_model:
            import shelf_bridge
            configuration = shelf_bridge.candidate(self.trials)
            return {'base_sha': configuration['fingerprint'],
                    'models': shelf_bridge.inventory(self.trials, configuration), 'fields': FIELDS,
                    'read_only': True, 'source_directory': str(self.trials / 'shelf/models')}
        text = read_preset(self.path)
        return {'base_sha': digest(text), 'models': parse(text), 'fields': FIELDS}

    def get(self, ident):
        with db(self.state) as c:
            row = c.execute('SELECT * FROM jobs WHERE id=?', (job_id(ident),)).fetchone()
        if row is None:
            raise ControlError('Draft not found', 404)
        data = dict(row)
        for k in ('changes', 'runtime_before', 'evidence'):
            data[k] = json.loads(data[k]) if data[k] else None
        return data

    def public(self, job):
        result = {k: v for k, v in job.items() if k not in ('base', 'candidate', 'runtime_before')}
        result['diff'] = ''.join(difflib.unified_diff(job['base'].splitlines(True), job['candidate'].splitlines(True), fromfile='shelf.ini · current', tofile='shelf.ini · proposed'))
        result['snapshot'] = str(self.state / 'snapshots' / (job['id'] + '.ini')) if job['runtime_before'] else None
        return result

    def history(self):
        with db(self.state) as c:
            ids = [r[0] for r in c.execute('SELECT id FROM jobs ORDER BY created DESC LIMIT 30')]
        return [self.public(self.get(ident)) for ident in ids]

    def attention(self):
        with db(self.state) as c:
            row = c.execute("SELECT id,status,detail FROM jobs WHERE status IN ('queued','preflight','stopping','writing','starting','verifying','rolling_back','recovery_required') ORDER BY updated DESC LIMIT 1").fetchone()
        return dict(row) if row else None

    def save_draft(self, model, base, candidate, changes, parent=None):
        ident, now = uuid.uuid4().hex, time.time()
        with db(self.state) as c:
            c.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                      (ident, now, now, 'draft', model, digest(base), digest(candidate), base, candidate,
                       json.dumps(changes), 'Review the diff. Nothing has been applied.', None, None, parent))
        return self.public(self.get(ident))

    def draft(self, model, changes, base_sha):
        self.require_legacy_editor()
        base = read_preset(self.path)
        if digest(base) != base_sha:
            raise ControlError('shelf.ini changed since you opened it. Reload before drafting.')
        candidate, normalized = patch_preset(base, model, changes)
        return self.save_draft(model, base, candidate, normalized)

    def rollback_draft(self, ident):
        self.require_legacy_editor()
        previous = self.get(ident)
        if previous['status'] != 'succeeded':
            raise ControlError('Only a successful apply can be reverted')
        current = read_preset(self.path)
        if digest(current) != previous['candidate_sha']:
            raise ControlError('The current file is not this revision. Refusing to overwrite later edits.')
        return self.save_draft(previous['model'], current, previous['base'], {'restore_revision': ident}, parent=ident)

    def discard(self, ident):
        with db(self.state) as c:
            changed = c.execute("UPDATE jobs SET status='discarded',updated=?,detail='Discarded without touching the shelf.' WHERE id=? AND status='draft'",
                                (time.time(), job_id(ident))).rowcount
        if not changed:
            raise ControlError('Only an unsubmitted draft can be discarded')
        return self.public(self.get(ident))

    def update(self, ident, status, detail, **kwargs):
        if status not in ACTIVE + TERMINAL:
            raise ValueError('Unknown transaction state')
        if set(kwargs) - {'runtime_before', 'evidence'}:
            raise ValueError('Unsupported state update')
        with db(self.state) as c:
            c.execute('UPDATE jobs SET status=?,detail=?,updated=?' + ''.join(f',{key}=?' for key in kwargs) + ' WHERE id=?',
                      (status, detail, time.time(), *[json.dumps(v) for v in kwargs.values()], ident))

    def queue(self, ident, confirmation, quiescent, launch):
        self.require_legacy_editor()
        if confirmation != 'RESTART SHELF' or quiescent is not True:
            raise ControlError('Confirm RESTART SHELF and that all model clients are paused', 400)
        job = self.get(ident)
        if digest(read_preset(self.path)) != job['base_sha']:
            raise ControlError('The draft is stale. Rebuild it from the current file.')
        if job['base_sha'] == job['candidate_sha']:
            raise ControlError('Empty change', 400)
        with db(self.state) as c:
            c.execute('BEGIN IMMEDIATE')
            if c.execute("SELECT 1 FROM jobs WHERE status='recovery_required' LIMIT 1").fetchone():
                raise ControlError('Resolve the existing recovery-required transaction before another apply')
            try:
                changed = c.execute("UPDATE jobs SET status='queued',updated=?,detail=? WHERE id=? AND status='draft'",
                                    (time.time(), 'Accepted. Waiting for the isolated apply worker.', job_id(ident))).rowcount
            except sqlite3.IntegrityError as exc:
                raise ControlError('Another configuration transaction is active') from exc
            if not changed:
                raise ControlError('This draft has already been submitted')
        try:
            launch(ident)
        except Exception as exc:
            self.update(ident, 'failed', f'Worker could not be started: {exc}')
            raise ControlError('Worker could not be started; shelf untouched', 503) from exc
        return self.public(self.get(ident))


@contextmanager
def exclusive(state):
    with (state / 'apply.lock').open('a') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ControlError('Another apply/recovery worker owns the shelf') from exc
        yield


def ensure_target(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
        raise ControlError('Refusing a symlink, non-regular or foreign-owned preset')


def atomic_write(path, text, expected):
    ensure_target(path)
    if digest(read_preset(path)) != expected:
        raise ControlError('Preset changed outside Menagerie; refusing to overwrite it')
    mode = stat.S_IMODE(path.stat().st_mode)
    fd, name = tempfile.mkstemp(prefix='.menagerie-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text); f.flush(); os.fsync(f.fileno())
            os.fchmod(f.fileno(), mode)
        if digest(read_preset(path)) != expected:
            raise ControlError('Preset changed during preparation; refusing to overwrite it')
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Runtime:
    """Fixed services and loopback inference; never constructed by draft routes."""
    def __init__(self):
        import menagerie
        self.core = menagerie

    def systemctl(self, *args):
        return self.core.command(['systemctl', '--user', *args], timeout=75)

    def inspect(self):
        props = json.loads(self.core.fetch('/props')[0])
        if props.get('build_info') != self.core.SAFE_METRICS_BUILD:
            raise ControlError('Apply is disabled on unreviewed Prism builds')
        models = json.loads(self.core.fetch('/models')[0])['data']
        if any(m.get('status', {}).get('value') not in ('sleeping', 'unloaded') for m in models):
            raise ControlError('Shelf is not quiet. Pause clients and wait for all models to sleep.')
        if self.systemctl('show', 'llama-shelf.service', '-p', 'ActiveState', '--value').strip() != 'active':
            raise ControlError('Shelf must already be active; Menagerie will not start a deliberately stopped shelf')
        timer = self.systemctl('show', 'llama-shelf-watchdog.timer', '-p', 'ActiveState', '--value').strip()
        return {'build': props['build_info'], 'watchdog_active': timer == 'active'}

    def pause_watchdog(self):
        self.systemctl('stop', 'llama-shelf-watchdog.timer', 'llama-shelf-watchdog.service')

    def restore_watchdog(self, before):
        if before['watchdog_active']:
            self.systemctl('start', 'llama-shelf-watchdog.timer')

    def stop(self):
        self.systemctl('stop', 'llama-shelf.service')

    def start(self):
        self.systemctl('reset-failed', 'llama-shelf.service')
        self.systemctl('start', 'llama-shelf.service')

    def resources(self, startup=False):
        g, mem = self.core.gpu_sample(), self.core.memory_sample()
        if g.get('free') is None or g.get('temperature') is None:
            raise ControlError('GPU telemetry is incomplete')
        if g['free'] < (14000 if startup else 2048) or mem['available_mib'] < 4096 or g['temperature'] >= 85:
            raise ControlError(f'Unsafe resources: {g["free"]} MiB GPU free, {mem["available_mib"]:.0f} MiB RAM, {g["temperature"]} °C')
        return {'free_mib': g['free'], 'ram_available_mib': mem['available_mib'], 'temperature_c': g['temperature']}

    def wait_config(self, text, model):
        expected = parse(text)[model]
        deadline = time.monotonic() + 35
        last = None
        while time.monotonic() < deadline:
            try:
                props = json.loads(self.core.fetch('/props')[0])
                if props.get('build_info') != self.core.SAFE_METRICS_BUILD:
                    raise ControlError('Runtime build changed during apply')
                models = json.loads(self.core.fetch('/models')[0])['data']
                row = next((m for m in models if m['id'] == model), None)
                if row:
                    drift = self.core.config_drift(expected, self.core.preset_options(row['status']['preset']))
                    if drift:
                        raise ControlError('Effective preset mismatch: ' + json.dumps(drift))
                    return {'options': self.core.preset_options(row['status']['preset']),
                            'argv': row['status'].get('args', [])}
                last = 'Model missing from router'
            except (OSError, ValueError) as exc:
                last = str(exc)
            time.sleep(.5)
        raise ControlError(f'Router did not become ready: {last}')

    def verify(self, text, model):
        effective = self.wait_config(text, model)
        self.resources(startup=True)
        # A short smoke request, NOT a near-limit context or quality grade. Its
        # bounded output may fail for a reasoning-only answer; failure rolls back.
        result, done = {}, threading.Event()
        payload = {'model': model, 'messages': [{'role': 'user', 'content': 'Reply with the single word READY.'}],
                   'max_tokens': 512, 'stream': False}
        def smoke():
            from urllib.request import Request, build_opener, ProxyHandler
            try:
                opener = build_opener(ProxyHandler({}), self.core.NoRedirect())
                body = json.dumps(payload).encode()
                started = time.monotonic()
                with opener.open(Request('http://127.0.0.1:8001/v1/chat/completions', data=body,
                                         headers={'Content-Type': 'application/json'}, method='POST'), timeout=100) as response:
                    data = json.loads(response.read(1024*1024))
                content = data.get('choices', [{}])[0].get('message', {}).get('content')
                if not isinstance(content, str) or not content.strip():
                    raise ControlError('Smoke request produced no final answer within 512 output tokens')
                result.update(answer=content[:2000], usage=data.get('usage'), elapsed_s=round(time.monotonic()-started, 3))
            except Exception as exc:
                result['error'] = str(exc)
            finally:
                done.set()
        threading.Thread(target=smoke, daemon=True).start()
        evidence = {'scope': 'Short inference only; near-limit context and quality remain unverified',
                    'effective_config': effective,
                    'request': payload, 'prompt_sha': digest(json.dumps(payload['messages'], sort_keys=True)),
                    'minimum_free_mib': float('inf'), 'maximum_temperature_c': 0}
        deadline = time.monotonic() + 110
        while True:
            r = self.resources()
            evidence['minimum_free_mib'] = min(evidence['minimum_free_mib'], r['free_mib'])
            evidence['maximum_temperature_c'] = max(evidence['maximum_temperature_c'], r['temperature_c'])
            if done.wait(.5):
                # Check headroom after the final response as well.
                r = self.resources()
                evidence['minimum_free_mib'] = min(evidence['minimum_free_mib'], r['free_mib'])
                break
            if time.monotonic() > deadline:
                raise ControlError('Smoke request timed out')
        if 'error' in result:
            raise ControlError('Smoke request failed: ' + result['error'])
        return evidence | result


def snapshot(store, job):
    folder = store.state / 'snapshots'
    folder.mkdir(mode=0o700, exist_ok=True)
    path = folder / (job['id'] + '.ini')
    with path.open('x') as f:
        os.chmod(path, 0o600)
        f.write(job['base']); f.flush(); os.fsync(f.fileno())


def validate_job(store, job):
    if digest(job['base']) != job['base_sha'] or digest(job['candidate']) != job['candidate_sha']:
        raise ControlError('Stored draft checksum mismatch')
    if job['parent']:
        parent = store.get(job['parent'])
        if (parent['status'] != 'succeeded' or job['changes'] != {'restore_revision': parent['id']}
                or job['base'] != parent['candidate'] or job['candidate'] != parent['base']
                or job['model'] != parent['model']):
            raise ControlError('Stored revert does not match its successful parent revision')
    else:
        expected, _ = patch_preset(job['base'], job['model'], job['changes'])
        if expected != job['candidate']:
            raise ControlError('Stored candidate does not match its typed, reviewed changes')


def restore(store, job, runtime, reason):
    before = job['runtime_before']
    if before is None:
        store.update(job['id'], 'failed', reason + ' Shelf untouched.')
        return
    store.update(job['id'], 'rolling_back', reason + ' Restoring the saved preset.')
    try:
        runtime.stop()
        if digest(job['base']) != job['base_sha'] or digest(job['candidate']) != job['candidate_sha']:
            raise ControlError('Saved transaction checksum mismatch; refusing to write a recovery file')
        current = digest(read_preset(store.path))
        if current not in (job['base_sha'], job['candidate_sha']):
            raise ControlError('External file edit detected; shelf left stopped and no file overwritten')
        if current != job['base_sha']:
            atomic_write(store.path, job['base'], job['candidate_sha'])
        runtime.resources(startup=True)
        runtime.start()
        runtime.wait_config(job['base'], job['model'])
        runtime.restore_watchdog(before)
        store.update(job['id'], 'rolled_back', reason + ' Saved file and router preset restored; no rollback inference was run.')
    except Exception as exc:
        try:
            runtime.restore_watchdog(before)
        except Exception:
            pass
        store.update(job['id'], 'recovery_required', reason + f' Automatic recovery incomplete: {exc}. Saved original remains in the job and snapshots directory.')


def execute(store, ident, runtime=None, recover=False, retry=False):
    with exclusive(store.state):
        job = store.get(ident)
        if job['status'] not in ACTIVE and not (retry and job['status'] == 'recovery_required'):
            return
        if store.per_model:
            store.update(ident, 'failed' if job['status'] == 'queued' else 'recovery_required',
                         'Legacy INI transaction blocked: the shelf now uses per-model TOML. No files or services were touched; inspect saved history before manual recovery.')
            return
        runtime = runtime or Runtime()
        if recover or retry:
            restore(store, job, runtime, 'Apply worker was interrupted.')
            return
        if job['status'] != 'queued':
            raise ControlError('Only a queued job may start')
        try:
            store.update(ident, 'preflight', 'Checking file revision, quiet shelf and reviewed runtime.')
            validate_job(store, job)
            ensure_target(store.path)
            if digest(read_preset(store.path)) != job['base_sha']:
                raise ControlError('Draft is stale; file changed before apply')
            before = runtime.inspect()
            runtime.wait_config(job['base'], job['model'])
            before = runtime.inspect()
            # Durable intent precedes every service side effect. ExecStopPost can
            # restore even if SIGKILL arrives between stop/write/start operations.
            snapshot(store, job)
            store.update(ident, 'stopping', 'Pausing watchdog and stopping shelf; KV caches will be lost.', runtime_before=before)
            runtime.pause_watchdog()
            runtime.stop()
            runtime.resources(startup=True)
            store.update(ident, 'writing', 'Installing the reviewed preset atomically.')
            atomic_write(store.path, job['candidate'], job['base_sha'])
            store.update(ident, 'starting', 'Starting shelf with the candidate preset.')
            runtime.start()
            store.update(ident, 'verifying', 'Checking effective settings and a bounded inference request.')
            evidence = runtime.verify(job['candidate'], job['model']) | {
                'build': before['build'], 'config_sha': job['candidate_sha'], 'model': job['model']}
            if digest(read_preset(store.path)) != job['candidate_sha']:
                raise ControlError('File changed while verifying')
            runtime.restore_watchdog(before)
            store.update(ident, 'succeeded', 'Applied and short-smoke verified. Long-context retrieval and quality are not validated.', evidence=evidence)
        except Exception as exc:
            restore(store, store.get(ident), runtime, str(exc))


def launch(ident):
    import menagerie
    menagerie.command(['systemctl', '--user', 'start', '--no-block', f'menagerie-apply@{job_id(ident)}.service'])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['apply', 'recover', 'retry'])
    p.add_argument('id')
    args = p.parse_args()
    os.umask(0o077)
    store = Store()
    ident = job_id(args.id)
    execute(store, ident, recover=args.action == 'recover', retry=args.action == 'retry')
    status = store.get(ident)['status']
    if status == 'recovery_required' or (args.action == 'apply' and status != 'succeeded'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
