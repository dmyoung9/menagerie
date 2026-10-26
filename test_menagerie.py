import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

import menagerie as m


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state'
        self.trials = Path(self.tmp.name) / 'trials'
        self.trials.mkdir()
        m.init_db(self.state)

    def test_config_inheritance_and_aliases(self):
        (self.trials / 'shelf.ini').write_text('version = 1\n[*]\nparallel=1\ntemp=1.0\nctx-checkpoints=32\ngpu-layers=all\n[a]\nparallel=2\nctx-size=65536\n')
        disk = m.config_inventory(self.trials)
        effective = {'parallel':'2', 'temperature':'1.0', 'swa-checkpoints':'32', 'n-gpu-layers':'all','ctx-size':'65536'}
        self.assertEqual(m.config_drift(disk['a'], effective), [])
        effective['ctx-size'] = '32768'
        self.assertEqual(m.config_drift(disk['a'], effective)[0]['key'], 'ctx-size')
        self.assertEqual(m.config_drift({'temp':'1 # vendor','top-p':'1','ctx-size':'65536'},
                                      {'temperature':'1.0','top-p':'1.000000','ctx-size':'65536'}), [])
        self.assertEqual(len(m.config_drift({'temp':'1'},{'temperature':'1.01'})),1)

    def test_metrics_reject_nonfinite_and_sum_labels(self):
        d = m.parse_metrics('# comment\nllamacpp:tokens_predicted_total 100\nllamacpp:tokens_predicted_seconds_total 2\nx{position="1"} 3\nx{position="2"} 4\nbad NaN\n')
        self.assertEqual(d['x'], 7)
        self.assertNotIn('bad', d)
        self.assertEqual(m.metric_derived(d)['decode_tok_s'], 50)
        self.assertIsNone(m.metric_derived({})['decode_tok_s'])

    def test_fit_units_and_extrapolation(self):
        fit = {'fixed_mib':7182,'mib_per_1k':38.5,'points':[[32768,8414],[65536,9646]]}
        self.assertEqual(m.estimate(fit, 65536, 1500, 16311)['model_mib'], 9646)
        self.assertEqual(m.estimate(fit, 32768, 1500, 16311)['model_mib'], 8414)
        self.assertFalse(m.estimate(fit, 65536, 1500, 16311)['extrapolated'])
        self.assertTrue(m.estimate(fit, 131072, 1500, 16311)['extrapolated'])

    def test_router_paths_never_allow_mutations(self):
        for path in ['/slots?model=a', '/metrics?model=a', '/models?reload=1', '/completion', '/models/load']:
            with self.assertRaises(ValueError):
                m.fetch(path)

    def collect(self, build, state):
        calls = []
        def fetch(path):
            calls.append(path)
            if path == '/props':
                return json.dumps({'build_info': build}), {}
            if path == '/models':
                return json.dumps({'data':[{'id':'a','status':{'value':state,'preset':'[a]\nparallel=1'}}]}), {}
            return 'llamacpp:tokens_predicted_total 12', {}
        collector = m.Collector(self.state, self.trials)
        with patch.object(m, 'fetch', side_effect=fetch), patch.object(m, 'gpu_sample', return_value=None), \
             patch.object(m, 'memory_sample', return_value=None), patch.object(collector, 'journal'), \
             patch.object(collector, 'import_gpu'):
            result = collector.once()
        return calls, result

    def test_safe_build_sleep_metrics_explicit_no_autoload(self):
        calls, result = self.collect(m.SAFE_METRICS_BUILD, 'sleeping')
        self.assertEqual(calls, ['/props','/models','/metrics?model=a&autoload=false'])
        self.assertFalse(result['errors'])

    def test_unknown_build_or_unloaded_never_polls_metrics(self):
        for build, state in [('new-build','loaded'),(m.SAFE_METRICS_BUILD,'unloaded'),(m.SAFE_METRICS_BUILD,'loading')]:
            calls, _ = self.collect(build, state)
            self.assertEqual(calls, ['/props','/models'])

    def test_import_dedup_and_known_invalid(self):
        p = self.trials / 'quality-test.artifact-no-instruction.json'
        p.write_text(json.dumps({'summary':{'probe':{'passed':0,'of':1}},'results':[]}))
        collector = m.Collector(self.state,self.trials)
        with sqlite3.connect(self.state/'history.sqlite3') as c:
            collector.import_results(c);collector.import_results(c)
            self.assertEqual(c.execute('SELECT count(*) FROM artifacts').fetchone()[0],1)
        with m.read_db(self.state) as c:
            artifact = m.artifact_rows(c)[0]
            self.assertTrue(artifact['warning'])
            self.assertIn('Incomplete',artifact['provenance'])

    def test_database_read_only(self):
        with m.read_db(self.state) as c:
            with self.assertRaises(sqlite3.OperationalError):
                c.execute("INSERT INTO meta VALUES('oops','oops')")

    def test_http_readonly_security_and_estimator_validation(self):
        with sqlite3.connect(self.state/'history.sqlite3') as c:
            c.execute("INSERT INTO events VALUES('a',1,'guard','SAFETY STOP')")
            c.execute("INSERT INTO events VALUES('b',2,'sleep','sleeping')")
        server = ThreadingHTTPServer(('127.0.0.1',0),m.make_handler(self.state))
        worker = threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        with urlopen(base+'/api/status') as r:
            self.assertIn('models', json.load(r))
            self.assertIn("default-src 'self'",r.headers['Content-Security-Policy'])
        with urlopen(base+'/api/events?kind=guard') as r:
            self.assertEqual([e['kind'] for e in json.load(r)], ['guard'])
        for method in ['POST','PUT','DELETE','PATCH']:
            with self.assertRaises(HTTPError) as cm:
                urlopen(Request(base+'/api/status',method=method))
            self.assertEqual(cm.exception.code,405)
        for route in ['/../menagerie.py','/api/estimate?other=NaN','/api/history?hours=oops']:
            with self.assertRaises(HTTPError) as cm:
                urlopen(base+route)
            self.assertIn(cm.exception.code,[400,404])
        with self.assertRaises(HTTPError) as cm:
            urlopen(Request(base+'/api/status',headers={'Host':'evil.example'}))
        self.assertEqual(cm.exception.code,403)

    def test_journal_incremental_reads_oldest_first(self):
        collector = m.Collector(self.state,self.trials)
        with sqlite3.connect(self.state/'history.sqlite3') as c:
            c.execute("INSERT INTO meta VALUES('journal_cursor','cursor')")
            c.execute("INSERT INTO meta VALUES('event_classifier','3')")
            with patch.object(m,'command',return_value='') as cmd:
                collector.journal(c)
            self.assertIn('+1500',cmd.call_args.args[0])

    def test_guard_and_watchdog_messages(self):
        self.assertEqual(m.classify_event('SAFETY STOP: GPU free below 2048 MiB'), 'guard')
        self.assertEqual(m.classify_event('Unsafe shelf startup: free VRAM=1000 MiB'), 'guard')
        self.assertEqual(m.classify_event('{"restarted":"llama-shelf.service","result":0}'), 'recovery')
        self.assertEqual(m.classify_event("Memory guard phase: ('idle', ())"), 'residency')
        self.assertIsNone(m.classify_event('Finished llama-shelf-watchdog.service - Resurrect the local model shelf after a guard trip.'))

    def test_model_history_versions_are_observed_not_inferred(self):
        now = 200000
        with sqlite3.connect(self.state/'history.sqlite3') as c:
            for ts, state, ctx in [(now-120,'loaded','32768'),(now-60,'sleeping','32768'),(now,'unloaded','65536')]:
                c.execute('INSERT INTO samples VALUES(?,?)',(ts,json.dumps({'router':{'build_info':'test'},'models':[
                    {'id':'a','state':state,'options':{'ctx-size':ctx},'derived':{'decode_tok_s':50}}]})))
        with m.read_db(self.state) as c:
            h=m.model_history(c,'a',now)
        self.assertEqual(len(h['transitions']),3)
        self.assertEqual(h['transitions'][0]['config'],h['transitions'][1]['config'])
        self.assertNotEqual(h['transitions'][1]['config'],h['transitions'][2]['config'])


if __name__ == '__main__':
    unittest.main()
