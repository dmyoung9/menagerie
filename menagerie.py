#!/usr/bin/env python3
"""Menagerie: loopback model observation and explicitly reviewed preset control."""
import argparse
import configparser
from contextlib import closing, contextmanager
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import sqlite3
import subprocess
import threading
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, urlencode
from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler, Request

ROOT = Path(__file__).resolve().parent
HOME = Path.home()
DEFAULT_STATE = Path(os.environ.get('XDG_STATE_HOME', HOME / '.local/state')) / 'menagerie'
DEFAULT_TRIALS = HOME / 'ai/qwen38-trials'
# Reviewed at Prism e3de71522: proxy_get honors autoload=false; metrics returns
# sleeping cached data and does not reset idle timers. SLOT_GET is NOT safe.
SAFE_METRICS_BUILD = 'b10777-e3de71522'
FLOOR_MIB = 2048


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Router redirects are not allowed')


def command(args, timeout=5):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError((p.stderr.strip() or p.stdout.strip() or f'exit {p.returncode}')[:400])
    return p.stdout


def fetch(path):
    """Fixed upstream, GET only, no proxies, redirects, inference, or reloads."""
    if path not in ('/models', '/props') and not (path.startswith('/metrics?model=') and path.endswith('&autoload=false')):
        raise ValueError('Non-observational router path')
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(Request('http://127.0.0.1:8001' + path, method='GET'), timeout=3) as r:
        return r.read(4 * 1024 * 1024).decode(), dict(r.headers)


