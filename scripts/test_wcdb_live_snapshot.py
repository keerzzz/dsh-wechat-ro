#!/usr/bin/env python3
"""Synthetic-only DB/WAL regressions against the real SQLite and OpenSSL engines."""
from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor"))
import wcdb_key_tool
import wcdb_live_snapshot


KEY = hashlib.sha256(b"public synthetic key, never real WeChat data").digest()
SALT = hashlib.sha256(b"public synthetic database salt").digest()[:16]


class SQLiteFixture:
    def __init__(self, path: Path, large_baseline: bool = False):
        self.path = path
        self.lib = ctypes.CDLL(ctypes.util.find_library("sqlite3"))
        signatures = {
            "sqlite3_open": ([ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)], ctypes.c_int),
            "sqlite3_close": ([ctypes.c_void_p], ctypes.c_int),
            "sqlite3_exec": ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p,
                              ctypes.c_void_p, ctypes.c_void_p], ctypes.c_int),
            "sqlite3_file_control": ([ctypes.c_void_p, ctypes.c_char_p,
                                      ctypes.c_int, ctypes.c_void_p], ctypes.c_int),
            "sqlite3_errmsg": ([ctypes.c_void_p], ctypes.c_char_p),
        }
        for name, (args, result) in signatures.items():
            getattr(self.lib, name).argtypes = args
            getattr(self.lib, name).restype = result
        self.pointer = ctypes.c_void_p()
        assert self.lib.sqlite3_open(os.fsencode(path), ctypes.byref(self.pointer)) == 0
        # SQLITE_FCNTL_RESERVE_BYTES=38, verified in /usr/include/sqlite3.h.
        reserve = ctypes.c_int(wcdb_key_tool.RESERVE_SZ)
        assert self.lib.sqlite3_file_control(self.pointer, b"main", 38, ctypes.byref(reserve)) == 0
        self.execute("PRAGMA page_size=4096; CREATE TABLE messages(id INTEGER PRIMARY KEY, text TEXT); "
                     "INSERT INTO messages VALUES(1, 'before');")
        if large_baseline:
            self.execute("WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM n WHERE i<100) "
                         "INSERT INTO messages SELECT i, printf('%.*c', 2000, 'x') FROM n;")
        self.base = path.read_bytes()
        assert self.base[20] == wcdb_key_tool.RESERVE_SZ
        self.execute("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")

    def execute(self, statement: str):
        result = self.lib.sqlite3_exec(self.pointer, statement.encode(), None, None, None)
        assert result == 0, self.lib.sqlite3_errmsg(self.pointer).decode()

    def wal(self) -> bytes:
        return Path(str(self.path) + "-wal").read_bytes()

    def close(self):
        if self.pointer.value:
            assert self.lib.sqlite3_close(self.pointer) == 0
            self.pointer = ctypes.c_void_p()


def aes_encrypt(data: bytes, iv: bytes) -> bytes:
    ssl = wcdb_key_tool._get_ssl()
    signatures = {
        "EVP_EncryptInit_ex": ([ctypes.c_void_p] * 5, ctypes.c_int),
        "EVP_EncryptUpdate": ([ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int),
                               ctypes.c_void_p, ctypes.c_int], ctypes.c_int),
        "EVP_EncryptFinal_ex": ([ctypes.c_void_p, ctypes.c_void_p,
                                 ctypes.POINTER(ctypes.c_int)], ctypes.c_int),
    }
    for name, (args, result) in signatures.items():
        getattr(ssl, name).argtypes = args
        getattr(ssl, name).restype = result
    context = ssl.EVP_CIPHER_CTX_new()
    assert context
    try:
        assert ssl.EVP_EncryptInit_ex(context, ssl.EVP_aes_256_cbc(), None,
                                     ctypes.c_char_p(KEY), ctypes.c_char_p(iv)) == 1
        assert ssl.EVP_CIPHER_CTX_set_padding(context, 0) == 1
        output = ctypes.create_string_buffer(len(data) + 16)
        length = ctypes.c_int()
        assert ssl.EVP_EncryptUpdate(context, output, ctypes.byref(length),
                                    ctypes.c_char_p(data), len(data)) == 1
        last = ctypes.create_string_buffer(16)
        last_length = ctypes.c_int()
        assert ssl.EVP_EncryptFinal_ex(context, last, ctypes.byref(last_length)) == 1
        assert length.value == len(data) and last_length.value == 0
        return output.raw[:length.value]
    finally:
        ssl.EVP_CIPHER_CTX_free(context)


