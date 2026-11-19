"""Create a synthetic decrypted WeChat 4.x-style snapshot.

Mimics the real layout:
  contact/contact.db, session/session.db, message/message_0.db
with WeChat 4.0 column names, Msg_<md5(username)> tables, a Name2Id table,
and one zstd-compressed message_content (WeChat 4.x stores long content
zstd-compressed). Uses the installed zstandard package if available, otherwise
generates a plain-text-only variant.

This is a TEST FIXTURE. No real WeChat data is read or modified.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(os.environ.get("WECHAT_FIXTURE_DIR") or os.environ.get("FIXTURE_DIR") or str(Path(__file__).resolve().parent / "fixture_snapshot"))
TZ = timezone(timedelta(hours=8))

try:
    import zstandard as zstd
    _ZSTD = True
except ImportError:
    _ZSTD = False


def md5(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


def ts(s: str) -> int:
    return int(datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp())


def compress(text: str) -> bytes:
    if not _ZSTD:
        return text.encode()
    return zstd.ZstdCompressor(level=3).compress(text.encode())


def ensure(p: Path) -> sqlite3.Connection:
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        p.unlink()
    return sqlite3.connect(str(p))


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)

    # ---- contact/contact.db ------------------------------------------------
    c = ensure(ROOT / "contact/contact.db")
    c.executescript("""
      CREATE TABLE contact(
        username TEXT PRIMARY KEY, local_type INTEGER, alias TEXT,
        remark TEXT, nick_name TEXT, pinyin TEXT);
      CREATE TABLE chatroom_member(
        chatroom_name TEXT, member_username TEXT, display_name TEXT);
    """)
    c.executemany("INSERT INTO contact VALUES(?,?,?,?,?,?)", [
        ("wxid_alice", 1, "alice_p", "爱丽丝", "Alice", "aisi"),
        ("wxid_bob", 1, "", "鲍勃", "Bob", "baobo"),
        ("wxid_carol", 1, "carol_x", "", "Carol", "ka"),
        ("12345678@chatroom", 2, "", "项目讨论群", "", "xm"),
        ("wxid_official", 3, "", "", "微信支付", "zf"),
    ])
    c.executemany("INSERT INTO chatroom_member VALUES(?,?,?)", [
        ("12345678@chatroom", "wxid_alice", "爱丽丝(群昵称)"),
        ("12345678@chatroom", "wxid_bob", "鲍勃"),
        ("12345678@chatroom", "wxid_carol", "Carol"),
    ])
    c.commit(); c.close()

    # ---- session/session.db -----------------------------------------------
    s = ensure(ROOT / "session/session.db")
    s.executescript("""
      CREATE TABLE SessionTable(
        username TEXT PRIMARY KEY, summary TEXT, last_timestamp INTEGER,
        unread_count INTEGER);
    """)
    s.executemany("INSERT INTO SessionTable VALUES(?,?,?,?)", [
        ("wxid_alice", "明天开会记得带材料", ts("2026-11-04T18:22:00"), 2),
        ("12345678@chatroom", "Carol: 部署完成了", ts("2026-11-04T17:05:00"), 9),
        ("wxid_bob", "周末打球吗", ts("2026-11-03T09:10:00"), 0),
        ("wxid_carol", "", ts("2026-10-28T21:00:00"), 0),
    ])
    s.commit(); s.close()

    # ---- message/message_0.db --------------------------------------------
    m = ensure(ROOT / "message/message_0.db")
    m.executescript("""
      CREATE TABLE Name2Id(user_name TEXT);
      CREATE TABLE DeleteInfo(local_id INTEGER);
    """)
    # Name2Id: rowid 1..N map to usernames (real_sender_id references rowid)
    senders = ["wxid_alice", "wxid_bob", "wxid_carol", "wxid_self"]
    m.executemany("INSERT INTO Name2Id(user_name) VALUES(?)",
                  [(u,) for u in senders])

    msg_ddl = """
      CREATE TABLE "{}"(
        local_id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER, local_type INTEGER, sort_seq INTEGER,
        real_sender_id INTEGER, create_time INTEGER, status INTEGER,
        upload_status INTEGER, download_status INTEGER, server_seq INTEGER,
        origin_source INTEGER, source TEXT, message_content,
        compress_content BLOB, packed_info_data BLOB);
    """
    def mtable(u: str) -> str:
        return "Msg_" + md5(u)

    m.execute(msg_ddl.format(mtable("wxid_alice")))
    m.execute(msg_ddl.format(mtable("12345678@chatroom")))
    m.execute(msg_ddl.format(mtable("wxid_bob")))

    def add(tbl: str, sender_id: int, typ: int, iso: str, content,
            source: str = "") -> None:
        raw = content.encode() if isinstance(content, str) else content
        m.execute(
            f'INSERT INTO "{tbl}"(server_id,local_type,sort_seq,real_sender_id,'
            "create_time,status,upload_status,download_status,server_seq,"
            "origin_source,source,message_content,compress_content,packed_info_data) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (0, typ, 0, sender_id, ts(iso), 3, 0, 0, 0, 0, source, raw, None, None),
        )

    alice, room, bob = (mtable(x) for x in
                        ("wxid_alice", "12345678@chatroom", "wxid_bob"))
    add(alice, 1, 1, "2026-11-04T18:20:00", "明天开会记得把周报带来")
    add(alice, 4, 1, "2026-11-04T18:21:00", "好的，我会带上材料")
    add(alice, 1, 1, "2026-11-04T18:22:00", "还有预算表也别忘了")
    add(alice, 1, 3, "2026-11-04T18:23:00", "<img>photo</img>")
    add(alice, 1, 49, "2026-11-04T18:24:00",
        compress("这是一条很长的链接分享：" + ("预算表内容 " * 120)))
    add(alice, 4, 1, "2026-10-20T08:00:00", "上周的旧消息：预算表初稿")

    add(room, 2, 1, "2026-11-04T16:00:00", "部署脚本我改好了", "wxid_bob")
    add(room, 3, 1, "2026-11-04T17:05:00", "部署完成了", "wxid_carol")
    add(room, 1, 1, "2026-11-04T17:10:00", "收到，辛苦大家", "wxid_alice")
    add(room, 2, 10000, "2026-11-04T17:11:00", "Carol 加入了群聊")

    add(bob, 2, 1, "2026-11-03T09:10:00", "周末打球吗")
    add(bob, 4, 1, "2026-11-03T09:12:00", "可以，老时间")

    m.commit(); m.close()

    # A decoy file that must NOT be treated as a database
    (ROOT / "README.txt").write_text("synthetic fixture, not real WeChat data" + chr(10))
    print(f"FIXTURE_OK root={ROOT} zstd={_ZSTD}")
    for p in sorted(ROOT.rglob("*")):
        if p.is_file():
            print("  ", p.relative_to(ROOT).as_posix(), p.stat().st_size)


if __name__ == "__main__":
    sys.exit(main())
