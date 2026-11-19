import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
import os
import fcntl
import hashlib
import hmac
import struct
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_local_history', Path(__file__).with_name('prepare_local_history.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SourceStampTests(unittest.TestCase):
    def test_db_wal_change_and_unchanged(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);(root/'message').mkdir();path=root/'message/message_0.db';path.write_bytes(b'old')
            first=module.source_stamp(root,['message/message_0.db'])
            self.assertEqual(first,module.source_stamp(root,['message/message_0.db']))
            (root/'message/message_0.db-wal').write_bytes(b'new wal')
            self.assertNotEqual(first,module.source_stamp(root,['message/message_0.db']))

    def test_symlink_source_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);(root/'data').write_bytes(b'data');(root/'alias.db').symlink_to(root/'data')
            with self.assertRaises(OSError):module.source_stamp(root,['alias.db'])

    def test_unique_process_required(self):
        with patch.object(module.Path,'iterdir',return_value=[]):
            with self.assertRaisesRegex(ValueError,'LOCAL_HISTORY_CLIENT_REQUIRED'):module.current_process()

class ManagedHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.home=Path(self.temporary.name);self.home.chmod(0o700)
        self.source=self.home/'db_storage';self.source.mkdir()
        self.paths=['contact/contact.db','session/session.db','message/message_0.db']
        self.key=bytes(range(32));salt=bytes(range(16));prefix=salt+b'a'*(4096-16-64)
        mac_key=hashlib.pbkdf2_hmac('sha512',self.key,bytes(value^0x3a for value in salt),2,32)
        self.page=prefix+hmac.new(mac_key,prefix[16:]+struct.pack('<I',1),hashlib.sha512).digest()
        for name in self.paths:
            path=self.source/name;path.parent.mkdir(exist_ok=True);path.write_bytes(self.page)
        state=self.home/'.wechat-ro-history-fixture';state.mkdir(mode=0o700)
        self.keys={'_db_dir':str(self.source),**{name:{'enc_key':self.key.hex()} for name in self.paths}}
        module.wcdb_key_tool._write_private_json(str(state/'runtime-keys.json'),self.keys)
        self.calls=0;self.account='a'*12
        self.addCleanup(patch.stopall)
        patch.object(module.Path,'home',return_value=self.home).start()
        patch.object(module,'current_process',return_value=1).start()
        self.plan=patch.object(module,'preparation_plan',side_effect=lambda *a,**k:(self.source,self.paths,{'account_ref':self.account,'client_build_sha256':module.wcdb_runtime_keys.BUILD_SHA256,'client_build_identity':['synthetic',1]})).start()
        self.snapshot=patch.object(module.wcdb_live_snapshot,'snapshot_live',side_effect=self.capture).start()

    def capture(self,source,destination,keys,selected_paths):
        self.calls+=1;root=Path(destination)/'decrypted';root.mkdir(parents=True,mode=0o700);root.parent.chmod(0o700)
        snapshot_id=f'{self.calls:032x}'
        module.wcdb_key_tool._write_private_json(str(root/'.wechat-ro-manifest.json'),{'complete':True,'snapshot_id':snapshot_id})
        return {'snapshot_id':snapshot_id}

    def test_import_reuses_keys_then_unchanged_refresh_skips_copy_and_wal_change_rebuilds(self):
        first=module.managed_history('import',lambda *a,**k:None)
        second=module.managed_history('refresh',lambda *a,**k:None)
        self.assertEqual(self.calls,1);self.assertFalse(second['changed']);self.assertEqual(first['snapshot_directory'],second['snapshot_directory'])
        (self.source/'message/message_0.db-wal').write_bytes(b'synthetic committed change')
        third=module.managed_history('refresh',lambda *a,**k:None)
        self.assertEqual(self.calls,2);self.assertNotEqual(third['snapshot_directory'],first['snapshot_directory'])
        self.assertEqual(self.plan.call_args.kwargs['known_build'],['synthetic',1])

    def test_refresh_account_change_and_failed_copy_preserve_registry(self):
        module.managed_history('import',lambda *a,**k:None)
        record=self.home/'.wechat-ro-local-history/source.json';before=record.read_bytes()
        self.account='b'*12
        with self.assertRaises(ValueError):module.managed_history('refresh',lambda *a,**k:None)
        self.assertEqual(record.read_bytes(),before)
        self.account='a'*12;(self.source/'message/message_0.db').write_bytes(b'changed')
        self.snapshot.side_effect=RuntimeError('synthetic failure')
        with self.assertRaises(RuntimeError):module.managed_history('refresh',lambda *a,**k:None)
        self.assertEqual(record.read_bytes(),before)

    def test_record_cannot_redirect_snapshot_and_lock_serializes_processes(self):
        module.managed_history('import',lambda *a,**k:None)
        registry=self.home/'.wechat-ro-local-history';record=registry/'source.json'
        value=json.loads(record.read_text());value['snapshot_directory']=str(self.home/'arbitrary/decrypted')
        module.wcdb_key_tool._write_private_json(str(record),value)
        with self.assertRaises(ValueError):module.managed_history('refresh',lambda *a,**k:None)
        with (registry/'source.lock').open('r+') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):module.managed_history('refresh',lambda *a,**k:None)

    def test_retention_keeps_live_task_pins_and_removes_dead_owner_copies(self):
        consumer='11111111-1111-4111-8111-111111111111';other='22222222-2222-4222-8222-222222222222'
        with patch.object(module.os,'getppid',return_value=os.getpid()):
            first=module.managed_history('import',lambda *a,**k:None,consumer=consumer)
            module.managed_history('refresh',lambda *a,**k:None,consumer=other,pinned=first['snapshot_id'])
            current=first
            for index in range(3):
                (self.source/'message/message_0.db').write_bytes(f'changed {index}'.encode())
                current=module.managed_history('refresh',lambda *a,**k:None,consumer=consumer,pinned=current['snapshot_id'])
            generations=self.home/'.wechat-ro-local-history/generations'
            self.assertEqual(len(list(generations.glob('snapshot-*'))),3)
            self.assertTrue(Path(first['snapshot_directory']).is_dir())
            leases=self.home/'.wechat-ro-local-history/consumers.json';value=json.loads(leases.read_text())
            value[other]['pid']=999999999
            module.wcdb_key_tool._write_private_json(str(leases),value)
            unchanged=module.managed_history('refresh',lambda *a,**k:None,consumer=consumer,pinned=current['snapshot_id'])
            self.assertFalse(unchanged['changed']);self.assertEqual(len(list(generations.glob('snapshot-*'))),2)
            self.assertFalse(Path(first['snapshot_directory']).exists());self.assertTrue(Path(current['snapshot_directory']).is_dir())

    def test_explicit_reimport_recovers_rotated_keys_but_refresh_never_authenticates(self):
        first=module.managed_history('import',lambda *a,**k:None)
        registry=self.home/'.wechat-ro-local-history/source.json';original=registry.read_bytes()
        keyfile=Path(first['state'])/'runtime-keys.json';invalid={**self.keys,**{name:{'enc_key':('ff'*32)} for name in self.paths}}
        module.wcdb_key_tool._write_private_json(str(keyfile),invalid)
        (self.source/'message/message_0.db-wal').write_bytes(b'changed')
        self.snapshot.side_effect=RuntimeError('wrong keys')
        with patch.object(module.subprocess,'run') as authenticate:
            with self.assertRaises(RuntimeError):module.managed_history('refresh',lambda *a,**k:None)
            authenticate.assert_not_called();self.assertEqual(registry.read_bytes(),original)
        def capture_keys(args,**kwargs):
            output=Path(args[args.index('--output')+1]);module.wcdb_key_tool._write_private_json(str(output),self.keys)
            self.assertIn('--caller-birth',args);return SimpleNamespace(returncode=0)
        self.snapshot.side_effect=self.capture
        with patch.object(module.shutil,'which',return_value='/synthetic/pkexec'),patch.object(module.subprocess,'run',side_effect=capture_keys) as authenticate:
            result=module.managed_history('import',lambda *a,**k:None)
            self.assertEqual(authenticate.call_count,1);self.assertNotEqual(result['state'],first['state'])
            self.assertTrue(Path(first['snapshot_directory']).is_dir())

if __name__=='__main__':unittest.main()
