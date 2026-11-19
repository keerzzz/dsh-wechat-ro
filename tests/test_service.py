"""Direct unit tests of the 8 read-only service functions against a synthetic fixture.

Run with WECHAT_SNAPSHOT_DIR pointing at tests/fixture_snapshot. Uses no MCP
and no real WeChat data. Exits non-zero on the first failed assertion.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from unittest.mock import patch

from wechat_ro_mcp import db as D
from wechat_ro_mcp import service as S


class FixtureClock(datetime):
    @classmethod
    def now(cls, tz=None):
        fixed = datetime(2026, 11, 6, 12, 0, tzinfo=D.LOCAL_TZ)
        return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

_CHECKS = 0


def ck(cond, label):
    global _CHECKS
    _CHECKS += 1
    if not cond:
        print("FAIL: " + str(label), file=sys.stderr)
        raise SystemExit(1)


def notes_join(res):
    return " ".join(str(n) for n in res.get("notes", []))


def main():
    for name in ("WECHAT_FIXTURE_DIR", "WECHAT_SNAPSHOT_DIR", "TMPDIR"):
        ck(bool(os.environ.get(name)), name + " must explicitly isolate synthetic tests")
    # 1. status -------------------------------------------------------------
    st = S.status()
    ck(st["ok"] is True, "status.ok")
    ck(st["db_count"] == 3, "status.db_count=3")
    ck(st["contact_table"] == "contact", "status.contact_table")
    ck(st["session_table"] == "SessionTable", "status.session_table")
    ck(st["contact_rows"] == 5, "status.contact_rows=5")
    ck(st["session_rows"] == 4, "status.session_rows=4")
    ck(st["message_db_count"] == 1, "status.message_db_count=1")
    ck(st["message_table_count"] == 3, "status.message_table_count=3")
    print("  status OK")

    # 2. contacts -----------------------------------------------------------
    ct = S.contacts()
    ck(ct["total"] == 5, "contacts.total=5")
    by_u = {r["username"]: r for r in ct["rows"]}
    ck(by_u["wxid_alice"]["display_name"] == "爱丽丝", "remark beats nick")
    ck(by_u["wxid_carol"]["display_name"] == "Carol", "empty remark falls back to nick")
    ck(S.contacts(query="bob")["total"] == 1, "contacts query=bob -> 1")
    print("  contacts OK")

    # 3. sessions -----------------------------------------------------------
    se = S.sessions()
    ck(se["total"] == 4, "sessions.total=4")
    ck(se["rows"][0]["username"] == "wxid_alice", "sessions newest first = wxid_alice")
    ck(str(se["rows"][0]["last_time"]).endswith("+08:00"), "last_time has +08:00")
    ck(any(r["is_chatroom"] for r in se["rows"]), "sessions has is_chatroom group")
    print("  sessions OK")

    # 4. messages -----------------------------------------------------------
    ms = S.messages("wxid_alice")
    ck(ms["total"] == 6, "messages(alice).total=6")
    ck(ms["rows"][0]["local_id"] == 5, "newest local_id=5")
    ck(ms["rows"][0]["type"] == "appmsg/link/file", "type label for 49")
    ck("预算表内容" in ms["rows"][0]["content"], "zstd content decompressed")
    senders = {r["sender"] for r in ms["rows"]}
    ck("wxid_alice" in senders and "wxid_self" in senders, "Name2Id rowid->username resolves both senders")
    ck(S.messages("wxid_alice", contains="预算表")["total"] == 3, "contains 预算表 -> 3")
    ck(S.messages("wxid_alice", after="2026-11-01")["total"] == 5, "after 2026-11-01 -> 5")
    ck(S.messages("wxid_alice", offset=1)["rows"][0]["local_id"] == 4, "offset=1 -> local_id=4")
    ck(S.messages("项目讨论群")["total"] == 4, "resolve by display name -> 4")
    ck(S.messages("不存在的人")["total"] == 0 and S.messages("不存在的人")["notes"], "unknown session -> 0 + notes")
    ck("匹配到多个候选" in notes_join(S.messages("wxid_")), "ambiguous wxid_ -> multiple candidates note")
    print("  messages OK")

    # 5. search_messages ----------------------------------------------------
    sr = S.search_messages("预算表")
    ck(sr["total"] == 3, "search(预算表).total=3")
    ck(sr["scanned_tables"] == 3, "search scanned_tables=3")
    ck(S.search_messages("部署", session="项目讨论群")["total"] == 2, "search scoped to group -> 2")
    ck("query 不能为空" in notes_join(S.search_messages("")), "empty query rejected")
    print("  search_messages OK")

    # 6. timeline -----------------------------------------------------------
    with patch.object(S, "datetime", FixtureClock):
        tl = S.timeline(30)
    ck(tl["total_messages"] == 12, "timeline.total_messages=12")
    dates = {r["date"] for r in tl["rows"]}
    ck(dates == {"2026-10-20", "2026-11-03", "2026-11-04"}, "timeline dates")
    ck(tl["top_sessions"][0]["session"] == "爱丽丝", "timeline top session = 爱丽丝")
    print("  timeline OK")

    # 7. chatroom_members ---------------------------------------------------
    cm = S.chatroom_members("12345678@chatroom")
    ck(cm["total"] == 3, "chatroom_members.total=3")
    ck(any(r["display_name"] == "爱丽丝" for r in cm["rows"]), "member display name joined from contact.db")
    print("  chatroom_members OK")

    # 8. sql (guarded escape hatch) ----------------------------------------
    ok = S.sql("session/session.db", "SELECT username, summary FROM SessionTable")
    ck(ok["total"] == 4, "sql valid SELECT -> 4 rows")
    for bad in ["DELETE FROM SessionTable", "SELECT 1; DROP TABLE x",
                "SELECT * FROM t WHERE a = ?", "ATTACH 'x' AS y"]:
        r = S.sql("session/session.db", bad)
        ck(r["total"] == 0 and "拒绝" in notes_join(r), "sql rejects: " + bad)
    ck("未知 database" in notes_join(S.sql("nope", "SELECT 1")), "unknown database -> note")
    like = S.sql("session/session.db", "SELECT username FROM SessionTable WHERE summary LIKE '%create%'")
    ck(like["total"] >= 0 and "拒绝" not in notes_join(like), "LIKE %create% not blocked")
    print("  sql OK")

    print("SERVICE_OK — " + str(_CHECKS) + " assertions passed")


if __name__ == "__main__":
    main()
