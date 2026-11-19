"""WeChat Read-Only MCP Server (stdio).

Exposes a decrypted WeChat 4.x SQLite snapshot as eight read-only MCP tools.
Run directly::

    WECHAT_SNAPSHOT_DIR=/path/to/decrypted python -m wechat_ro_mcp.server

All tools are strictly read-only: SQLite is opened with mode=ro and
PRAGMA query_only=ON. The original WeChat databases and the running WeChat
process are never touched.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from . import service

_LOG = logging.getLogger("wechat_ro_mcp")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,          # stdout is reserved for the MCP stdio protocol
)

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)

mcp = FastMCP(
    name="wechat-ro",
    instructions=(
        "Read-only access to a decrypted local WeChat 4.x chat database snapshot "
        "(contacts, sessions, messages, keyword search, activity timeline, "
        "group members). Data is a static snapshot, not a live feed. All tools "
        "are strictly read-only. Use wechat_status first to see which databases "
        "are available, then wechat_sessions / wechat_contacts to resolve a "
        "username before calling wechat_messages. Timestamps are Asia/Shanghai "
        "(+08:00) ISO-8601. Never use these tools to send messages."
    ),
)


def _safe(fn, *args, **kwargs) -> dict[str, Any]:
    """Validation errors use FastMCP's tool-error channel; sessions stay alive."""
    try:
        return fn(*args, **kwargs)
    except ValueError:
        raise
    except Exception as exc:                       # pragma: no cover - defensive
        _LOG.exception("tool %s failed", getattr(fn, "__name__", "?"))
        return {"error": f"{type(exc).__name__}: {exc}",
                "notes": ["工具执行异常；详见 MCP server stderr 日志"]}


@mcp.tool(
    name="wechat_status",
    title="WeChat snapshot status",
    description=(
        "List the decrypted WeChat databases available in the snapshot and which "
        "contact/session/message tables were resolved. Call this FIRST: an empty "
        "db_count means the user has not produced a decrypted snapshot yet."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_status() -> dict[str, Any]:
    return _safe(service.status)


@mcp.tool(
    name="wechat_contacts",
    title="Search WeChat contacts",
    description=(
        "List contacts from the decrypted contact.db, with display_name "
        "(remark > nick_name > alias > username). Filter with query "
        "(case-insensitive substring over wxid/alias/remark/nick). "
        "Returns username, which is the key for other tools."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_contacts(query: str = "", limit: int = 50) -> dict[str, Any]:
    return _safe(service.contacts, query=query, limit=limit)


@mcp.tool(
    name="wechat_content",
    title="Search WeChat Moments, favorites and mini-program cards",
    description="Read locally cached Moments (source=moments), favorites or mini-program cards (source=miniprogram) from the plugin content index, with original references. Links are data and are not fetched.",
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_content(source: str = "moments", query: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
    return _safe(service.content, source=source, query=query, limit=limit, offset=offset)


@mcp.tool(
    name="wechat_sessions",
    title="List recent WeChat conversations",
    description=(
        "List recent conversations (chats and groups) sorted by last message "
        "time, with display names resolved from contact.db. Use the returned "
        "username (wxid for a person, xxx@chatroom for a group) as the "
        "session argument of wechat_messages."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_sessions(limit: int = 50, query: str = "") -> dict[str, Any]:
    return _safe(service.sessions, limit=limit, query=query)


@mcp.tool(
    name="wechat_messages",
    title="Read WeChat messages from a conversation",
    description=(
        "Read messages of ONE WeChat conversation from the decrypted snapshot, "
        "newest first. session accepts a username (wxid / xxx@chatroom) or "
        "a contact display name. Supports keyword filter (contains), time "
        "window (after / before as ISO-8601 date, e.g. 2026-10-01, or "
        "epoch seconds/ms/us); invalid or inverted bounds are tool errors. "
        "Supports pagination (limit, offset). Message content "
        "may be zstd-compressed; it is decompressed automatically. Note: each "
        "Msg_ table is scanned at most 3000 rows, so very old messages may be "
        "out of reach."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_messages(
    session: str,
    limit: int = 50,
    offset: int = 0,
    contains: str = "",
    before: str | None = None,
    after: str | None = None,
) -> dict[str, Any]:
    return _safe(service.messages, session=session, limit=limit, offset=offset,
                 contains=contains, before=before, after=after)


@mcp.tool(
    name="wechat_search_messages",
    title="Search WeChat messages by keyword",
    description=(
        "Full-text keyword search across ALL message tables of the decrypted "
        "snapshot (case-insensitive substring, matches inside decompressed "
        "content). Optionally restrict to one session. Returns messages with "
        "session/session_name, sender, time and a content excerpt. Each message "
        "table is scanned at most 3000 rows."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_search_messages(
    query: str,
    limit: int = 50,
    session: str | None = None,
) -> dict[str, Any]:
    return _safe(service.search_messages, query=query, limit=limit, session=session)


@mcp.tool(
    name="wechat_timeline",
    title="WeChat message activity by day",
    description=(
        "Aggregate WeChat message counts per day over the last days "
        "(default 30), plus the 5 busiest hours and top 10 most active "
        "conversations. Optionally restrict to one session. Useful for "
        "'how active was I / how many messages last week' questions. Counts "
        "are bounded by the 3000-row-per-table scan cap."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_timeline(days: int = 30, session: str | None = None) -> dict[str, Any]:
    return _safe(service.timeline, days=days, session=session)


@mcp.tool(
    name="wechat_chatroom_members",
    title="List members of a WeChat group chat",
    description=(
        "Best-effort list of members for a group chat (xxx@chatroom). Looks for "
        "a chatroom/member table inside contact.db and joins display names. "
        "Returns a note describing available candidate tables if WeChat 4.x "
        "stored membership elsewhere (e.g. inside message XML blobs)."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_chatroom_members(room: str, limit: int = 100) -> dict[str, Any]:
    return _safe(service.chatroom_members, room=room, limit=limit)


@mcp.tool(
    name="wechat_sql",
    title="Run a guarded read-only SQL query",
    description=(
        "Escape hatch: run ONE SELECT (or WITH ... SELECT) against one "
        "decrypted database, e.g. database='message/message_0.db'. Hardened: "
        "mode=ro + query_only=ON, rejects any write keyword, rejects multiple "
        "statements and ?-placeholders, and wraps the query in an outer "
        "LIMIT+1 probe. total is an observed lower bound unless total_is_exact=true; "
        "has_more means an extra row was observed. Values must be inlined in the SQL. Use wechat_status to list "
        "valid database names. Prefer the higher-level tools for normal use."
    ),
    annotations=READ_ONLY,
    structured_output=True,
)
def wechat_sql(database: str, query: str, limit: int = 100) -> dict[str, Any]:
    return _safe(service.sql, database=database, query=query, limit=limit)


def main() -> None:
    _LOG.info("wechat-ro MCP server starting (stdio)")
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
