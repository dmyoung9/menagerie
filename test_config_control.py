import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import config_control as cc
import menagerie as m

BASE = '''version = 1
# Keep my comments and unknown options.
[*]
parallel = 1
gpu-layers = all
threads = 6
[a]
model = /private/models/a.gguf
ctx-size = 65536
temp = 1 # vendor default
cache-type-k = q8_0
batch-size = 512
ubatch-size = 256
unknown-option = preserve-me

[b]
model = /private/models/b.gguf
ctx-size = 32768
'''


class FakeRuntime:
    def __init__(self):
        self.calls = []
        self.verify_error = None
        self.inspect_error = None
        self.on_verify = None
        self.watchdog = True
        self.fail_resources_once = False

    def inspect(self):
        self.calls.append('inspect')
        if self.inspect_error:
            raise cc.ControlError(self.inspect_error)
        return {'build': m.SAFE_METRICS_BUILD, 'watchdog_active': self.watchdog}

    def pause_watchdog(self): self.calls.append('pause_watchdog')
    def restore_watchdog(self, before): self.calls.append(('restore_watchdog', before['watchdog_active']))
    def stop(self): self.calls.append('stop')
    def start(self): self.calls.append('start')
    def resources(self, startup=False):
        self.calls.append(('resources', startup))
        if self.fail_resources_once:
            self.fail_resources_once = False
            raise cc.ControlError('low headroom')
        return {'free_mib':15000, 'temperature_c':40, 'ram_available_mib':20000}
    def wait_config(self, text, model): self.calls.append(('wait_config', cc.digest(text), model))
    def verify(self, text, model):
        self.calls.append('verify')
        if self.on_verify:
            self.on_verify()
        if self.verify_error:
            raise cc.ControlError(self.verify_error)
        return {'scope':'fake test only', 'minimum_free_mib':4000, 'answer':'READY'}


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)/'state'; self.trials = Path(self.tmp.name)/'trials'
        self.trials.mkdir(); self.path = self.trials/'shelf.ini'; self.path.write_text(BASE)
        self.store = cc.Store(self.state, self.trials); self.runtime = FakeRuntime()

    def draft(self, changes=None):
        return self.store.draft('a', changes or {'ctx-size':'32768'}, cc.digest(BASE))

    def queue(self, draft):
        return self.store.queue(draft['id'], 'RESTART SHELF', True, lambda ident: None)

    def apply(self, changes=None):
        draft = self.draft(changes); self.queue(draft)
        cc.execute(self.store, draft['id'], self.runtime)
        return self.store.get(draft['id'])

    def test_comment_unknown_and_other_section_preservation(self):
        changed, _ = cc.patch_preset(BASE, 'a', {'temp':1.1, 'parallel':2})
        self.assertIn('temp = 1.1 # vendor default', changed)
        self.assertEqual(cc.parse(changed)['a']['temp'],'1.1')
        self.assertIn('# Keep my comments and unknown options.', changed)
        self.assertIn('unknown-option = preserve-me', changed)
        self.assertEqual(changed.split('[b]')[1], BASE.split('[b]')[1])
        self.assertEqual(cc.parse(changed)['b']['parallel'], '1')
        self.assertEqual(cc.parse(changed)['a']['parallel'], '2')

    def test_crlf_preserved(self):
        crlf = BASE.replace('\n','\r\n')
        changed, _ = cc.patch_preset(crlf,'a',{'parallel':2})
        self.assertNotIn('\n',changed.replace('\r\n',''))

    def test_invalid_values_and_privileged_options(self):
        for changes in [{'model':'/other'}, {'temp':'NaN'}, {'temp':'Infinity'}, {'parallel':1.5},
                        {'parallel':0}, {'cache-type-k':'q4_0\nmodel=/other'}, {'reasoning-budget':True},
                        {'ctx-size':512}, {'ubatch-size':1024}, {'n-cpu-moe':26}, {}]:
            with self.subTest(changes=changes), self.assertRaises(cc.ControlError):
                cc.patch_preset(BASE,'a',changes)
        with self.assertRaises(cc.ControlError): cc.patch_preset(BASE,'*',{'parallel':2})
        with self.assertRaises(cc.ControlError): cc.patch_preset(BASE,'a',{'ctx-size':65536})
        with self.assertRaises(cc.ControlError): cc.parse(BASE+'\n[a]\ntemp=0.5\n')

    def test_drafting_has_no_runtime_side_effect_and_discards(self):
        d = self.draft()
        self.assertEqual(self.path.read_text(),BASE)
        self.assertEqual(self.runtime.calls,[])
        self.assertEqual(d['status'],'draft')
        self.assertIn('-ctx-size = 65536',d['diff'])
        self.assertEqual(self.store.discard(d['id'])['status'],'discarded')
        with self.assertRaises(cc.ControlError): self.queue(d)

    def test_stale_form_or_apply_refused(self):
        d=self.draft();self.path.write_text(BASE+'# outside edit\n')
        with self.assertRaises(cc.ControlError): self.draft()
        with self.assertRaises(cc.ControlError): self.queue(d)
        self.assertEqual(self.runtime.calls,[])

    def test_explicit_confirmation_single_active_and_no_replay(self):
        first, second=self.draft(),self.draft({'ctx-size':98304})
        for phrase,quiet in [('yes',True),('RESTART SHELF',False)]:
            with self.assertRaises(cc.ControlError): self.store.queue(first['id'],phrase,quiet,lambda _:None)
        self.queue(first)
        with self.assertRaises(cc.ControlError): self.queue(second)
        with self.assertRaises(cc.ControlError): self.queue(first)

    def test_launch_failure_leaves_shelf_untouched(self):
        d=self.draft()
        with self.assertRaises(cc.ControlError):
            self.store.queue(d['id'],'RESTART SHELF',True,lambda _: (_ for _ in ()).throw(OSError('no unit')))
        self.assertEqual(self.store.get(d['id'])['status'],'failed')
        self.assertEqual(self.path.read_text(),BASE)

    def test_success_has_snapshot_evidence_and_prior_watchdog_state(self):
        self.runtime.watchdog=False
        job=self.apply()
        self.assertEqual(job['status'],'succeeded')
        self.assertEqual(self.path.read_text(),job['candidate'])
        self.assertEqual((self.state/'snapshots'/f'{job["id"]}.ini').read_text(),BASE)
        self.assertEqual(os.stat(self.state/'snapshots'/f'{job["id"]}.ini').st_mode & 0o777,0o600)
        self.assertIn(('restore_watchdog',False),self.runtime.calls)
        self.assertIn('evidence',self.store.public(job))

    def test_busy_or_unreviewed_runtime_refuses_before_stop(self):
        self.runtime.inspect_error='Shelf not quiet'
        job=self.apply()
        self.assertEqual(job['status'],'failed');self.assertEqual(self.path.read_text(),BASE)
        self.assertEqual(self.runtime.calls,['inspect'])

    def test_low_headroom_before_write_restores_original(self):
        self.runtime.fail_resources_once=True
        job=self.apply()
        self.assertEqual(job['status'],'rolled_back');self.assertEqual(self.path.read_text(),BASE)

    def test_verification_failure_restores_file_and_preset_without_smoke(self):
        self.runtime.verify_error='guard tripped'
        job=self.apply()
        self.assertEqual(job['status'],'rolled_back');self.assertEqual(self.path.read_text(),BASE)
        self.assertEqual(self.runtime.calls.count('verify'),1)
        self.assertIn(('wait_config',cc.digest(BASE),'a'),self.runtime.calls)

    def test_external_edit_during_apply_never_overwritten(self):
        foreign=BASE+'# manual edit during maintenance\n'
        self.runtime.on_verify=lambda:self.path.write_text(foreign)
        job=self.apply()
        self.assertEqual(job['status'],'recovery_required');self.assertEqual(self.path.read_text(),foreign)
        self.assertEqual(self.runtime.calls.count('start'),1)

    def test_crash_recovery_restores_after_unhandled_exit(self):
        class Crash(BaseException): pass
        self.runtime.on_verify=lambda:(_ for _ in ()).throw(Crash())
        d=self.draft();self.queue(d)
        with self.assertRaises(Crash): cc.execute(self.store,d['id'],self.runtime)
        self.assertEqual(self.store.get(d['id'])['status'],'verifying')
        cc.execute(self.store,d['id'],FakeRuntime(),recover=True)
        self.assertEqual(self.store.get(d['id'])['status'],'rolled_back');self.assertEqual(self.path.read_text(),BASE)

    def test_preflight_crash_has_no_service_recovery_side_effect(self):
        d=self.draft();self.queue(d)
        self.store.update(d['id'],'preflight','Checking')
        cc.execute(self.store,d['id'],self.runtime,recover=True)
        self.assertEqual(self.runtime.calls,[])
        self.assertEqual(self.store.get(d['id'])['status'],'failed')

    def test_worker_serialization(self):
        d=self.draft();self.queue(d)
        with cc.exclusive(self.state), self.assertRaises(cc.ControlError):
            cc.execute(self.store,d['id'],self.runtime)

    def test_manual_revert_is_reviewed_and_conflict_checked(self):
        job=self.apply();revert=self.store.rollback_draft(job['id'])
        self.assertEqual(revert['status'],'draft');self.assertEqual(self.path.read_text(),job['candidate'])
        self.assertEqual(self.store.get(revert['id'])['candidate'],BASE)
        self.queue(revert);cc.execute(self.store,revert['id'],FakeRuntime())
        self.assertEqual(self.path.read_text(),BASE)
        self.assertEqual(self.store.get(revert['id'])['status'],'succeeded')
        with self.assertRaises(cc.ControlError):self.store.rollback_draft(job['id'])

    def test_symlink_rejected_before_service_side_effect(self):
        actual=self.trials/'real.ini';self.path.rename(actual);self.path.symlink_to(actual)
        job=self.apply()
        self.assertEqual(job['status'],'failed');self.assertEqual(self.runtime.calls,[])

    def test_atomic_write_mode_and_conflict(self):
        os.chmod(self.path,0o640)
        cc.atomic_write(self.path,BASE+'# new\n',cc.digest(BASE))
        self.assertEqual(self.path.stat().st_mode & 0o777,0o640)
        with self.assertRaises(cc.ControlError):cc.atomic_write(self.path,'bad',cc.digest(BASE))
        self.assertFalse(list(self.trials.glob('.menagerie-*')))

    def test_fixed_service_id(self):
        for value in ['../shelf','foo;systemctl stop anything',None,'a'*33]:
            with self.assertRaises(cc.ControlError):cc.job_id(value)

    def test_tampered_draft_rejected_before_service_side_effect(self):
        d=self.draft();self.queue(d)
        with cc.db(self.state) as c:
            c.execute('UPDATE jobs SET candidate=? WHERE id=?',('version=1\n[evil]\nmodel=elsewhere\n',d['id']))
        cc.execute(self.store,d['id'],self.runtime)
        self.assertEqual(self.store.get(d['id'])['status'],'failed')
        self.assertEqual(self.runtime.calls,[])

    def test_recovery_retry_remains_conflict_checked(self):
        self.runtime.on_verify=lambda:self.path.write_text(BASE+'# owner edit\n')
        job=self.apply()
        self.assertEqual(job['status'],'recovery_required')
        next_draft=self.store.draft('a',{'parallel':2},cc.digest(self.path.read_text()))
        with self.assertRaises(cc.ControlError):self.queue(next_draft)
        self.path.write_text(job['candidate'])
        cc.execute(self.store,job['id'],FakeRuntime(),retry=True)
        self.assertEqual(self.store.get(job['id'])['status'],'rolled_back')
        self.assertEqual(self.path.read_text(),BASE)

    def test_runtime_preflight_never_wakes_model(self):
        runtime=cc.Runtime()
        def fetch(path):
            if path=='/props':return json.dumps({'build_info':m.SAFE_METRICS_BUILD}),{}
            return json.dumps({'data':[{'status':{'value':'loaded'}}]}),{}
        with patch.object(m,'fetch',side_effect=fetch) as f, self.assertRaises(cc.ControlError): runtime.inspect()
        self.assertEqual([call.args[0] for call in f.call_args_list],['/props','/models'])

    def test_runtime_smoke_is_bounded_and_records_provenance(self):
        runtime=cc.Runtime();opener=MagicMock()
        response=opener.open.return_value.__enter__.return_value
        response.read.return_value=json.dumps({'choices':[{'message':{'content':'READY'}}],'usage':{'completion_tokens':1}}).encode()
        with patch('urllib.request.build_opener',return_value=opener), \
             patch.object(runtime,'wait_config',return_value={'options':{'parallel':'1'}}), \
             patch.object(runtime,'resources',return_value={'free_mib':5000,'temperature_c':45}):
            evidence=runtime.verify(BASE,'a')
        request=opener.open.call_args.args[0]
        payload=json.loads(request.data)
        self.assertEqual(request.full_url,'http://127.0.0.1:8001/v1/chat/completions')
        self.assertEqual(payload['max_tokens'],512)
        self.assertEqual(evidence['request'],payload)
        self.assertEqual(evidence['answer'],'READY')
        self.assertEqual(evidence['minimum_free_mib'],5000)
        self.assertTrue(evidence['prompt_sha'])

    def test_runtime_smoke_rejects_reasoning_only_response(self):
        runtime=cc.Runtime();opener=MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value=json.dumps({'choices':[{'message':{'content':'','reasoning_content':'loop'}}]}).encode()
        with patch('urllib.request.build_opener',return_value=opener), \
             patch.object(runtime,'wait_config'), \
             patch.object(runtime,'resources',return_value={'free_mib':5000,'temperature_c':45}), \
             self.assertRaises(cc.ControlError):
            runtime.verify(BASE,'a')

    def test_real_watchdog_adapter_preserves_inactive_state(self):
        runtime=cc.Runtime()
        with patch.object(runtime,'systemctl') as call:
            runtime.restore_watchdog({'watchdog_active':False});call.assert_not_called()
            runtime.restore_watchdog({'watchdog_active':True});call.assert_called_once_with('start','llama-shelf-watchdog.timer')

    def test_http_csrf_draft_and_apply_confirmation(self):
        m.init_db(self.state)
        server=ThreadingHTTPServer(('127.0.0.1',0),m.make_handler(self.state,self.store))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        base=f'http://127.0.0.1:{server.server_port}'
        with urlopen(base+'/api/config') as r:data=json.load(r)
        def post(action,body,token=data['csrf_token'],origin=base,ctype='application/json'):
            return urlopen(Request(base+'/api/config/'+action,data=json.dumps(body).encode(),headers={
                'Origin':origin,'X-Menagerie-Token':token,'Content-Type':ctype},method='POST'))
        body={'model':'a','base_sha':data['base_sha'],'changes':{'ctx-size':32768}}
        for token,origin in [('',base),('é'*32,base),(data['csrf_token'],'https://evil.example'),(data['csrf_token'],'')]:
            with self.assertRaises(HTTPError) as error:post('draft',body,token,origin)
            self.assertEqual(error.exception.code,403)
        with self.assertRaises(HTTPError) as error:post('draft',body,ctype='text/plain')
        self.assertEqual(error.exception.code,415)
        with post('draft',body) as response:d=json.load(response)
        self.assertEqual(self.path.read_text(),BASE)
        with patch.object(m,'control_available',return_value=True),patch.object(cc,'launch') as launch:
            with self.assertRaises(HTTPError) as error:post('apply',{'id':d['id'],'confirmation':'yes','quiescent':True})
            self.assertEqual(error.exception.code,400);launch.assert_not_called()
            with post('apply',{'id':d['id'],'confirmation':'RESTART SHELF','quiescent':True}) as r:self.assertEqual(r.status,202)
            launch.assert_called_once_with(d['id'])
        self.assertEqual(self.path.read_text(),BASE)


if __name__=='__main__':
    unittest.main()