def seal_page(page: bytes, pgno: int) -> bytes:
    start = wcdb_key_tool.SALT_SZ if pgno == 1 else 0
    iv = hashlib.sha256(b"synthetic IV" + struct.pack("<I", pgno) + page).digest()[:16]
    body = aes_encrypt(page[start:wcdb_key_tool.PAGE_SZ - wcdb_key_tool.RESERVE_SZ], iv) + iv
    digest = hmac.new(wcdb_key_tool._mac_key(KEY, SALT),
                      body + struct.pack("<I", pgno), hashlib.sha512).digest()
    return (SALT if pgno == 1 else b"") + body + digest


def seal_database(database: bytes) -> bytes:
    return b"".join(seal_page(database[offset:offset + wcdb_key_tool.PAGE_SZ],
                              offset // wcdb_key_tool.PAGE_SZ + 1)
                    for offset in range(0, len(database), wcdb_key_tool.PAGE_SZ))


def rebuild_wal(wal: bytes, *, byte_order: str | None = None, encrypt: bool = False) -> bytes:
    header = bytearray(wal[:32])
    if byte_order:
        header[:4] = struct.pack(">I", 0x377f0682 if byte_order == "<" else 0x377f0683)
    order = "<" if header[:4] == bytes.fromhex("377f0682") else ">"
    state = wcdb_live_snapshot._checksum(header[:24], (0, 0), order)
    header[24:32] = struct.pack(">II", *state)
    output = bytes(header)
    frame_size = 24 + wcdb_key_tool.PAGE_SZ
    for offset in range(32, len(wal) - frame_size + 1, frame_size):
        frame = bytearray(wal[offset:offset + 24])
        page = wal[offset + 24:offset + frame_size]
        if encrypt:
            page = seal_page(page, struct.unpack(">I", frame[:4])[0])
        state = wcdb_live_snapshot._checksum(
            page, wcdb_live_snapshot._checksum(frame[:8], state, order), order)
        frame[16:24] = struct.pack(">II", *state)
        output += bytes(frame) + page
    return output


class LiveSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wcdb-live-synthetic-")
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.private = self.root / "private"
        self.plain = self.root / "plain"
        for path in (self.source, self.private, self.plain):
            path.mkdir(mode=0o700)
        self.fixture = SQLiteFixture(self.plain / "fixture.db")
        self.fixture.execute("UPDATE messages SET text='first' WHERE id=1;")
        self.first_wal = self.fixture.wal()
        self.fixture.execute("UPDATE messages SET text='latest' WHERE id=1; "
                             "INSERT INTO messages VALUES(2, printf('%.*c', 10000, 'x'));")
        self.latest_wal = self.fixture.wal()
        self.db = self.source / "messages.db"
        self.wal = Path(str(self.db) + "-wal")
        self.out = self.private / "result.db"
        self.db.write_bytes(seal_database(self.fixture.base))
        self.wal.write_bytes(rebuild_wal(self.latest_wal, encrypt=True))

    def tearDown(self):
        self.fixture.close()
        self.temporary.cleanup()

    def decrypt(self, **kwargs):
        return wcdb_live_snapshot.decrypt_live_database(str(self.db), str(self.out), KEY, **kwargs)

    def rows(self):
        with sqlite3.connect(f"file:{self.out}?mode=ro&immutable=1", uri=True) as db:
            return db.execute("SELECT id,text FROM messages ORDER BY id").fetchall()

    def keys_file(self) -> Path:
        path = self.private / "keys.json"
        path.write_text(json.dumps({"messages.db": {"enc_key": KEY.hex()}}))
        path.chmod(0o600)
        return path

    def test_native_sqlite_checksums_and_commit_boundaries_are_external_oracle(self):
        native = self.plain / "native.wal"
        native.write_bytes(self.latest_wal)
        with native.open("rb") as source:
            offsets, result = wcdb_live_snapshot._committed_wal_pages(source)
        self.assertEqual(result["wal_valid_frames"], (len(self.latest_wal) - 32) // 4120)
        self.assertEqual(result["wal_committed_frames"], result["wal_valid_frames"])
        self.assertGreater(result["committed_pages"], len(self.fixture.base) // 4096)
        self.assertIn(1, offsets)

    def test_latest_committed_rows_include_growth_and_replaced_pages(self):
        result = self.decrypt()
        self.assertEqual(self.rows(), [(1, "latest"), (2, "x" * 10000)])
        self.assertGreater(result["committed_pages"], result["base_pages"])
        self.assertEqual(result["capture_attempts"], 1)
        self.assertEqual(result["wal_uncommitted_frames"], 0)

    def test_big_endian_checksum_wal(self):
        self.wal.write_bytes(rebuild_wal(self.latest_wal, byte_order=">", encrypt=True))
        self.decrypt()
        self.assertEqual(self.rows()[0], (1, "latest"))

    def test_no_wal_reads_authenticated_baseline(self):
        self.wal.unlink()
        result = self.decrypt()
        self.assertEqual(self.rows(), [(1, "before")])
        self.assertEqual(result["wal_valid_frames"], 0)

    def test_empty_wal_reads_authenticated_baseline(self):
        self.wal.write_bytes(b"")
        self.decrypt()
        self.assertEqual(self.rows(), [(1, "before")])

    def test_authenticated_header_excludes_physical_zero_preallocation(self):
        self.wal.unlink()
        self.db.write_bytes(seal_database(self.fixture.base) + bytes(2 * 4096))
        result = self.decrypt()
        self.assertEqual(result["base_physical_pages"], len(self.fixture.base) // 4096 + 2)
        self.assertEqual(result["base_logical_pages"], len(self.fixture.base) // 4096)
        self.assertTrue(result["base_header_page_count_valid"])
        self.assertEqual(self.out.stat().st_size, len(self.fixture.base))
        self.assertEqual(self.rows(), [(1, "before")])

    def test_invalid_counter_does_not_hide_unauthenticated_zero_pages(self):
        self.wal.unlink()
        plaintext = bytearray(self.fixture.base)
        counter = int.from_bytes(plaintext[24:28], "big")
        plaintext[92:96] = ((counter + 1) & 0xffffffff).to_bytes(4, "big")
        self.db.write_bytes(seal_database(bytes(plaintext)) + bytes(2 * 4096))
        with self.assertRaisesRegex(ValueError, "HMAC"):
            self.decrypt()
        self.assertFalse(self.out.exists())

    def test_invalid_counter_uses_fully_authenticated_physical_baseline(self):
        self.wal.unlink()
        plaintext = bytearray(self.fixture.base)
        counter = int.from_bytes(plaintext[24:28], "big")
        plaintext[92:96] = ((counter + 1) & 0xffffffff).to_bytes(4, "big")
        plaintext[28:32] = (1).to_bytes(4, "big")
        self.db.write_bytes(seal_database(bytes(plaintext)))
        result = self.decrypt()
        self.assertFalse(result["base_header_page_count_valid"])
        self.assertEqual(result["base_header_page_count"], 1)
        self.assertEqual(result["base_logical_pages"], result["base_physical_pages"])
        self.assertEqual(self.rows(), [(1, "before")])

    def test_zero_page_inside_authenticated_logical_range_is_rejected(self):
        self.wal.unlink()
        self.db.write_bytes(seal_page(self.fixture.base[:4096], 1) + bytes(4096))
        with self.assertRaisesRegex(ValueError, "HMAC"):
            self.decrypt()
        self.assertFalse(self.out.exists())

    def test_wal_growth_commit_overrides_preallocated_physical_baseline(self):
        self.db.write_bytes(seal_database(self.fixture.base) + bytes(15 * 4096))
        result = self.decrypt()
        self.assertGreater(result["committed_pages"], result["base_logical_pages"])
        self.assertLess(result["committed_pages"], result["base_physical_pages"])
        self.assertEqual(self.rows(), [(1, "latest"), (2, "x" * 10000)])

    def test_wal_physical_commit_excludes_authenticated_header_zero_preallocation(self):
        physical = len(self.fixture.base) // 4096 + 2
        self.db.write_bytes(seal_database(self.fixture.base) + bytes(2 * 4096))
        wal = bytearray(self.first_wal)
        for offset in range(32, len(wal), 4120):
            if int.from_bytes(wal[offset + 4:offset + 8], "big"):
                wal[offset + 4:offset + 8] = physical.to_bytes(4, "big")
        self.wal.write_bytes(rebuild_wal(bytes(wal), encrypt=True))
        result = self.decrypt()
        self.assertEqual(result["wal_commit_page_count"], physical)
        self.assertEqual(result["committed_pages"], len(self.fixture.base) // 4096)
        self.assertEqual(result["excluded_zero_preallocation_pages"], 2)
        self.assertTrue(result["final_header_page_count_valid"])
        self.assertEqual(self.rows(), [(1, "first")])

    def test_wal_physical_commit_cannot_hide_invalid_header_or_nonzero_tail(self):
        physical = len(self.fixture.base) // 4096 + 2
        wal = bytearray(self.first_wal)
        for offset in range(32, len(wal), 4120):
            if int.from_bytes(wal[offset + 4:offset + 8], "big"):
                wal[offset + 4:offset + 8] = physical.to_bytes(4, "big")
        self.wal.write_bytes(rebuild_wal(bytes(wal), encrypt=True))
        for invalid_counter in (True, False):
            with self.subTest(invalid_counter=invalid_counter):
                plaintext = bytearray(self.fixture.base)
                if invalid_counter:
                    plaintext[92:96] = (int.from_bytes(plaintext[24:28], "big") + 1).to_bytes(4, "big")
                tail = bytes(2 * 4096) if invalid_counter else b"x" + bytes(2 * 4096 - 1)
                self.db.write_bytes(seal_database(bytes(plaintext)) + tail)
                with self.assertRaisesRegex(ValueError, "HMAC"):
                    self.decrypt()
                self.assertFalse(self.out.exists())

    def test_uncommitted_native_sqlite_spill_is_excluded(self):
        self.fixture.execute("PRAGMA cache_size=1; BEGIN; "
                             "WITH RECURSIVE n(i) AS (SELECT 3 UNION ALL SELECT i+1 FROM n WHERE i<100) "
                             "INSERT INTO messages SELECT i, printf('%.*c', 5000, 'u') FROM n;")
        self.wal.write_bytes(rebuild_wal(self.fixture.wal(), encrypt=True))
        result = self.decrypt()
        self.assertGreater(result["wal_uncommitted_frames"], 0)
        self.assertEqual(self.rows(), [(1, "latest"), (2, "x" * 10000)])
        self.fixture.execute("ROLLBACK;")

    def test_native_vacuum_commit_truncates_database(self):
        self.fixture.close()
        self.fixture = SQLiteFixture(self.plain / "large.db", large_baseline=True)
        self.fixture.execute("DELETE FROM messages WHERE id>1; VACUUM;")
        self.db.write_bytes(seal_database(self.fixture.base) + bytes(5 * 4096))
        self.wal.write_bytes(rebuild_wal(self.fixture.wal(), encrypt=True))
        result = self.decrypt()
        self.assertLess(result["committed_pages"], result["base_pages"])
        self.assertLess(result["committed_pages"], result["base_logical_pages"])
        self.assertLess(result["base_logical_pages"], result["base_physical_pages"])
        self.assertEqual(self.rows(), [(1, "before")])

    def test_stale_generation_tail_is_reported_and_excluded(self):
        content = self.wal.read_bytes()
        tail = bytearray(content[-4120:])
        tail[8] ^= 1
        self.wal.write_bytes(content + tail)
        result = self.decrypt()
        self.assertEqual(result["wal_tail_reason"], "previous-generation-salt")
        self.assertEqual(result["wal_tail_bytes"], 4120)
        self.assertEqual(self.rows()[0], (1, "latest"))

    def test_partial_trailing_frame_is_reported_and_excluded(self):
        with self.wal.open("ab") as wal:
            wal.write(b"unfinished frame")
        result = self.decrypt()
        self.assertEqual(result["wal_tail_reason"], "incomplete-frame")
        self.assertEqual(result["wal_tail_bytes"], 16)
        self.assertEqual(self.rows()[0], (1, "latest"))

    def test_wal_header_checksum_rejected(self):
        content = bytearray(self.wal.read_bytes())
        content[12] ^= 1
        self.wal.write_bytes(content)
        with self.assertRaisesRegex(ValueError, "header checksum"):
            self.decrypt()
        self.assertFalse(self.out.exists())

    def test_same_generation_frame_checksum_damage_is_rejected(self):
        content = bytearray(self.wal.read_bytes())
        content[32 + 24 + 50] ^= 1
        self.wal.write_bytes(content)
        with self.assertRaisesRegex(ValueError, "frame checksum"):
            self.decrypt()
        self.assertFalse(self.out.exists())

    def test_wal_hmac_damage_with_recomputed_checksum_is_rejected(self):
        content = bytearray(self.wal.read_bytes())
        content[-100] ^= 1
        self.wal.write_bytes(rebuild_wal(bytes(content)))
        with self.assertRaisesRegex(ValueError, "HMAC"):
            self.decrypt()
        self.assertFalse(self.out.exists())

    def test_wrong_key_is_rejected_without_output(self):
        with self.assertRaisesRegex(ValueError, "HMAC"):
            wcdb_live_snapshot.decrypt_live_database(str(self.db), str(self.out), b"z" * 32)
        self.assertFalse(self.out.exists())

    def test_bad_base_page_is_rejected(self):
        self.wal.write_bytes(rebuild_wal(self.first_wal, encrypt=True))
        content = bytearray(self.db.read_bytes())
        content[200] ^= 1  # page 1 is absent from the update-only first WAL.
        self.db.write_bytes(content)
        with self.assertRaisesRegex(ValueError, "HMAC"):
            self.decrypt()
        self.assertFalse(self.out.exists())

    def test_active_rollback_journal_is_rejected(self):
        Path(str(self.db) + "-journal").write_bytes(b"active rollback fixture")
        with self.assertRaisesRegex(ValueError, "rollback journal"):
            self.decrypt()
        self.assertFalse(self.out.exists())

    def test_wal_creation_during_copy_retries_with_new_committed_state(self):
        content = self.wal.read_bytes()
        self.wal.unlink()
        original = wcdb_live_snapshot._copy_file
        created = False

        def copy_and_create(source, destination):
            nonlocal created
            result = original(source, destination)
            if not created:
                self.wal.write_bytes(content)
                created = True
            return result

        with patch.object(wcdb_live_snapshot, "_copy_file", copy_and_create):
            result = self.decrypt()
        self.assertEqual(result["capture_attempts"], 2)
        self.assertEqual(self.rows()[0], (1, "latest"))

    def test_same_bytes_wal_inode_replacement_is_detected_and_retried(self):
        original = wcdb_live_snapshot._copy_file
        replaced = False

        def copy_and_replace(source, destination):
            nonlocal replaced
            result = original(source, destination)
            if not replaced:
                other = self.source / "replacement"
                other.write_bytes(self.wal.read_bytes())
                os.replace(other, self.wal)
                replaced = True
            return result

        with patch.object(wcdb_live_snapshot, "_copy_file", copy_and_replace):
            result = self.decrypt()
        self.assertEqual(result["capture_attempts"], 2)
        self.assertEqual(self.rows()[0], (1, "latest"))

    def test_continuous_real_source_changes_exhaust_attempts_and_clean_staging(self):
        original = wcdb_live_snapshot._copy_file
        mutations = 0

        def copy_and_mutate(source, destination):
            nonlocal mutations
            result = original(source, destination)
            if destination.endswith("source.db"):
                content = bytearray(self.db.read_bytes())
                content[50] ^= 1
                self.db.write_bytes(content)
                mutations += 1
            return result

        with patch.object(wcdb_live_snapshot, "_copy_file", copy_and_mutate):
            with self.assertRaises(wcdb_live_snapshot.SourceChanged):
                self.decrypt(max_attempts=2)
        self.assertEqual(mutations, 2)
        self.assertFalse(self.out.exists())
        self.assertEqual(list(self.private.iterdir()), [])

    def test_source_readonly_modes_and_bytes_are_preserved(self):
        before = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in (self.db, self.wal)}
        self.db.chmod(0o400)
        self.wal.chmod(0o400)
        self.source.chmod(0o500)
        try:
            self.decrypt()
            self.assertEqual({path.name: (path.read_bytes(), path.stat().st_mtime_ns)
                              for path in (self.db, self.wal)}, before)
            self.assertEqual(set(path.name for path in self.source.iterdir()), set(before))
            self.assertEqual(self.out.stat().st_mode & 0o777, 0o600)
        finally:
            self.source.chmod(0o700)

    def test_standalone_output_uses_rollback_header_and_ordinary_readonly_sqlite(self):
        self.decrypt()
        self.assertEqual(self.out.read_bytes()[18:20], b"\x01\x01")
        before = set(self.private.iterdir())
        with sqlite3.connect(f"file:{self.out}?mode=ro", uri=True) as db:
            self.assertEqual(db.execute("SELECT text FROM messages WHERE id=1").fetchone(), ("latest",))
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
        self.assertEqual(set(self.private.iterdir()), before)

    def test_existing_archive_worker_reads_materialized_wal_contact(self):
        self.fixture.execute("CREATE TABLE contact(username TEXT, nick_name TEXT); "
                             "INSERT INTO contact VALUES('synthetic-gaowei', '高伟');")
        self.wal.write_bytes(rebuild_wal(self.fixture.wal(), encrypt=True))
        archive = self.private / "archive"
        output = archive / "contact" / "contact.db"
        wcdb_live_snapshot.decrypt_live_database(str(self.db), str(output), KEY)
        module = (Path(__file__).resolve().parents[1] / "plugin/lib/archive-query-worker.js").as_uri()
        code = "import {captureArchiveMetadata,runArchiveQuery} from " + json.dumps(module) + ";\n" + """
const root=process.argv[1];
const expected=captureArchiveMetadata(root);
const result=runArchiveQuery({root,expected,
  scope:{allConversations:true,talkers:[],fromTs:null,toTs:null},
  query:{action:'contacts',query:'高伟',limit:10,offset:0}});
process.stdout.write(JSON.stringify(result.rows));
"""
        result = subprocess.run(["node", "--input-type=module", "--eval", code, str(archive)],
                                check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)[0]["talker"], "synthetic-gaowei")
        self.assertEqual(json.loads(result.stdout)[0]["displayName"], "高伟")

    def test_selected_database_paths_exclude_fts_and_unrequested_families(self):
        (self.source / "message").mkdir(mode=0o700)
        (self.source / "chatbot").mkdir(mode=0o700)
        selected = self.source / "message" / "message_0.db"
        self.db.rename(selected)
        self.wal.rename(Path(str(selected) + "-wal"))
        (self.source / "message" / "message_fts.db").write_bytes(b"unrequested synthetic FTS")
        (self.source / "chatbot" / "chatbot.db").write_bytes(b"unrequested synthetic chatbot")
        keys = self.private / "keys.json"
        keys.write_text(json.dumps({"message/message_0.db": {"enc_key": KEY.hex()}}))
        keys.chmod(0o600)
        destination = self.private / "snapshot"
        result = wcdb_live_snapshot.snapshot_live(str(self.source), str(destination), str(keys),
                                                 selected_paths=["message/message_0.db"])
        self.assertEqual(result["total"], 1)
        manifest = json.loads((destination / "decrypted" / ".wechat-ro-manifest.json").read_text())
        self.assertEqual(manifest["source_scope"], {"databases": ["message/message_0.db"]})
        self.assertEqual([item["path"] for item in manifest["files"]], ["message/message_0.db"])
        with self.assertRaisesRegex(ValueError, "集合不完整"):
            wcdb_live_snapshot.snapshot_live(str(self.source), str(destination), str(keys),
                                             selected_paths=["message/message_0.db", "message/missing.db"])

    def test_cli_authenticated_bad_sqlite_returns_safe_json_without_traceback(self):
        damaged = bytearray(self.fixture.base)
        damaged[16:18] = b"\x00\x03"  # Invalid SQLite page size, then correctly encrypt/MAC it.
        self.db.write_bytes(seal_database(bytes(damaged)))
        self.wal.unlink()
        result = subprocess.run([sys.executable, str(Path(wcdb_live_snapshot.__file__)),
                                 "--db-dir", str(self.source), "--output", str(self.private / "snapshot"),
                                 "--keys", str(self.keys_file())], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout),
                         {"complete": False, "published": False, "error": "DatabaseError"})
        self.assertEqual(result.stderr, "")
        self.assertNotIn(KEY.hex(), result.stdout)
        self.assertFalse((self.private / "snapshot").exists())

    def test_complete_snapshot_manifest_hashes_and_atomic_refresh(self):
        keys = self.keys_file()
        destination = self.private / "snapshot"
        result = wcdb_live_snapshot.snapshot_live(str(self.source), str(destination), str(keys))
        manifest_path = destination / "decrypted" / ".wechat-ro-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(result["consistency"], wcdb_live_snapshot.CONSISTENCY)
        self.assertEqual(manifest["consistency"], wcdb_live_snapshot.CONSISTENCY)
        self.assertTrue(manifest["complete"])
        self.assertEqual(manifest["files"][0]["sha256"],
                         hashlib.sha256((destination / "decrypted" / "messages.db").read_bytes()).hexdigest())
        self.assertEqual(manifest["databases"][0]["wal_uncommitted_frames"], 0)
        refreshed = wcdb_live_snapshot.snapshot_live(str(self.source), str(destination), str(keys))
        backup = Path(refreshed["backup_dir"])
        self.assertTrue(backup.is_dir())
        self.assertEqual(json.loads((backup / "decrypted" / ".wechat-ro-manifest.json").read_text()), manifest)

    def test_invalid_refresh_preserves_previous_complete_snapshot(self):
        keys = self.keys_file()
        destination = self.private / "snapshot"
        wcdb_live_snapshot.snapshot_live(str(self.source), str(destination), str(keys))
        before = (destination / "decrypted" / ".wechat-ro-manifest.json").read_bytes()
        keys.write_text(json.dumps({"messages.db": {"enc_key": (b"b" * 32).hex()}}))
        with self.assertRaisesRegex(ValueError, "HMAC"):
            wcdb_live_snapshot.snapshot_live(str(self.source), str(destination), str(keys))
        self.assertEqual((destination / "decrypted" / ".wechat-ro-manifest.json").read_bytes(), before)
        self.assertFalse(any(path.name.startswith(".snapshot.backup-") for path in self.private.iterdir()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