def init_db(state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with closing(sqlite3.connect(state / 'history.sqlite3')) as c, c:
        c.execute('PRAGMA journal_mode=WAL')
        c.executescript('''
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS gpu_history (
          ts INTEGER PRIMARY KEY, used REAL, total REAL, temperature REAL,
          power REAL, utilization REAL, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, ts REAL NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_time ON events(ts);
        CREATE TABLE IF NOT EXISTS artifacts (
          sha TEXT PRIMARY KEY, name TEXT NOT NULL, modified REAL NOT NULL,
          kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, signature TEXT NOT NULL);
        ''')
    os.chmod(state / 'history.sqlite3', 0o600)


@contextmanager
def read_db(state):
    c = sqlite3.connect((state / 'history.sqlite3').as_uri() + '?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    # Large GROUP BY queries must not spill SQLite temp files outside the
    # service's single writable state directory (ProtectSystem=strict).
    c.execute('PRAGMA temp_store=MEMORY')
    try:
        yield c
    finally:
        c.close()


def parse_metrics(raw):
    values = {}
    for line in raw.splitlines():
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([\w:]+)(?:\{[^}]*\})?\s+([-+.\deE]+)(?:\s+\d+)?', line)
        if match:
            value = float(match[2])
            if math.isfinite(value):
                name = match[1].removeprefix('llamacpp:')
                values[name] = values.get(name, 0) + value
    return values


def metric_derived(values):
    def ratio(a, b):
        return values[a] / values[b] if values.get(b, 0) > 0 and a in values else None
    return {'decode_tok_s': ratio('tokens_predicted_total', 'tokens_predicted_seconds_total'),
            'prefill_tok_s': ratio('prompt_tokens_total', 'prompt_seconds_total'),
            'cache_ratio': ratio('prompt_tokens_cached_total', 'prompt_tokens_total'),
            'mtp_acceptance': ratio('spec_decode_num_accepted_tokens_total', 'spec_decode_num_draft_tokens_total')}


def preset_options(text):
    p = configparser.ConfigParser(interpolation=None, strict=False)
    p.read_string(text or '[empty]\n')
    return dict(p[p.sections()[0]]) if p.sections() else {}


def config_inventory(trials):
    from config_control import primitive_value
    import shelf_bridge
    if shelf_bridge.enabled(trials):
        return shelf_bridge.inventory(trials)
    p = configparser.ConfigParser(interpolation=None, strict=False)
    path = trials / 'shelf.ini'
    if not path.exists():
        return {}
    # llama.cpp's INI includes an unsectioned version field.
    p.read_string('[__global__]\n' + path.read_text())
    defaults = dict(p['*']) if p.has_section('*') else {}
    return {name: {k: primitive_value(k, v) for k, v in (defaults | dict(p[name])).items()}
            for name in p.sections() if name not in ('*', '__global__')}


def config_drift(disk, effective):
    from config_control import FIELDS, primitive_value
    aliases = {'temp': 'temperature', 'ctx-checkpoints': 'swa-checkpoints',
               'gpu-layers': 'n-gpu-layers', 'spec-draft-model': 'model-draft'}
    skip = {'load-on-startup', 'stop-timeout'}
    changes = []
    for key, expected in disk.items():
        actual = effective.get(aliases.get(key, key))
        if FIELDS.get(key, {}).get('type') in ('int', 'float'):
            try:
                a, b = Decimal(str(primitive_value(key, expected))), Decimal(str(actual))
                if a.is_finite() and b.is_finite() and a == b:
                    continue
            except InvalidOperation:
                pass
        if key not in skip and str(actual).lower() != str(expected).lower():
            changes.append({'key': key, 'disk': expected, 'effective': actual})
    return changes


def gpu_sample():
    row = next(csv.reader(io.StringIO(command([
        'nvidia-smi', '--query-gpu=memory.used,memory.total,temperature.gpu,power.draw,utilization.gpu',
        '--format=csv,noheader,nounits']))))
    def number(v):
        try:
            return float(v.strip())
        except ValueError:
            return None
    d = dict(zip(('used', 'total', 'temperature', 'power', 'utilization'), map(number, row)))
    d['free'] = d['total'] - d['used'] if d['total'] is not None and d['used'] is not None else None
    processes = []
    try:
        text = command(['nvidia-smi', '--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'])
        for r in csv.reader(io.StringIO(text)):
            if len(r) != 3 or not r[0].strip().isdigit():
                continue
            pid = int(r[0]); cgroup = ''
            try:
                cgroup = Path(f'/proc/{pid}/cgroup').read_text()
            except OSError:
                pass
            processes.append({'pid': pid, 'name': Path(r[1].strip()).name,
                              'used_mib': number(r[2]), 'shelf': 'llama-shelf.service' in cgroup})
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        d['process_error'] = str(exc)
    d['processes'] = processes
    d['process_note'] = 'Compute-process list only; graphics allocations may be absent.'
    return d


def memory_sample():
    fields = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        name, value = line.split(':', 1)
        fields[name] = int(value.split()[0]) / 1024
    return {'available_mib': fields['MemAvailable'], 'total_mib': fields['MemTotal'],
            'swap_used_mib': fields['SwapTotal'] - fields['SwapFree']}


def classify_event(message):
    # The timer's routine unit description contains "after a guard trip" even
    # when it did nothing. It is not evidence that a guard actually tripped.
    if re.match(r'(Starting|Started|Finished) llama-shelf-watchdog\.service', message):
        return None
    if re.search(r'SAFETY STOP|Unsafe shelf startup|guard.*(trip|stopp|violat|fail)|floor|exit.*78', message, re.I):
        return 'guard'
    if '"restarted"' in message and 'llama-shelf.service' in message:
        return 'recovery'
    if re.search(r'sleep|unload', message, re.I):
        return 'sleep'
    if re.search(r'model loaded|load_model: loading|phase:', message, re.I):
        return 'residency'
    if re.search(r'tokens per second|eval time', message, re.I):
        return 'timing'
    if re.search(r'error|failed|exception', message, re.I):
        return 'error'
    return None


class Collector:
    def __init__(self, state, trials):
        self.state, self.trials = state, trials
        self.stop = threading.Event()
        self.last_import = 0

    def import_results(self, c):
        for path in sorted(self.trials.glob('*.json')):
            if path.stat().st_size > 8 * 1024 * 1024:
                continue
            signature = f'{path.stat().st_mtime_ns}:{path.stat().st_size}'
            old = c.execute('SELECT signature FROM files WHERE path=?', (str(path),)).fetchone()
            if old and old[0] == signature:
                continue
            try:
                raw = path.read_bytes(); data = json.loads(raw)
                if not isinstance(data, dict):
                    continue
                if isinstance(data.get('summary'), dict) and isinstance(data.get('results'), list):
                    kind = 'evaluation'
                elif 'mib_per_1k' in data and 'fixed_mib' in data:
                    kind = 'kv-fit'
                elif isinstance(data.get('rows'), list) and path.name.startswith('shelf-'):
                    kind = 'smoke'
                else:
                    continue
                c.execute('INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?)',
                          (hashlib.sha256(raw).hexdigest(), path.name, path.stat().st_mtime, kind, json.dumps(data)))
                c.execute('INSERT OR REPLACE INTO files VALUES(?,?)', (str(path), signature))
            except (ValueError, OSError):
                continue

    def import_gpu(self, c):
        folder = HOME / '.local/state/gpu-health-watch'
        for path in (folder / 'events.log.1', folder / 'events.log'):
            if not path.exists():
                continue
            key = 'gpu-offset:' + str(path)
            stat = path.stat()
            old = c.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
            saved = json.loads(old[0]) if old else {}
            offset = saved.get('offset', 0) if saved.get('inode') == stat.st_ino else 0
            if offset > stat.st_size:
                offset = 0
            batch = []
            with path.open() as f:
                f.seek(offset)
                for _ in range(200000):
                    start = f.tell(); line = f.readline()
                    if not line:
                        break
                    if not line.endswith('\n'):
                        f.seek(start); break
                    try:
                        stamp = datetime.fromisoformat(line.split()[0]).timestamp()
                        temp, power, utilization, used, total = [float(x.strip()) for x in line.split('sample=', 1)[1].split(',')[:5]]
                        batch.append((int(stamp), used, total, temp, power, utilization, 'gpu-health-watch'))
                    except (ValueError, IndexError):
                        continue
                offset = f.tell()
            c.executemany('INSERT OR IGNORE INTO gpu_history VALUES(?,?,?,?,?,?,?)', batch)
            c.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', (key, json.dumps({'inode': stat.st_ino, 'offset': offset})))

    def journal(self, c):
        old = c.execute("SELECT value FROM meta WHERE key='journal_cursor'").fetchone()
        version = c.execute("SELECT value FROM meta WHERE key='event_classifier'").fetchone()
        if not version or version[0] != '3':
            for event_id, message in c.execute('SELECT id,message FROM events').fetchall():
                kind = classify_event(message)
                if kind:
                    c.execute('UPDATE events SET kind=? WHERE id=?', (kind, event_id))
                else:
                    c.execute('DELETE FROM events WHERE id=?', (event_id,))
            old = None
        args = ['journalctl', '--user', '-u', 'llama-shelf.service', '-u', 'llama-shelf-watchdog.service',
                '-o', 'json', '--no-pager', '--show-cursor']
        args += ['--after-cursor', old[0], '-n', '+1500'] if old else ['--since', '7 days ago', '-n', '4000']
        text = command(args, timeout=8)
        cursor = old[0] if old else None
        for line in text.splitlines():
            if not line.startswith('{'):
                continue
            row = json.loads(line); cursor = row.get('__CURSOR', cursor)
            msg = row.get('MESSAGE', '')
            if not isinstance(msg, str):
                continue
            kind = classify_event(msg)
            if kind:
                c.execute('INSERT OR IGNORE INTO events VALUES(?,?,?,?)',
                          (row['__CURSOR'], int(row['__REALTIME_TIMESTAMP']) / 1e6, kind, msg[:2000]))
        if cursor:
            c.execute("INSERT OR REPLACE INTO meta VALUES('journal_cursor',?)", (cursor,))
        c.execute("INSERT OR REPLACE INTO meta VALUES('event_classifier','3')")

    def once(self):
        now = int(time.time())
        snapshot = {'ts': now, 'errors': {}, 'models': [], 'gpu': None, 'memory': None,
                    'router': None, 'metrics_policy': 'Reviewed-build metrics only; never polls slots.'}
        for key, func in [('gpu', gpu_sample), ('memory', memory_sample)]:
            try:
                snapshot[key] = func()
            except Exception as exc:
                snapshot['errors'][key] = str(exc)[:400]
        try:
            snapshot['router'] = json.loads(fetch('/props')[0])
            disk = config_inventory(self.trials)
            models = json.loads(fetch('/models')[0])['data']
            for model in models:
                status = model.get('status', {})
                effective = preset_options(status.get('preset', ''))
                row = {'id': model['id'], 'state': status.get('value', 'unknown'),
                       'source': model.get('source', 'unknown'), 'options': effective,
                       'argv': status.get('args', []), 'disk': disk.get(model['id']),
                       'drift': config_drift(disk[model['id']], effective) if model['id'] in disk else [],
                       'metrics': None, 'derived': {}}
                if snapshot['router'].get('build_info') == SAFE_METRICS_BUILD and row['state'] in ('loaded', 'sleeping'):
                    try:
                        raw, headers = fetch('/metrics?' + urlencode({'model': model['id'], 'autoload': 'false'}))
                        row['metrics'] = parse_metrics(raw)
                        row['derived'] = metric_derived(row['metrics'])
                        row['metrics_start'] = headers.get('Process-Start-Time-Unix')
                        row['metrics_note'] = 'Cached during sleep; rates are since this model process started.'
                    except Exception as exc:
                        row['metrics_error'] = str(exc)[:300]
                snapshot['models'].append(row)
            snapshot['missing_presets'] = sorted(set(disk) - {m['id'] for m in models})
        except Exception as exc:
            snapshot['errors']['router'] = str(exc)[:400]
        with closing(sqlite3.connect(self.state / 'history.sqlite3', timeout=10)) as c, c:
            try:
                self.journal(c)
            except Exception as exc:
                snapshot['errors']['journal'] = str(exc)[:400]
            if now - self.last_import > 60:
                try:
                    self.import_results(c); self.import_gpu(c)
                    self.last_import = now
                except Exception as exc:
                    snapshot['errors']['import'] = str(exc)[:400]
            c.execute('INSERT OR REPLACE INTO samples VALUES(?,?)', (now, json.dumps(snapshot)))
            gpu = snapshot['gpu']
            if gpu:
                c.execute('INSERT OR REPLACE INTO gpu_history VALUES(?,?,?,?,?,?,?)',
                          (now, gpu['used'], gpu['total'], gpu['temperature'], gpu['power'], gpu['utilization'], 'menagerie'))
            c.execute('DELETE FROM samples WHERE ts < ?', (now - 7 * 86400,))
            c.execute('DELETE FROM gpu_history WHERE ts < ?', (now - 90 * 86400,))
            c.execute('DELETE FROM events WHERE ts < ?', (now - 90 * 86400,))
        return snapshot

    def run(self):
        while not self.stop.is_set():
            try:
                self.once()
            except Exception as exc:
                print(f'collector: {exc}', flush=True)
            self.stop.wait(10)


def artifact_rows(c):
    rows = []
    for row in c.execute('SELECT * FROM artifacts ORDER BY modified DESC'):
        data = json.loads(row['payload'])
        rows.append({'sha': row['sha'], 'name': row['name'], 'modified': row['modified'],
                     'kind': row['kind'], 'data': data,
                     'provenance': 'Recorded' if data.get('build_info') or data.get('build') else 'Incomplete: build/config/prompt hash not recorded',
                     'warning': 'Historical artifact — not a valid grade' if any(x in row['name'] for x in ('artifact-', 'pre-checker-fix')) else None})
    return rows


def estimate(fit, context, other_mib, total_mib):
    # mib_per_1k means per 1024 tokens, as calculated by kv_probe.py.
    points = fit.get('points', [])
    used = float(fit['fixed_mib']) + float(fit['mib_per_1k']) * context / 1024
    return {'model_mib': used, 'other_mib': other_mib, 'free_mib': total_mib - other_mib - used,
            'margin_mib': total_mib - other_mib - used - FLOOR_MIB,
            'extrapolated': not points or not min(p[0] for p in points) <= context <= max(p[0] for p in points),
            'warning': 'Empirical two-point fit; original parallel/offload/build provenance incomplete. No throughput prediction.'}


def model_history(c, model_id, now=None):
    now = now or int(time.time())
    rows, transitions = [], []
    last = None
    for sample in c.execute('SELECT ts,payload FROM samples WHERE ts>=? ORDER BY ts', (now-86400,)):
        data = json.loads(sample['payload'])
        model = next((r for r in data['models'] if r['id'] == model_id), None)
        if not model:
            continue
        config = hashlib.sha256(json.dumps(model['options'], sort_keys=True).encode()).hexdigest()[:12]
        build = (data.get('router') or {}).get('build_info')
        identity = (model['state'], config, build)
        if identity != last:
            transitions.append({'ts': sample['ts'], 'state': model['state'], 'config': config, 'build': build})
            last = identity
        point = {'ts': sample['ts'], 'decode': model.get('derived', {}).get('decode_tok_s')}
        if not rows or point['ts'] - rows[-1]['ts'] >= 60:
            rows.append(point)
    return {'rows': rows, 'transitions': transitions[-100:]}


def make_handler(state, control=None):
    csrf_token = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            if len(args) < 2 or str(args[1]) not in ('200', '304'):
                super().log_message(fmt, *args)

        def respond(self, data, status=200, mime='application/json; charset=utf-8'):
            raw = json.dumps(data, allow_nan=False).encode() if not isinstance(data, bytes) else data
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' http://localhost:* http://127.0.0.1:*")
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(raw)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            host = self.headers.get('Host', '').split(':')[0]
            if host not in ('127.0.0.1', 'localhost', 'openchamber-preview.localhost'):
                return self.respond({'error': 'Loopback Host required'}, 403)
            path = urlsplit(self.path).path
            params = parse_qs(urlsplit(self.path).query)
            try:
                if path == '/favicon.ico':
                    return self.respond(b'', status=204, mime='image/x-icon')
                if path == '/api/config' and control is not None:
                    return self.respond(control.current() | {'csrf_token': csrf_token,
                        'jobs': control.history(), 'attention': control.attention(), 'apply_available': control_available(control),
                        'warning': 'Apply restarts the entire shelf, drops KV caches, and loads the changed model for a 512-token smoke check. Pause every client first.'})
                if path == '/api/status':
                    with read_db(state) as c:
                        row = c.execute('SELECT payload FROM samples ORDER BY ts DESC LIMIT 1').fetchone()
                        data = json.loads(row[0]) if row else {'ts': None, 'errors': {'collector': 'Starting'}, 'models': []}
                        data['db_bytes'] = sum(p.stat().st_size for p in state.glob('history.sqlite3*'))
                        data['artifact_count'] = c.execute('SELECT count(*) FROM artifacts').fetchone()[0]
                        data['history_start'] = c.execute('SELECT min(ts) FROM gpu_history').fetchone()[0]
                    if control is not None:
                        data['configuration_job'] = control.attention()
                    return self.respond(data)
                if path == '/api/history':
                    hours = max(1, min(2160, int(params.get('hours', ['24'])[0])))
                    since = int(time.time()) - hours * 3600
                    bucket = max(10, hours * 3600 // 400)
                    with read_db(state) as c:
                        rows = [dict(r) for r in c.execute('''SELECT CAST(ts / ? AS INTEGER)*? AS ts,
                          avg(used) AS used, avg(total) AS total, max(temperature) AS temperature,
                          avg(power) AS power, avg(utilization) AS utilization, min(total-used) AS free_min
                          FROM gpu_history WHERE ts>=? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts''',
                          (bucket, bucket, since, bucket))]
                    return self.respond({'bucket_s': bucket, 'rows': rows})
                if path == '/api/events':
                    kind = params.get('kind', [''])[0]
                    if kind not in ('', 'guard', 'recovery', 'residency', 'sleep', 'timing', 'error'):
                        raise ValueError('Unknown event kind')
                    with read_db(state) as c:
                        rows = [dict(r) for r in c.execute("SELECT ts,kind,message FROM events WHERE (?='' OR kind=?) ORDER BY ts DESC LIMIT 250", (kind, kind))]
                    return self.respond(rows)
                if path == '/api/model-history':
                    with read_db(state) as c:
                        return self.respond(model_history(c, params.get('id', [''])[0]))
                if path == '/api/results':
                    with read_db(state) as c:
                        return self.respond(artifact_rows(c))
                if path == '/api/estimate':
                    sha = params.get('fit', [''])[0]
                    ctx = int(params.get('context', ['65536'])[0])
                    other = float(params.get('other', ['1500'])[0])
                    total = float(params.get('total', ['16311'])[0])
                    if not (1024 <= ctx <= 1048576 and 0 <= other <= 100000 and 1 <= total <= 100000):
                        raise ValueError('Estimate inputs outside supported range')
                    with read_db(state) as c:
                        fit = c.execute("SELECT payload FROM artifacts WHERE sha=? AND kind='kv-fit'", (sha,)).fetchone()
                    if not fit:
                        return self.respond({'error': 'Unknown fit'}, 404)
                    return self.respond(estimate(json.loads(fit[0]), ctx, other, total))
                static = {'/': ('index.html', 'text/html; charset=utf-8'),
                          '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                          '/config.js': ('config.js', 'text/javascript; charset=utf-8'),
                          '/style.css': ('style.css', 'text/css; charset=utf-8')}
                if path in static:
                    name, mime = static[path]
                    return self.respond((ROOT / 'web' / name).read_bytes(), mime=mime)
                self.respond({'error': 'Not found'}, 404)
            except (ValueError, KeyError) as exc:
                self.respond({'error': str(exc)}, 400)
            except (sqlite3.Error, OSError) as exc:
                self.respond({'error': str(exc)}, 503)
            except Exception as exc:
                from config_control import ControlError
                if isinstance(exc, ControlError):
                    self.respond({'error': str(exc)}, exc.code)
                else:
                    raise

        def do_POST(self):
            from config_control import ControlError
            path = urlsplit(self.path).path
            if control is None or path not in ('/api/config/draft', '/api/config/apply', '/api/config/revert', '/api/config/discard'):
                return self.reject()
            host = self.headers.get('Host', '')
            origin = urlsplit(self.headers.get('Origin', ''))
            if (host.split(':')[0] not in ('127.0.0.1', 'localhost', 'openchamber-preview.localhost')
                    or origin.scheme != 'http' or origin.netloc != host
                    or not secrets.compare_digest(self.headers.get('X-Menagerie-Token', '').encode(), csrf_token.encode())
                    or self.headers.get('Sec-Fetch-Site', 'same-origin') not in ('same-origin', 'none')):
                return self.respond({'error': 'Same-origin request and current dashboard token required'}, 403)
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or self.headers.get('Transfer-Encoding'):
                return self.respond({'error': 'application/json with Content-Length required'}, 415)
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 32768:
                    return self.respond({'error': 'Request size must be 1–32768 bytes'}, 413)
                self.connection.settimeout(10)
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError('JSON object required')
                if path == '/api/config/draft':
                    result = control.draft(body.get('model'), body.get('changes'), body.get('base_sha'))
                elif path == '/api/config/revert':
                    result = control.rollback_draft(body.get('id'))
                elif path == '/api/config/discard':
                    result = control.discard(body.get('id'))
                else:
                    if not control_available(control):
                        raise ControlError('Apply worker is not installed for these state/preset paths', 503)
                    import config_control
                    result = control.queue(body.get('id'), body.get('confirmation'), body.get('quiescent'), config_control.launch)
                self.respond(result, 202 if path == '/api/config/apply' else 200)
            except ControlError as exc:
                self.respond({'error': str(exc)}, exc.code)
            except (ValueError, TypeError) as exc:
                self.respond({'error': str(exc)}, 400)
            except (sqlite3.Error, OSError) as exc:
                self.respond({'error': str(exc)}, 503)

        def reject(self):
            self.respond({'error': 'Menagerie is read-only'}, 405)

        do_PUT = do_DELETE = do_PATCH = reject
    return Handler


def control_available(control):
    from config_control import STATE, TRIALS
    return (not control.per_model and control.state == STATE and control.trials == TRIALS
            and (HOME / '.config/systemd/user/menagerie-apply@.service').exists())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['serve', 'collect-once', 'import', 'status', 'doctor'], nargs='?', default='serve')
    parser.add_argument('--state', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--trials', type=Path, default=DEFAULT_TRIALS)
    parser.add_argument('--port', type=int, default=8017)
    args = parser.parse_args()
    args.state = args.state.expanduser().resolve()
    args.trials = args.trials.expanduser().resolve()
    if args.action in ('status', 'doctor'):
        try:
            with read_db(args.state) as c:
                row = c.execute('SELECT payload FROM samples ORDER BY ts DESC LIMIT 1').fetchone()
                result = json.loads(row[0]) if row else {'error': 'No samples'}
            if args.action == 'doctor':
                result = {'age_s': time.time() - result.get('ts', 0), 'errors': result.get('errors'),
                          'build': (result.get('router') or {}).get('build_info'),
                          'metrics_reviewed': (result.get('router') or {}).get('build_info') == SAFE_METRICS_BUILD,
                          'database': str(args.state / 'history.sqlite3')}
        except (sqlite3.Error, OSError) as exc:
            result = {'error': str(exc)}
        print(json.dumps(result, indent=2)); return
    os.umask(0o077)
    init_db(args.state)
    collector = Collector(args.state, args.trials)
    if args.action == 'collect-once':
        print(json.dumps(collector.once(), indent=2)); return
    if args.action == 'import':
        with closing(sqlite3.connect(args.state / 'history.sqlite3')) as c, c:
            collector.import_results(c); collector.import_gpu(c)
        return
    from config_control import Store
    control = Store(args.state, args.trials)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(args.state, control))
    server.daemon_threads = True
    worker = threading.Thread(target=collector.run, daemon=True)
    worker.start()
    def shutdown(*_):
        collector.stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f'Menagerie listening on http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    finally:
        collector.stop.set(); worker.join(timeout=30); server.server_close()


if __name__ == '__main__':
    main()
