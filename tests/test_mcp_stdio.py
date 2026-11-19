"""End-to-end test: drive all 8 tools over a real MCP stdio handshake.

Spawns 'python -m wechat_ro_mcp' as a child process, initializes a
ClientSession, verifies tool discovery/annotations, then calls every tool and
checks structuredContent. No real WeChat data is touched: WECHAT_SNAPSHOT_DIR
points at the synthetic fixture (set by scripts/selftest.sh).
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]
SNAP = os.environ["WECHAT_SNAPSHOT_DIR"]

EXPECTED_TOOLS = {
    "wechat_status", "wechat_contacts", "wechat_sessions", "wechat_messages",
    "wechat_search_messages", "wechat_timeline", "wechat_chatroom_members",
    "wechat_sql",
}

# tool name -> (arguments, key to check inside structuredContent, expected value)
CALLS = [
    ("wechat_status", {}, "db_count", 3),
    ("wechat_contacts", {}, "total", 5),
    ("wechat_sessions", {}, "total", 4),
    ("wechat_messages", {"session": "wxid_alice"}, "total", 6),
    ("wechat_search_messages", {"query": "预算表"}, "total", 3),
    ("wechat_timeline", {"days": 30}, "days", 30),
    ("wechat_chatroom_members", {"room": "12345678@chatroom"}, "total", 3),
    ("wechat_sql", {"database": "session/session.db",
                    "query": "SELECT username, summary FROM SessionTable"}, "total", 4),
]


async def main():
    for name in ("WECHAT_FIXTURE_DIR", "WECHAT_SNAPSHOT_DIR", "TMPDIR"):
        assert os.environ.get(name), name + " must explicitly isolate this test"
    env = os.environ.copy()
    env["WECHAT_SNAPSHOT_DIR"] = SNAP
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "wechat_ro_mcp"],
        env=env,
        cwd=str(ROOT),
    )
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            init = await s.initialize()
            assert init.serverInfo.name == "wechat-ro", "server name"
            print("  INIT OK wechat-ro")

            tools = (await s.list_tools()).tools
            names = {t.name for t in tools}
            assert names == EXPECTED_TOOLS, "tool set mismatch: " + repr(names)
            for t in tools:
                assert t.outputSchema is not None, t.name + " missing outputSchema"
                assert t.annotations is not None and t.annotations.readOnlyHint is True,                     t.name + " missing readOnlyHint"
            print("  DISCOVERY OK 8 tools, all readOnlyHint + outputSchema")

            for name, args, key, expected in CALLS:
                res = await s.call_tool(name, args)
                assert res.isError is not True, name + " isError"
                sc = res.structuredContent or {}
                assert sc.get(key) == expected,                     name + " " + key + " expected " + str(expected) + " got " + repr(sc.get(key))
                if name == "wechat_timeline":
                    # Wall-clock-independent wire check; exact fixed-window
                    # counts and future exclusions are tested with a frozen clock.
                    assert isinstance(sc["total_messages"], int) and 0 <= sc["total_messages"] <= 12
                    assert sum(row["messages"] for row in sc["rows"]) == sc["total_messages"]
                    assert sc["scan_complete"] is True and sc["total_is_exact"] is True
                print("  CALL OK " + name + " -> " + key + "=" + str(expected))

            # SQL guard must survive the MCP wire too
            bad = await s.call_tool("wechat_sql", {
                "database": "session/session.db", "query": "DROP TABLE x"})
            assert (bad.structuredContent or {}).get("total") == 0, "sql guard over MCP"
            print("  SQL GUARD OK over stdio")

            # PY-05: preserve lower-bound flags across the actual SDK wire.
            limited = (await s.call_tool("wechat_sql", {
                "database": "session/session.db", "query": "SELECT username FROM SessionTable",
                "limit": 1})).structuredContent or {}
            assert limited["returned"] == 1 and limited["total"] == 2
            assert limited["has_more"] is True and limited["truncated"] is True
            assert limited["total_is_exact"] is False
            assert any("下界" in n for n in limited["notes"])
            tail = (await s.call_tool("wechat_sql", {
                "database": "session/session.db", "query": "SELECT username FROM SessionTable",
                "limit": 4})).structuredContent or {}
            assert tail["total"] == 4 and tail["total_is_exact"] is True
            assert tail["has_more"] is False and tail["truncated"] is False
            print("  SQL PAGE FLAGS OK lower bound + exact tail")

            # PY-07: BLOB decoding must be bounded once, not silently unbounded.
            text = "😀" * 5000
            blob = (await s.call_tool("wechat_sql", {
                "database": "session/session.db", "query": "SELECT CAST('" + text + "' AS BLOB) AS value"
            })).structuredContent or {}
            assert blob["rows"][0]["value"] == text[:1200] + "…[截断, 共5000字符]"
            print("  BLOB LENGTH OK original 5000 Unicode codepoints")

            # Invalid bounds are tool errors, not successful unfiltered reads.
            for invalid in ("not-a-date", "2026-02-30", str(10 ** 100)):
                rejected = await s.call_tool("wechat_messages", {"session": "wxid_alice", "after": invalid})
                assert rejected.isError is True, "invalid date must use MCP isError"
                assert any("无效日期" in getattr(c, "text", "") for c in rejected.content)
            recovered = await s.call_tool("wechat_status", {})
            assert recovered.isError is not True
            metadata = recovered.structuredContent or {}
            assert metadata["read_at"] == metadata["snapshot_time"]
            assert metadata["captured_at"] is None and metadata["capture_complete"] is None
            print("  DATE ERROR CHANNEL OK; stdio session remains usable")
            print("  LEGACY SNAPSHOT METADATA OK read time is not capture time")

    print("MCP_STDIO_OK — 8 tools + SQL/page/BLOB/date/metadata regressions over real MCP stdio")


if __name__ == "__main__":
    asyncio.run(main())
