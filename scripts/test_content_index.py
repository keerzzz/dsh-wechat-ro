import hashlib
import json
import importlib.util
from pathlib import Path
import sqlite3
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('build_content_index', Path(__file__).with_name('build_content_index.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContentIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ['sns', 'favorite', 'message']:
            (self.root / name).mkdir()
        with sqlite3.connect(self.root / 'sns/sns.db') as db:
            db.execute('CREATE TABLE SnsTimeLine(tid INTEGER,user_name TEXT,content TEXT)')
            db.execute('INSERT INTO SnsTimeLine VALUES(1,?,?)', ('alpha', '<SnsDataItem><TimelineObject><createTime>1700000000</createTime><contentDesc>今天读书</contentDesc><ContentObject><mediaList><media/><media/></mediaList></ContentObject></TimelineObject></SnsDataItem>'))
        with sqlite3.connect(self.root / 'favorite/favorite.db') as db:
            db.execute('CREATE TABLE fav_db_item(local_id INTEGER,update_time INTEGER,fromusr TEXT,content TEXT)')
            db.execute('INSERT INTO fav_db_item VALUES(2,1700000010,?,?)', ('beta', '<favitem><desc>收藏&#1;正文</desc><weappinfo><appid>wx-test</appid><nickname>小程序</nickname></weappinfo></favitem>'))
        with sqlite3.connect(self.root / 'message/message_0.db') as db:
            db.execute('CREATE TABLE Name2Id(user_name TEXT)')
            db.execute("INSERT INTO Name2Id VALUES('alpha')")
            table = 'Msg_' + hashlib.md5(b'alpha').hexdigest()
            db.execute(f'CREATE TABLE "{table}"(local_id INTEGER,create_time INTEGER,local_type INTEGER,message_content TEXT)')
            db.execute(f'INSERT INTO "{table}" VALUES(3,1700000020,?,?)', ((33 << 32) + 49, 'alpha:\n<msg><appmsg><title>地图</title><des>导航</des><url>https://example.test/map</url><weappinfo><appid>wx-map</appid><pagepath>pages/map</pagepath></weappinfo></appmsg></msg>'))

    def rows(self, root=None):
        with sqlite3.connect((root or self.root) / 'content/content.db') as db:
            return db.execute('SELECT * FROM records ORDER BY record_ref').fetchall()

    def test_real_shapes_keep_origin_time_and_mini_card_fields(self):
        result = module.build_index(self.root)
        self.assertEqual(result['counts'], {'moments': 1, 'favorites': 1, 'miniprogram': 2})
        rows = self.rows()
        self.assertEqual(next(row[5] for row in rows if row[1] == 'favorites'), '收藏正文')
        moment = next(row for row in rows if row[1] == 'moments')
        self.assertEqual(moment[3], 1700000000)
        self.assertIn('"mediaCount": 2', moment[10])
        mini = next(row for row in rows if row[4] == '地图')
        self.assertEqual(mini[2], 'alpha')
        self.assertIn('pages/map', mini[10])
        self.assertEqual((self.root / 'content/content.db').stat().st_mode & 0o777, 0o600)

    def test_reuse_preserves_every_record_and_stable_reference(self):
        module.build_index(self.root)
        other = self.root / 'next'; other.mkdir()
        module.build_index(other, self.root, {'sns/sns.db', 'favorite/favorite.db', 'message/message_0.db'})
        self.assertEqual(self.rows(), self.rows(other))

    def test_xml_entities_and_oversized_content_are_rejected(self):
        for text in ['<!DOCTYPE x [<!ENTITY a "expanded">]><x>&a;</x>', '<x>' + 'a' * module.MAX_XML_BYTES + '</x>']:
            with self.assertRaises(ValueError): module.xml(text)

    def test_media_text_keeps_original_reference_and_rejects_changed_file(self):
        account = 'a' * 12; talker = 'alpha'; ts = 1700000000; media_hash = 'b' * 32
        media_root = self.root / 'local-msg'
        source_file = f'attach/{hashlib.md5(talker.encode()).hexdigest()}/2023-11/Img/{media_hash}_h.dat'
        original = media_root / source_file; original.parent.mkdir(parents=True); original.write_bytes(b'synthetic-media')
        info = original.stat()
        ref = hashlib.sha256(f'message/message_resource.db/MessageResourceInfo/{talker}/7/{ts}'.encode()).hexdigest()[:32]
        cache = self.root / '.local/share/dsh-wechat-ro/content-history' / account; cache.mkdir(parents=True)
        (cache / (ref + '.json')).write_text(json.dumps({'recordRef': ref, 'sourceKind': 'image', 'talker': talker, 'localId': '7', 'ts': ts,
            'mediaHash': media_hash, 'sourceFile': source_file, 'sourceIdentity': f'{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}',
            'text': '识别的中文正文', 'engine': 'synthetic-ocr', 'quality': 'original', 'generatedAt': 1}))
        with sqlite3.connect(self.root / 'message/message_resource.db') as db:
            db.executescript('CREATE TABLE ChatName2Id(user_name TEXT); CREATE TABLE MessageResourceInfo(chat_id INTEGER,message_local_id INTEGER,message_create_time INTEGER,message_local_type INTEGER,packed_info BLOB)')
            db.execute('INSERT INTO ChatName2Id VALUES(?)', (talker,))
            db.execute('INSERT INTO MessageResourceInfo VALUES(1,7,?,3,?)', (ts, bytes.fromhex('12220a20') + media_hash.encode()))
        with patch.object(Path, 'home', return_value=self.root):
            module.build_index(self.root, account_ref=account, media_root=media_root)
            row = next(row for row in self.rows() if row[1] == 'image')
            self.assertEqual(row[0], ref); self.assertEqual(row[5], '识别的中文正文')
            shutil.rmtree(self.root / 'content'); original.write_bytes(b'changed-media')
            result = module.build_index(self.root, account_ref=account, media_root=media_root)
            self.assertNotIn('image', result['counts'])


if __name__ == '__main__':
    unittest.main()
