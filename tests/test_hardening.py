"""Repair regressions on disposable SQLite data; no real WeChat/profile access.

Run with explicit WECHAT_FIXTURE_DIR, WECHAT_SNAPSHOT_DIR and TMPDIR. Tests
create their own per-case roots below TMPDIR and restore the caller's env.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import zstandard as zstd

from wechat_ro_mcp import db as D
from wechat_ro_mcp import service as S


NOW = datetime(2026, 11, 6, 12, 0, tzinfo=D.LOCAL_TZ)
EPOCH = int(NOW.timestamp())


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


def notes(result):
    return " ".join(result.get("notes", []))


class HardeningTests(unittest.TestCase):
    def setUp(self):
        for name in ("WECHAT_FIXTURE_DIR", "WECHAT_SNAPSHOT_DIR", "TMPDIR"):
            if not os.environ.get(name):
                self.fail(f"{name} must explicitly isolate synthetic tests")
        self.tmp = tempfile.TemporaryDirectory(prefix="python-regression-", dir=os.environ["TMPDIR"])
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "snapshot"
        self.root.mkdir()
        self.env = patch.dict(os.environ, {"WECHAT_SNAPSHOT_DIR": str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)
        D._CACHE.clear()

    def script(self, rel, schema, params=None, root=None):
        path = (root or self.root) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as conn:
            if params is None:
                conn.executescript(schema)
            else:
                conn.executemany(schema, params)
            conn.commit()
        return path

    def contacts(self, users=(('wxid_alice', 'Alice'), ('wxid_bob', 'Bob')), root=None):
        self.script("contact/contact.db", "CREATE TABLE contact(username TEXT, remark TEXT)", root=root)
        return self.script("contact/contact.db", "INSERT INTO contact VALUES (?,?)", users, root=root)

    def messages(self, user="wxid_alice", rows=None, rel="message/message_0.db", root=None, table=None):
        table = table or "Msg_" + D.md5_hex(user)
        self.script(rel, f"CREATE TABLE {D.qi(table)}(local_id INTEGER, create_time INTEGER, "
                    "message_content, real_sender_id TEXT, local_type INTEGER, source)", root=root)
        values = [(i + 1, ts, text, user, 1, "") for i, (ts, text) in
                  enumerate(rows if rows is not None else [(EPOCH, "hello")])]
        self.script(rel, f"INSERT INTO {D.qi(table)} VALUES (?,?,?,?,?,?)", values, root=root)
        return table

    def test_py01_reject_file_and_directory_symlinks(self):
        outside = self.base / "outside"
        secret = self.script("secret.db", "CREATE TABLE private(value); INSERT INTO private VALUES('SECRET')", root=outside)
        digest = hashlib.sha256(secret.read_bytes()).hexdigest()
        (self.root / "leak.db").symlink_to(secret)
        (self.root / "linked-directory").symlink_to(outside, target_is_directory=True)
        status = S.status()
        self.assertEqual(status["db_count"], 0)
        self.assertIn("符号链接", notes(status))
        self.assertEqual(S.sql("leak.db", "SELECT * FROM private")["returned"], 0)
        self.assertEqual(hashlib.sha256(secret.read_bytes()).hexdigest(), digest)
        plain = self.script("plain.db", "CREATE TABLE safe(value); INSERT INTO safe VALUES('ok')")
        with D.get_snapshot(self.root).open(plain) as conn:
            self.assertEqual(conn.execute("SELECT value FROM safe").fetchone()[0], "ok")
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("INSERT INTO safe VALUES ('bad')")

    def test_py01_recheck_open_after_discovery_and_sidecar_links(self):
        path = self.script("data.db", "CREATE TABLE safe(value)")
        snap = D.get_snapshot(self.root)
        secret = self.script("outside.db", "CREATE TABLE secret(value)", root=self.base)
        path.unlink()
        path.symlink_to(secret)
        with self.assertRaises(ValueError):
            with snap.open(path):
                self.fail("a replaced symlink must not open")
        path.unlink()
        path = self.script("data.db", "CREATE TABLE safe(value)")
        path.with_name(path.name + "-wal").symlink_to(secret)
        with self.assertRaises(ValueError):
            with snap.open(path):
                self.fail("a symlink WAL must not open")

    def test_py01_reject_replaced_root(self):
        path = self.script("data.db", "CREATE TABLE safe(value)")
        snap = D.get_snapshot(self.root)
        moved = self.base / "moved"
        self.root.rename(moved)
        self.root.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError):
            with snap.open(path):
                self.fail("root identity changed into symlink")

    def test_py02_exact_candidate_beats_duplicate_substrings(self):
        path = self.script("tables.db", "CREATE TABLE contact(username TEXT); "
                           "CREATE TABLE contact_user_index(username TEXT, alias TEXT, remark TEXT)")
        with D.ro(path) as conn:
            got = D.resolve_table(conn, ["contact", "Contact", "user"],
                                  {"uname": ["username"], "alias": ["alias"], "remark": ["remark"]}, ["uname"])
        self.assertEqual(got["table"], "contact")

    def test_py02_require_columns_before_ranking_and_reject_ties(self):
        path = self.script("tables.db", "CREATE TABLE contact(unrelated TEXT); CREATE TABLE actual(username TEXT)")
        with D.ro(path) as conn:
            got = D.resolve_table(conn, ["contact"], {"uname": ["username"]}, ["uname"])
        self.assertEqual(got["table"], "actual")
        self.script("tables.db", "CREATE TABLE another(username TEXT)")
        warnings = []
        with D.ro(path) as conn:
            self.assertIsNone(D.resolve_table(conn, ["contact"], {"uname": ["username"]}, ["uname"], warnings))
        self.assertIn("歧义", " ".join(warnings))

    def test_py02_ambiguous_schema_is_explained_in_service(self):
        self.script("contact/contact.db", "CREATE TABLE contact_a(username, remark); CREATE TABLE contact_b(username, remark)")
        got = S.contacts()
        self.assertEqual(got["returned"], 0)
        self.assertIn("歧义", notes(got))

    def test_py03_never_fall_back_to_another_sessions_only_table(self):
        self.contacts()
        self.messages(rows=[(EPOCH, "Alice private")])
        self.assertEqual(S.messages("wxid_alice")["rows"][0]["content"], "Alice private")
        for got in (S.messages("wxid_bob"), S.search_messages("private", session="wxid_bob")):
            self.assertEqual(got["returned"], 0)
        self.assertIn("没有跨会话回退", notes(S.messages("wxid_bob")))
        with patch.object(S, "datetime", FrozenDateTime):
            self.assertEqual(S.timeline(1, "wxid_bob")["total_messages"], 0)

    def test_py03_direct_hash_identity_is_exact_not_suffix(self):
        self.messages(user="wxid_lonely")
        got = S.messages("wxid_lonely")
        self.assertEqual(got["rows"][0]["session"], "wxid_lonely")
        self.assertEqual(S.search_messages("hello", session="wxid_lonely")["total"], 1)
        self.messages(user="wxid_other", table="Msg_prefix" + D.md5_hex("wxid_other"))
        self.assertEqual(S.messages("wxid_other")["returned"], 0)

    def test_py04_room_membership_is_exact_nonempty_and_case_sensitive(self):
        self.contacts((('123@chatroom', 'room'),))
        self.script("contact/contact.db", "CREATE TABLE chatroom_member(room TEXT COLLATE NOCASE, member_username TEXT)")
        self.script("contact/contact.db", "INSERT INTO chatroom_member VALUES (?,?)", [
            ("123@chatroom", "valid"), ("x123@chatroom", "prefix"), ("123@chatroomX", "suffix"),
            (None, "null"), ("", "empty"), ("123@CHATROOM", "case"), ("different", "other")])
        got = S.chatroom_members("123@chatroom")
        self.assertEqual([(r["chatroom"], r["member"]) for r in got["rows"]], [("123@chatroom", "valid")])
        self.assertEqual(S.chatroom_members("none@chatroom")["returned"], 0)

    def test_py04_unrelated_rooms_do_not_exhaust_member_scan(self):
        self.contacts((('123@chatroom', 'room'),))
        self.script("contact/contact.db", "CREATE TABLE chatroom_member(room TEXT, member_username TEXT)")
        self.script("contact/contact.db", "INSERT INTO chatroom_member VALUES (?,?)",
                    [("other@chatroom", f"other{i}") for i in range(D.SCAN_CAP + 1)] + [("123@chatroom", "valid")])
        got = S.chatroom_members("123@chatroom")
        self.assertEqual(got["rows"][0]["member"], "valid")
        self.assertTrue(got["scan_complete"])

    def test_py04_missing_named_ownership_columns_are_not_guessed(self):
        self.contacts((('123@chatroom', 'room'),))
        self.script("contact/contact.db", "CREATE TABLE chatroom_member(untrusted TEXT, member_username TEXT)")
        self.script("contact/contact.db", "INSERT INTO chatroom_member VALUES (?,?)", [("123@chatroom", "not-proven")])
        denied = S.chatroom_members("123@chatroom")
        self.assertEqual(denied["returned"], 0)
        self.assertFalse(denied["scan_complete"])
        self.assertIn("缺少", notes(denied))
        # Positive control: an explicit room_id now proves ownership.
        self.script("contact/contact.db", "ALTER TABLE chatroom_member RENAME COLUMN untrusted TO room_id")
        allowed = S.chatroom_members("123@chatroom")
        self.assertEqual(allowed["rows"][0]["member"], "not-proven")
        self.assertTrue(allowed["scan_complete"])

    def test_py05_sql_limit_plus_one_and_exact_tail(self):
        self.script("data.db", "CREATE TABLE t(n); INSERT INTO t VALUES(1),(2),(3)")
        limited = S.sql("data.db", "SELECT n FROM t ORDER BY n", 2)
        self.assertEqual([r["n"] for r in limited["rows"]], [1, 2])
        self.assertEqual(limited["total"], 3)
        self.assertFalse(limited["total_is_exact"])
        self.assertTrue(limited["truncated"] and limited["has_more"])
        self.assertIn("下界", notes(limited))
        for limit in (3, 4):
            full = S.sql("data.db", "SELECT n FROM t", limit)
            self.assertTrue(full["total_is_exact"])
            self.assertFalse(full["truncated"] or full["has_more"])
        empty = S.sql("data.db", "SELECT n FROM t WHERE n > 9", 1)
        self.assertEqual(empty["total"], 0)
        self.assertTrue(empty["total_is_exact"])

    def test_py05_sql_hard_cap_and_write_guards_remain(self):
        path = self.script("data.db", "CREATE TABLE t(n)")
        self.script("data.db", "INSERT INTO t VALUES (?)", [(i,) for i in range(501)])
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        got = S.sql("data.db", "SELECT n FROM t", 9999)
        self.assertEqual((got["returned"], got["total"]), (500, 501))
        self.assertFalse(got["total_is_exact"])
        for query in ("DELETE FROM t", "SELECT 1; SELECT 2", "SELECT ?", "ATTACH 'other' AS x"):
            self.assertIn("拒绝", notes(S.sql("data.db", query)))
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

    def table_cap_fixture(self, count):
        path = self.root / "message/message_0.db"
        path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(path)) as conn:
            for i in range(count):
                table = f"Msg_{i:032x}"
                conn.execute(f"CREATE TABLE {table}(create_time INTEGER, message_content TEXT)")
                conn.execute(f"INSERT INTO {table} VALUES (?,?)", (EPOCH, "hidden-needle" if i == 300 else "visible"))
            conn.commit()

    def test_py06_over_300_tables_is_explicit_not_a_false_exact_zero(self):
        self.table_cap_fixture(301)
        got = S.search_messages("hidden-needle")
        self.assertEqual(got["returned"], 0)
        self.assertFalse(got["scan_complete"] or got["total_is_exact"] or got["has_more"])
        self.assertTrue(got["truncated"])
        self.assertIn("301", notes(got))
        status = S.status()
        self.assertEqual(status["message_table_count"], 301)
        self.assertEqual(status["indexed_message_table_count"], 300)
        self.assertEqual(status["message_table_counts"]["message/message_0.db"], {"discovered": 301, "indexed": 300})
        with patch.object(S, "datetime", FrozenDateTime):
            timeline = S.timeline(1)
        self.assertFalse(timeline["scan_complete"])
        self.assertIn("300", notes(timeline))

    def test_py06_exactly_300_tables_has_no_false_cap_warning(self):
        self.table_cap_fixture(300)
        got = S.search_messages("visible", 500)
        self.assertEqual(got["total"], 300)
        self.assertTrue(got["scan_complete"] and got["total_is_exact"])
        self.assertNotIn("表扫描上限", notes(got))

    def test_py07_text_blob_and_zstd_share_one_final_truncation(self):
        text = "😀" * 4994 + "needle"
        self.contacts()
        self.messages(rows=[(EPOCH, text), (EPOCH - 1, text.encode()), (EPOCH - 2, zstd.ZstdCompressor().compress(text.encode()))])
        got = S.messages("wxid_alice")
        for row in got["rows"]:
            self.assertEqual(row["content"], text[:1200] + "…[截断, 共5000字符]")
            self.assertEqual(row["content"].count("[截断"), 1)
        search = S.search_messages("needle")
        self.assertEqual(search["total"], 3)
        for row in search["rows"]:
            self.assertEqual(row["content"], text[:300] + "…[截断, 共5000字符]")
        table = "Msg_" + D.md5_hex("wxid_alice")
        raw = S.sql("message/message_0.db", f"SELECT message_content FROM {table}")
        self.assertTrue(all(r["message_content"].endswith("共5000字符]") for r in raw["rows"]))

    def test_py07_session_summary_and_contact_display_do_not_double_truncate(self):
        text = "长" * 5000
        self.contacts((("wxid_alice", text),))
        self.script("session/session.db", "CREATE TABLE SessionTable(username TEXT, summary, last_timestamp INTEGER)")
        self.script("session/session.db", "INSERT INTO SessionTable VALUES (?,?,?)", [("wxid_alice", text.encode(), EPOCH)])
        contact = S.contacts()["rows"][0]
        session = S.sessions()["rows"][0]
        for value in (contact["display_name"], contact["remark"], session["summary"], session["display_name"]):
            self.assertEqual(value, text[:1200] + "…[截断, 共5000字符]")

    def test_py07_zstd_malformed_empty_unknown_size_and_decode_budget(self):
        compressor = zstd.ZstdCompressor(write_checksum=True)
        frame = compressor.compress(b"hello")
        self.assertEqual(D.decode_content(compressor.compress(b"")), "")
        self.assertEqual(D.decode_content(frame), "hello")
        self.assertEqual(D.decode_content(zstd.ZstdCompressor(write_content_size=False).compress(b"unknown-size")), "unknown-size")
        for bad in (D.ZSTD_MAGIC, frame[:-1], frame + b"junk", frame + frame):
            self.assertIn("zstd 解压失败", D.decode_content(bad))
        with patch.object(D, "MAX_DECODED_BYTES", 128):
            for c in (zstd.ZstdCompressor(), zstd.ZstdCompressor(write_content_size=False)):
                self.assertIn("zstd 解压失败", D.decode_content(c.compress(b"x" * 129)))
                self.assertEqual(D.decode_content(c.compress(b"x" * 128)), "x" * 128)
        self.assertEqual(D.clean(b"short"), "short")
        self.assertIn("�", D.clean(b"\xff"))

    def test_py08_timeline_is_a_closed_past_window(self):
        self.contacts()
        self.messages(rows=[(EPOCH - 86400, "start"), (EPOCH, "end"), (EPOCH - 1, "inside"),
                            (EPOCH + 1, "future"), (EPOCH + 366 * 86400, "far future"), (EPOCH - 86401, "too old")])
        with patch.object(S, "datetime", FrozenDateTime):
            got = S.timeline(1)
        self.assertEqual(got["total_messages"], 3)
        self.assertEqual(sum(r["messages"] for r in got["rows"]), 3)
        self.assertTrue(got["total_is_exact"])

    def test_py09_root_switch_does_not_reuse_other_root_message_paths(self):
        other = self.base / "second"
        other.mkdir()
        for root, label in ((self.root, "AAAA"), (other, "BBBB")):
            self.contacts(root=root)
            self.messages(rows=[(EPOCH, label)], root=root)
            for path in root.rglob("*.db"):
                os.utime(path, ns=(1700000000123456000, 1700000000123456000))
        self.assertEqual(S.messages("wxid_alice")["rows"][0]["content"], "AAAA")
        with patch.dict(os.environ, {"WECHAT_SNAPSHOT_DIR": str(other)}):
            self.assertEqual(S.messages("wxid_alice")["rows"][0]["content"], "BBBB")

    def test_py09_submicrosecond_mtime_and_inode_changes_refresh_snapshot(self):
        path = self.script("data.db", "CREATE TABLE t(n)")
        stamp = 1700000000123456000
        os.utime(path, ns=(stamp, stamp))
        first = D.get_snapshot(self.root)
        os.utime(path, ns=(stamp, stamp + 100))
        second = D.get_snapshot(self.root)
        self.assertEqual(first.dbs[0]["mtime"], second.dbs[0]["mtime"])
        self.assertIsNot(first, second)
        replacement = self.root / "replacement.tmp"
        replacement.write_bytes(path.read_bytes())
        os.utime(replacement, ns=(stamp, stamp + 100))
        replacement.replace(path)
        self.assertIsNot(second, D.get_snapshot(self.root))

    def test_py09_wal_only_change_refreshes_cache(self):
        path = self.script("data.db", "CREATE TABLE t(n)")
        first = D.get_snapshot(self.root)
        wal = path.with_name(path.name + "-wal")
        wal.write_bytes(b"synthetic-metadata-only")
        second = D.get_snapshot(self.root)
        self.assertIsNot(first, second)
        self.assertEqual(first.dbs[0]["mtime"], second.dbs[0]["mtime"])

    def test_shared_mixed_units_are_sorted_before_row_cap(self):
        self.contacts()
        self.messages(rows=[((EPOCH - 10000 - i) * 1000000, "old") for i in range(D.SCAN_CAP)]
                      + [(EPOCH, "newest-needle"), ((EPOCH - 1) * 1000, "second")])
        got = S.messages("wxid_alice", 2)
        self.assertEqual([r["content"] for r in got["rows"]], ["newest-needle", "second"])
        search = S.search_messages("newest-needle")
        self.assertEqual(search["returned"], 1)
        self.assertFalse(search["scan_complete"] or search["total_is_exact"])
        self.assertFalse(search["has_more"])
        self.assertTrue(search["truncated"])

    def test_shared_exact_row_cap_is_complete_and_invalid_epochs_do_not_crash(self):
        self.contacts()
        self.messages(rows=[(EPOCH - i, "row") for i in range(D.SCAN_CAP)])
        got = S.messages("wxid_alice")
        self.assertEqual(got["total"], D.SCAN_CAP)
        self.assertTrue(got["scan_complete"] and got["total_is_exact"])
        self.assertNotIn("达到扫描上限", notes(got))
        for value in (float("inf"), "not-time", 10 ** 100):
            self.assertEqual(D.norm_ts(value), (None, None))

    def test_shared_ranking_uses_username_not_display_label(self):
        self.contacts((("wxid_alice", "同名"), ("wxid_bob", "同名")))
        self.messages(rows=[(EPOCH, "one"), (EPOCH - 1, "two")])
        self.messages(user="wxid_bob", rows=[(EPOCH, "three")])
        with patch.object(S, "datetime", FrozenDateTime):
            got = S.timeline(1)
        self.assertEqual([(r["username"], r["messages"]) for r in got["top_sessions"]],
                         [("wxid_alice", 2), ("wxid_bob", 1)])
        self.assertTrue(all(r["session"] == "同名" for r in got["top_sessions"]))

    def test_shared_invalid_nonempty_dates_raise_and_valid_bounds_are_inclusive(self):
        self.contacts()
        self.messages()
        for bad in ("not-date", "2026-02-30", "2026-13-01", "2026-11-06T24:00:00",
                    "2026-11-06T12:00:00+00:60", "2026-11-06garbage", "NaN",
                    str(10 ** 100), str(-(10 ** 100))):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, "无效日期"):
                S.messages("wxid_alice", after=bad)
        with self.assertRaisesRegex(ValueError, "after"):
            S.messages("wxid_alice", after="2026-11-07", before="2026-11-06")
        for bound in (str(EPOCH), str(EPOCH * 1000), str(EPOCH * 1000000), "2026-11-06T04:00:00Z", "2026-11-06T12:00:00+08:00"):
            got = S.messages("wxid_alice", before=bound, after=bound)
            self.assertEqual(got["returned"], 1)
        self.assertIsNotNone(S._parse_bound("2024-02-29"))
        self.assertIsNone(S._parse_bound(" "))
        self.assertEqual(S._parse_bound("0"), 0)

    def test_shared_partial_database_errors_survive_search_and_timeline(self):
        self.contacts()
        self.messages(rows=[(EPOCH, "valid-needle")])
        bad = self.root / "message/broken.db"
        bad.write_bytes(b"not sqlite")
        got = S.search_messages("needle")
        self.assertEqual(got["returned"], 1)
        self.assertFalse(got["scan_complete"] or got["total_is_exact"])
        self.assertIn("broken.db", notes(got))
        with patch.object(S, "datetime", FrozenDateTime):
            timeline = S.timeline(1)
        self.assertEqual(timeline["total_messages"], 1)
        self.assertFalse(timeline["scan_complete"])
        self.assertIn("not a database", notes(timeline))
        status = S.status()
        self.assertIn("数据库读取失败", notes(status))
        self.assertIsNone(status["message_table_count"])
        self.assertEqual(status["indexed_message_table_count"], 1)
        self.assertIsNone(next(d for d in status["dbs"] if d["rel"] == "message/broken.db")["tables"])

    def test_shared_unknown_counts_are_null_not_negative_or_zero(self):
        self.contacts((("wxid_alice", "Alice"),))
        known = S.status()
        self.assertEqual(known["contact_rows"], 1)
        self.assertIsNone(known["session_rows"])
        with patch.object(D, "row_count", side_effect=sqlite3.DatabaseError("original-count-probe")):
            failed = S.status()
        self.assertIsNone(failed["contact_rows"])
        self.assertIn("original-count-probe", notes(failed))
        self.script("contact/contact.db", "DELETE FROM contact")
        self.assertEqual(S.status()["contact_rows"], 0)

    def manifest(self):
        return {"schema_version": 1, "snapshot_id": "synthetic-only",
                "captured_at": "2026-11-05T20:00:00+08:00", "complete": True,
                "consistency": "stable-db-only-verified",
                "files": [{"path": "data.db", "size": 1, "sha256": "0" * 64}]}

    def test_shared_manifest_is_distinct_from_read_time_and_absence_is_legacy(self):
        self.script("data.db", "CREATE TABLE t(n)")
        missing = S.status()
        self.assertIsNone(missing["captured_at"])
        self.assertIn("legacy", notes(missing))
        path = self.root / ".wechat-ro-manifest.json"
        path.write_text(json.dumps(self.manifest()))
        got = S.status()
        self.assertEqual(got["snapshot_time"], got["read_at"])
        self.assertEqual(got["captured_at"], "2026-11-05T20:00:00+08:00")
        self.assertNotEqual(got["captured_at"], got["read_at"])
        self.assertTrue(got["capture_complete"])
        self.assertEqual(got["snapshot_id"], "synthetic-only")

    def test_shared_committed_wal_manifest_preserves_capture_kind(self):
        self.script("data.db", "CREATE TABLE t(n)")
        value = {**self.manifest(), "consistency": "stable-db-wal-committed-verified"}
        (self.root / ".wechat-ro-manifest.json").write_text(json.dumps(value))
        got = S.status()
        self.assertEqual(got["snapshot_id"], value["snapshot_id"])
        self.assertEqual(got["captured_at"], value["captured_at"])
        self.assertTrue(got["capture_complete"])
        self.assertEqual(got["capture_consistency"], value["consistency"])

    def test_shared_unsafe_or_malformed_manifest_never_fabricates_capture(self):
        self.script("data.db", "CREATE TABLE t(n)")
        path = self.root / ".wechat-ro-manifest.json"
        for key, value in (("captured_at", "2026-02-30T00:00:00+08:00"), ("complete", "true"),
                           ("schema_version", True), ("files", [{"path": "../escape", "size": 1, "sha256": "0" * 64}])):
            invalid = self.manifest()
            invalid[key] = value
            path.write_text(json.dumps(invalid))
            got = S.status()
            self.assertIsNone(got["captured_at"])
            self.assertIn("manifest 无效", notes(got))
        path.unlink()
        outside = self.base / "outside-manifest.json"
        outside.write_text(json.dumps(self.manifest()))
        path.symlink_to(outside)
        got = S.status()
        self.assertIsNone(got["snapshot_id"])
        self.assertIn("不安全", notes(got))


    def assert_quality(self, case, result, complete, total=0):
        # Emit actual payloads before assertions so the red run preserves every case.
        print("PY_QUALITY_OBSERVATION " + json.dumps({
            "case": case, "expected_complete": complete, "expected_total": total,
            "result": result,
        }, ensure_ascii=False), flush=True)
        self.assertEqual(result.get("total", result.get("total_messages")), total)
        self.assertEqual(len(result["rows"]), total)
        self.assertTrue(result["notes"])
        if "total_messages" in result:
            for key in ("returned", "offset", "has_more", "truncated"):
                self.assertNotIn(key, result)
        else:
            self.assertEqual(result["returned"], total)
            self.assertEqual(result["offset"], 0)
            self.assertIs(result["has_more"], False)
        self.assertIs(result["scan_complete"], complete)
        self.assertIs(result["total_is_exact"], complete)
        if "truncated" in result:
            self.assertIs(result["truncated"], not complete)
            if not complete:
                self.assertIn("下界", notes(result))
        if complete:
            self.assertNotIn("下界", notes(result))

    def schema_quality_cases(self, method):
        name = "contact" if method == "contacts" else "session"
        table = "contact" if method == "contacts" else "SessionTable"
        for variant in ("missing-db", "no-table", "ambiguous", "corrupt", "empty", "nonempty"):
            with self.subTest(variant=variant):
                child = self.root / (method + "-" + variant)
                child.mkdir()
                rel = name + "/" + name + ".db"
                if variant == "corrupt":
                    target = child / rel
                    target.parent.mkdir()
                    target.write_bytes(b"SYNTHETIC_NOT_SQLITE")
                elif variant == "no-table":
                    self.script(rel, "PRAGMA user_version=1", root=child)
                elif variant != "missing-db":
                    names = [table + "_a", table + "_b"] if variant == "ambiguous" else [table]
                    for candidate in names:
                        self.script(rel, f"CREATE TABLE {D.qi(candidate)}(username TEXT, remark TEXT, last_timestamp INTEGER)", root=child)
                        if variant != "empty":
                            self.script(rel, f"INSERT INTO {D.qi(candidate)} VALUES ('wxid_quality','Quality',0)", root=child)
                with patch.dict(os.environ, {"WECHAT_SNAPSHOT_DIR": str(child)}):
                    result = getattr(S, method)(limit=2)
                healthy = variant in ("empty", "nonempty")
                if not healthy:
                    self.assertIn(name + " 表未解析成功", notes(result))
                if variant == "ambiguous":
                    self.assertIn("歧义", notes(result))
                if variant == "corrupt":
                    self.assertIn("not a database", notes(result))
                self.assert_quality("P12-" + method + "-" + variant, result, healthy,
                                    total=1 if variant == "nonempty" else 0)

    def test_quality_p12_contacts_unknown_and_healthy_controls(self):
        self.schema_quality_cases("contacts")

    def test_quality_p12_sessions_unknown_and_healthy_controls(self):
        self.schema_quality_cases("sessions")

    def test_quality_p12_sql_execution_failures(self):
        self.script("data.db", "CREATE TABLE t(n)")
        (self.root / "corrupt.db").write_bytes(b"SYNTHETIC_NOT_SQLITE")
        for label, database, query in (
            ("missing-table", "data.db", "SELECT * FROM absent_table"),
            ("missing-column", "data.db", "SELECT absent_column FROM t"),
            ("corrupt-db", "corrupt.db", "SELECT name FROM sqlite_master"),
        ):
            with self.subTest(variant=label):
                result = S.sql(database, query)
                self.assertIn("SQL 执行失败", notes(result))
                self.assert_quality("P12-sql-" + label, result, False)

    def message_quality_cases(self, label, complete, session="wxid_alice"):
        with patch.object(S, "datetime", FrozenDateTime):
            results = {
                "messages": S.messages(session),
                "search_messages": S.search_messages("not-present", session=session),
                "timeline": S.timeline(1, session=session),
            }
        for method, result in results.items():
            with self.subTest(method=method):
                if not complete:
                    self.assertIn("消息检索不可用", notes(result))
                self.assert_quality("P13-" + label + "-" + method, result, complete)

    def test_quality_p13_missing_message_source(self):
        self.contacts()
        self.script("session/session.db", "CREATE TABLE SessionTable(username TEXT); INSERT INTO SessionTable VALUES('wxid_alice')")
        self.message_quality_cases("missing-source", False)

    def test_quality_p13_healthy_empty_message_source(self):
        self.contacts()
        self.messages(rows=[])
        self.message_quality_cases("healthy-empty", True)

    def test_quality_p13_known_session_without_matching_table(self):
        self.contacts()
        self.messages(rows=[(EPOCH, "another session's real message")])
        self.message_quality_cases("known-session-no-table", True, session="wxid_bob")

    def member_quality_case(self, variant):
        self.contacts((("123@chatroom", "Room"),))
        if variant != "missing-schema":
            self.script("contact/contact.db", "CREATE TABLE chatroom_members(room_id TEXT, member_username TEXT)")
        if variant == "other-room-only":
            self.script("contact/contact.db", "INSERT INTO chatroom_members VALUES('456@chatroom','wxid_other')")
        result = S.chatroom_members("123@chatroom")
        self.assertIn("群 ID 精确相等", notes(result))
        self.assertIn("候选表", notes(result))
        self.assert_quality("P14-" + variant, result, variant != "missing-schema")

    def test_quality_p14_missing_member_schema(self):
        self.member_quality_case("missing-schema")

    def test_quality_p14_healthy_empty_member_schema(self):
        self.member_quality_case("healthy-empty")

    def test_quality_p14_known_room_without_matching_members(self):
        self.member_quality_case("other-room-only")

    def test_quality_p15_sql_guard(self):
        path = self.contacts()
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        result = S.sql("contact/contact.db", "DELETE FROM contact")
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertIn("wechat_sql 拒绝", notes(result))
        self.assert_quality("P15-sql-guard", result, False)

    def test_quality_p15_sql_database_resolution(self):
        self.contacts()
        result = S.sql("missing.db", "SELECT 1")
        self.assertIn("未知 database", notes(result))
        self.assert_quality("P15-sql-database", result, False)

    def test_quality_p15_unresolved_identities(self):
        self.contacts((("wxid_alice", "Alice"), ("123@chatroom", "Room")))
        self.messages(rows=[])
        self.script("contact/contact.db", "CREATE TABLE chatroom_members(room_id TEXT, member_username TEXT)")
        absent = "No such display label"
        results = {
            "messages": S.messages(absent),
            "search_messages": S.search_messages("token", session=absent),
            "timeline": S.timeline(session=absent),
            "chatroom_members": S.chatroom_members(absent),
        }
        for method, result in results.items():
            with self.subTest(method=method):
                self.assertIn("未找到会话", notes(result))
                self.assert_quality("P15-identity-" + method, result, False)

    def test_quality_p15_empty_search_query(self):
        self.contacts()
        self.messages(rows=[])
        result = S.search_messages("  ")
        self.assertIn("query 不能为空", notes(result))
        self.assert_quality("P15-empty-query", result, False)

    def test_quality_p15_healthy_empty_sql(self):
        self.contacts()
        result = S.sql("contact/contact.db", "SELECT username FROM contact WHERE 0")
        self.assert_quality("P15-healthy-empty-sql", result, True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
