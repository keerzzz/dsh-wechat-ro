"""Pure read-only query functions over a decrypted WeChat 4.x snapshot.

No MCP dependency here: everything is a plain function returning a dict, so it
can be unit-tested directly against a synthetic fixture. server.py wraps these
in FastMCP tools.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from . import db as D
from .config import snapshot_root

_SCAN_NOTE = f"每个消息表仅扫描最近 {D.SCAN_CAP} 行"


def _snap() -> D.Snapshot:
    return D.get_snapshot(snapshot_root())


def content(source: str = "moments", query: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """Read the plugin's normalized collection index, preserving its references."""
    if source not in ("moments", "favorites", "miniprogram", "voice", "image", "video") or not isinstance(query, str):
        raise ValueError("无效的内容来源或关键词")
    if type(limit) is not int or not 1 <= limit <= D.MAX_ROWS or type(offset) is not int or not 0 <= offset <= 10000:
        raise ValueError("无效的分页范围")
    snap = _snap()
    path = snap.root / "content/content.db"
    if not path.exists():
        return {"rows": [], "available": False, "notes": ["请通过插件导入新的微信内容来源"]}
    with D.ro(path, root=snap.root) as conn:
        where = "kind=? AND instr(lower(coalesce(title,'') || char(10) || coalesce(content,'') || char(10) || coalesce(url,'')),lower(?))>0"
        total = conn.execute("SELECT count(*) FROM records WHERE " + where, (source, query)).fetchone()[0]
        rows = D.fetch(conn, "SELECT record_ref,kind,talker,ts,title,content,url FROM records WHERE " + where + " ORDER BY ts DESC,record_ref LIMIT ? OFFSET ?", (source, query, limit, offset))
    for row in rows:
        row["localTime"] = D.norm_ts(row["ts"])[1]
        row["citation"] = {"recordRef": row.pop("record_ref")}
    return {"available": True, "source": source, "total": total, "returned": len(rows), "rows": rows, "has_more": offset + len(rows) < total, "untrusted": True, "timezone": "Asia/Shanghai"}


def _notes(snap: D.Snapshot) -> list[str]:
    if snap.dbs:
        return list(snap.notes)
    return list(snap.notes) + [
        f"快照目录 {snap.root} 下没有解密的 .db 文件。",
        "服务仅查询已有解密快照，不会自动采集、提权或读取正在使用的微信数据库。",
        "如需自行运行 scripts/decrypt_snapshot.sh，先明确选择 WECHAT_DB_ROOT，手动静止源后设置 "
        "WECHAT_SOURCE_QUIESCENT=1；缺失密钥缓存仅在显式 WCDB_ALLOW_CAPTURE=1 时允许捕获，"
        "替换旧缓存还需 WCDB_RECAPTURE=1。",
        f"设置环境变量 {__import__('wechat_ro_mcp.config', fromlist=['ENV_VAR']).ENV_VAR} "
        "指向产物根下的 decrypted/ 目录；以当前执行身份生成的 0700/0600 产物需要单独授权读取，"
        "不要为此以 root 身份运行 DSH。",
    ]


def _result(rows: list[dict], total: int, notes: list[str],
            limit: int | None = None, offset: int = 0, *,
            scan_complete: bool = True, total_is_exact: bool | None = None,
            content_limit: int = D.MAX_TEXT) -> dict[str, Any]:
    lim = limit if limit is not None else D.MAX_ROWS
    page = rows[:lim]
    clean_rows = [{k: D.clean(v, content_limit if k == "content" else D.MAX_TEXT)
                   for k, v in r.items()} for r in page]
    has_more = offset + len(clean_rows) < int(total)
    exact = scan_complete if total_is_exact is None else total_is_exact
    if not exact:
        notes = notes + ["total 为已观察到的匹配行数下界，不是精确总数；未扫描部分可能有遗漏"]
    return {
        "total": int(total),
        "returned": len(clean_rows),
        "offset": offset,
        "truncated": has_more or not scan_complete,
        "has_more": has_more,
        "scan_complete": scan_complete,
        "total_is_exact": exact,
        "rows": clean_rows,
        "notes": list(dict.fromkeys(str(n) for n in notes)),
    }


# --------------------------------------------------------------------------
# 1. Status / discovery
# --------------------------------------------------------------------------

def status() -> dict[str, Any]:
    snap = _snap()
    read_at = datetime.now(tz=D.LOCAL_TZ).isoformat()
    metadata, notes = D.capture_metadata(snap.root)
    dbs: list[dict[str, Any]] = []
    for d in snap.dbs:
        n = None
        try:
            with snap.open(d["path"]) as c:
                n = len(D.tables(c))
        except (OSError, ValueError, D.sqlite3.Error) as exc:
            notes.append(f"{d['rel']}: 数据库读取失败: {exc}")
        dbs.append({"rel": d["rel"], "size": d["size"],
                    "mtime": d["mtime"], "tables": n})
    ct, st = snap.contact_table(), snap.session_table()
    def count(path, table):
        if not path or not table:
            return None
        try:
            with snap.open(path) as c:
                return D.row_count(c, table["table"])
        except (OSError, ValueError, D.sqlite3.Error) as exc:
            notes.append(f"{path.name}/{table['table']} 行数读取失败: {exc}")
            return None

    contact_rows = count(snap.contact_db, ct)
    session_rows = count(snap.session_db, st)
    msg_tables = 0
    message_count_known = True
    for p in snap.message_dbs:
        try:
            with snap.open(p) as c:
                msg_tables += len(snap.msg_tables(c))
        except (OSError, ValueError, D.sqlite3.Error) as exc:
            message_count_known = False
            notes.append(f"{p.relative_to(snap.root)}: 数据库读取失败: {exc}")
    return {
        "ok": bool(snap.dbs),
        "root": str(snap.root),
        "snapshot_time": read_at,
        "read_at": read_at,
        **metadata,
        "db_count": len(snap.dbs),
        "dbs": dbs,
        "contact_table": ct["table"] if ct else None,
        "session_table": st["table"] if st else None,
        "contact_rows": contact_rows,
        "session_rows": session_rows,
        "message_db_count": len(snap.message_dbs),
        "message_table_count": (sum(v["discovered"] for v in snap.message_table_counts.values())
                                if message_count_known else None),
        "indexed_message_table_count": msg_tables,
        "message_table_counts": dict(snap.message_table_counts),
        "message_table_cap": D.MAX_MSG_TABLES,
        "scan_complete": (not snap.message_tables_truncated and message_count_known
                          and all(d["tables"] is not None for d in dbs)),
        "notes": list(dict.fromkeys(_notes(snap) + notes)),
    }


# --------------------------------------------------------------------------
# 2. Contacts
# --------------------------------------------------------------------------

def contacts(query: str = "", limit: int = 50) -> dict[str, Any]:
    snap = _snap()
    limit = max(1, min(int(limit), D.MAX_ROWS))
    ct = snap.contact_table()
    if not ct:
        return _result([], 0, _notes(snap) + ["contact 表未解析成功"], limit=limit, scan_complete=False)
    c = ct["cols"]
    q = (query or "").strip().lower()
    rows: list[dict[str, Any]] = []
    with snap.open(snap.contact_db) as conn:
        for r in D.fetch(conn, f"SELECT * FROM {D.qi(ct['table'])}"):
            u = r.get(c["uname"])
            if not u:
                continue
            u = str(u)
            alias = str(r.get(c["alias"]) or "") if c.get("alias") else ""
            remark = str(r.get(c["remark"]) or "") if c.get("remark") else ""
            nick = str(r.get(c["nick"]) or "") if c.get("nick") else ""
            disp = remark or nick or alias or u
            if q and q not in " ".join([u, alias, remark, nick, disp]).lower():
                continue
            rows.append({
                "username": u,
                "display_name": disp,
                "alias": alias,
                "remark": remark,
                "nick_name": nick,
                "type": r.get(c["ctype"]) if c.get("ctype") else None,
            })
    rows.sort(key=lambda x: (x["display_name"] or "", x["username"]))
    return _result(rows, len(rows), _notes(snap), limit=limit)


# --------------------------------------------------------------------------
# 3. Sessions
# --------------------------------------------------------------------------

def sessions(limit: int = 50, query: str = "") -> dict[str, Any]:
    snap = _snap()
    limit = max(1, min(int(limit), D.MAX_ROWS))
    st = snap.session_table()
    if not st:
        return _result([], 0, _notes(snap) + ["session 表未解析成功"], limit=limit, scan_complete=False)
    disp = snap.display_map()
    c = st["cols"]
    q = (query or "").strip().lower()
    rows: list[dict[str, Any]] = []
    with snap.open(snap.session_db) as conn:
        for r in D.fetch(conn, f"SELECT * FROM {D.qi(st['table'])}"):
            u = r.get(c["uname"])
            if not u:
                continue
            u = str(u)
            name = disp.get(u, u)
            if q and q not in (u + " " + name).lower():
                continue
            epoch, iso = D.norm_ts(r.get(c["ts"]) if c.get("ts") else None)
            rows.append({
                "username": u,
                "display_name": name,
                "summary": r.get(c["summary"]) if c.get("summary") else None,
                "last_time": iso,
                "last_epoch": epoch,
                "unread": r.get(c["unread"]) if c.get("unread") else None,
                "is_chatroom": u.endswith("@chatroom"),
            })
    rows.sort(key=lambda x: (x["last_epoch"] or 0), reverse=True)
    return _result(rows, len(rows), _notes(snap), limit=limit)


# --------------------------------------------------------------------------
# Message-table index (Msg_<md5(username)>)
# --------------------------------------------------------------------------

def _message_index(snap: D.Snapshot) -> list[dict[str, Any]]:
    with snap.index_lock:
        if snap.message_index is not None:
            return snap.message_index
    hash2user = {D.md5_hex(u): u for u in snap.display_map()}
    out: list[dict[str, Any]] = []
    for p in snap.message_dbs:
        try:
            with snap.open(p) as conn:
                n2i = snap.name2id(conn)
                for t, cols in snap.msg_tables(conn):
                    suffix = t.split("_", 1)[1] if "_" in t else ""
                    out.append({"db": p, "table": t, "cols": cols,
                                "username": hash2user.get(suffix.lower()),
                                "name2id": n2i})
        except Exception as exc:
            out.append({"db": p, "error": str(exc)})
    with snap.index_lock:
        snap.message_index = out
    return out


def _resolve_username(snap: D.Snapshot, text: str) -> tuple[str | None, list[str]]:
    disp = snap.display_map()
    t = (text or "").strip()
    if not t:
        return None, ["请指定会话：传 wxid/群 id，或用 wechat_sessions 查到的 display_name"]
    if t in disp or re.fullmatch(r"wxid_[A-Za-z0-9_-]+|[^@\s]+@chatroom", t):
        return t, []
    exact = [u for u, n in disp.items() if n and n.lower() == t.lower()]
    if len(exact) == 1:
        return exact[0], []
    fuzzy = [u for u, n in disp.items()
             if t.lower() in (u + " " + (n or "")).lower()]
    if len(fuzzy) == 1:
        return fuzzy[0], []
    if len(fuzzy) > 1:
        return None, [f"会话名 {text!r} 匹配到多个候选: " +
                      ", ".join(sorted(fuzzy)[:10]) +
                      "；请传完整 username（用 wechat_sessions 查看）"]
    return None, [f"未找到会话 {text!r}；用 wechat_sessions 查看可用 username，"
                  "或直接传 wxid / 群 id"]


def _parse_bound(s: str | None) -> int | None:
    if s is None or str(s).strip() == "":
        return None
    value = str(s).strip()
    try:
        if re.fullmatch(r"-?\d+", value):
            n = int(value)
            epoch = D.norm_ts(n)[0] if n > 0 else n
            if epoch is None:
                raise ValueError("epoch out of range")
            datetime.fromtimestamp(epoch, D.LOCAL_TZ)
            return epoch
        if not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?"
            r"(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?", value
        ):
            raise ValueError("not an ISO date/time")
        dt = datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=D.LOCAL_TZ)
        return int(dt.timestamp())
    except (ValueError, OverflowError, OSError) as exc:
        raise ValueError(f"无效日期 {value!r}；请用有效 ISO 日期/时间或 epoch 秒/毫秒/微秒") from exc


def _session_entries(entries: list[dict], username: str) -> list[dict]:
    target = "msg_" + D.md5_hex(username)
    return [dict(e, username=username) if "table" in e else e for e in entries
            if e.get("error") or e.get("username") == username
            or e.get("table", "").lower() == target]


def _read_msgs(snap: D.Snapshot, entries: list[dict], *, contains: str = "",
               before: int | None = None, after: int | None = None
               ) -> tuple[list[dict], list[str], bool]:
    disp = snap.display_map()
    notes: list[str] = []
    complete = bool(snap.message_dbs) and not snap.message_tables_truncated
    rows: list[dict[str, Any]] = []
    for e in entries:
        if "table" not in e:
            if e.get("error"):
                notes.append(f"{e['db'].name} 读取失败: {e['error']}")
                complete = False
            continue
        c, n2i = e["cols"], (e.get("name2id") or {})
        tc = c.get("time")
        sql = f"SELECT * FROM {D.qi(e['table'])}"
        if tc:
            sql += f" ORDER BY wechat_epoch({D.qi(tc)}) DESC"
            if c.get("local_id"):
                sql += f", {D.qi(c['local_id'])} DESC"
        sql += f" LIMIT {D.SCAN_CAP + 1}"
        try:
            with snap.open(e["db"]) as conn:
                conn.create_function("wechat_epoch", 1, lambda v: D.norm_ts(v)[0], deterministic=True)
                raw = D.fetch(conn, sql)
        except (OSError, ValueError, D.sqlite3.Error) as exc:
            notes.append(f"{e['db'].name}/{e['table']} 读取失败: {exc}")
            complete = False
            continue
        if len(raw) > D.SCAN_CAP:
            complete = False
            notes.append(f"{e['table']} 达到扫描上限 {D.SCAN_CAP} 行，结果可能不完整")
        for r in raw[:D.SCAN_CAP]:
            epoch, iso = D.norm_ts(r.get(c["time"]) if c.get("time") else None)
            if after is not None and (epoch is None or epoch < after):
                continue
            if before is not None and (epoch is None or epoch > before):
                continue
            content = D.decode_content(r.get(c["content"]))
            if contains and contains.lower() not in content.lower():
                continue
            sender_raw = r.get(c["sender"]) if c.get("sender") else None
            sender: str | None = None
            if sender_raw is not None:
                try:
                    sender = n2i.get(int(sender_raw))
                except (TypeError, ValueError):
                    sender = None
                if sender is None:
                    sender = str(sender_raw)
            sname = disp.get(sender, sender) if sender else None
            rows.append({
                "local_id": r.get(c["local_id"]) if c.get("local_id") else None,
                "create_time": iso,
                "create_epoch": epoch,
                "sender": sender,
                "sender_name": str(sname) if sname else None,
                "type": D.type_label(r.get(c["ltype"]) if c.get("ltype") else None),
                "content": content,
                "source": r.get(c["source"]) if c.get("source") else None,
                "session": e.get("username"),
                "database": e["db"].name,
                "table": e["table"],
            })
    rows.sort(key=lambda x: (x.get("create_epoch") or 0), reverse=True)
    return rows, notes + _notes(snap), complete


# --------------------------------------------------------------------------
# 4. Messages for one session
# --------------------------------------------------------------------------

def messages(session: str, limit: int = 50, offset: int = 0,
             contains: str = "", before: str | None = None,
             after: str | None = None) -> dict[str, Any]:
    snap = _snap()
    limit = max(1, min(int(limit), D.MAX_ROWS))
    offset = max(0, int(offset))
    before_epoch, after_epoch = _parse_bound(before), _parse_bound(after)
    if before_epoch is not None and after_epoch is not None and after_epoch > before_epoch:
        raise ValueError("after 不能晚于 before")
    u, errs = _resolve_username(snap, session)
    if errs:
        return _result([], 0, _notes(snap) + errs, limit=limit, offset=offset, scan_complete=False)
    idx = _message_index(snap)
    entries = _session_entries(idx, u)
    rows, extra, complete = _read_msgs(snap, entries, contains=contains,
                                     before=before_epoch, after=after_epoch)
    if not any("table" in e for e in entries):
        extra.append(f"未找到会话 {u} 对应的 Msg_<hash> 表；没有跨会话回退。")
    return _result(rows[offset:offset + limit], len(rows), extra + [_SCAN_NOTE],
                   limit=limit, offset=offset, scan_complete=complete)


# --------------------------------------------------------------------------
# 5. Keyword search
# --------------------------------------------------------------------------

def search_messages(query: str, limit: int = 50,
                    session: str | None = None) -> dict[str, Any]:
    snap = _snap()
    limit = max(1, min(int(limit), D.MAX_ROWS))
    notes = _notes(snap)
    q = (query or "").strip()
    if not q:
        return _result([], 0, notes + ["query 不能为空"], limit=limit, scan_complete=False)
    u = None
    if session:
        u, errs = _resolve_username(snap, session)
        if errs:
            return _result([], 0, notes + errs, limit=limit, scan_complete=False)
    entries = _message_index(snap)
    if u:
        entries = _session_entries(entries, u)
    rows, extra, complete = _read_msgs(snap, entries, contains=q)
    disp = snap.display_map()
    for r in rows:
        s = r.get("session")
        r["session_name"] = disp.get(s, s) if s else None
    res = _result(rows, len(rows), notes + extra, limit=limit,
                  scan_complete=complete, content_limit=300)
    res["scanned_tables"] = len([e for e in entries if "table" in e])
    return res


# --------------------------------------------------------------------------
# 6. Activity timeline
# --------------------------------------------------------------------------

def timeline(days: int = 30, session: str | None = None) -> dict[str, Any]:
    snap = _snap()
    days = max(1, min(int(days), 3650))
    notes = _notes(snap)
    now = datetime.now(tz=D.LOCAL_TZ)
    cutoff = int((now - timedelta(days=days)).timestamp())
    upper = int(now.timestamp())
    u = None
    if session:
        u, errs = _resolve_username(snap, session)
        if errs:
            return {"days": days, "total_messages": 0, "rows": [],
                    "busiest_hours": [], "top_sessions": [],
                    "scan_complete": False, "total_is_exact": False,
                    "notes": notes + errs}
    disp = snap.display_map()
    per_day: dict[str, int] = defaultdict(int)
    per_hour: dict[str, int] = defaultdict(int)
    per_session: dict[str, int] = defaultdict(int)
    entries = _message_index(snap)
    if u:
        entries = _session_entries(entries, u)
    rows, extra, complete = _read_msgs(snap, entries, after=cutoff, before=upper)
    notes += extra
    for r in rows:
        epoch = r["create_epoch"]
        dt = datetime.fromtimestamp(epoch, D.LOCAL_TZ)
        per_day[dt.date().isoformat()] += 1
        per_hour[f"{dt.hour:02d}:00"] += 1
        if r.get("session"):
            per_session[r["session"]] += 1
    if not complete:
        notes.append("total_messages 为已扫描范围内计数下界，不是精确总数")
    return {
        "days": days,
        "total_messages": len(rows),
        "scan_complete": complete,
        "total_is_exact": complete,
        "rows": [{"date": d, "messages": n} for d, n in sorted(per_day.items())],
        "busiest_hours": [{"hour": h, "messages": n} for h, n in
                          sorted(per_hour.items(), key=lambda x: -x[1])[:5]],
        "top_sessions": [{"session": D.clean(disp.get(s, s)), "username": s, "messages": n}
                         for s, n in sorted(per_session.items(), key=lambda x: (-x[1], x[0]))[:10]],
        "notes": list(dict.fromkeys(notes)),
    }


# --------------------------------------------------------------------------
# 7. Group-chat members (schema-tolerant)
# --------------------------------------------------------------------------

def chatroom_members(room: str, limit: int = 100) -> dict[str, Any]:
    snap = _snap()
    limit = max(1, min(int(limit), D.MAX_ROWS))
    notes = _notes(snap) + ["仅计入群 ID 精确相等的成员记录；空值/缺列/其他群不做归属推断"]
    if not snap.contact_db:
        return _result([], 0, notes + ["无 contact 数据库"], limit=limit, scan_complete=False)
    u, errs = _resolve_username(snap, room)
    if errs:
        return _result([], 0, notes + errs, limit=limit, scan_complete=False)
    disp = snap.display_map()
    rows: list[dict[str, Any]] = []
    cand: list[str] = []
    complete = True
    with snap.open(snap.contact_db) as conn:
        cand = [t for t in D.tables(conn)
                if re.search(r"chatroom|chat_room|member", t, re.I)]
        complete = bool(cand)
        for t in cand:
            cols = D.columns(conn, t)
            roomc = D.pick_col(cols, ["chatroom_username", "chatroom_name", "chat_room_name",
                                      "room_name", "room", "room_id", "chatroom_id"])
            memc = D.pick_col(cols, ["member_username", "user_name", "username",
                                     "member_name", "user"])
            dc = D.pick_col(cols, ["display_name", "nick_name", "remark", "name", 2])
            if not memc or not roomc or memc == roomc:
                complete = False
                notes.append(f"{t} 缺少独立可识别的群 ID/成员列；拒绝按列位置猜测归属")
                continue
            raw = D.fetch(conn, f"SELECT * FROM {D.qi(t)} WHERE {D.qi(roomc)} = ? COLLATE BINARY "
                          f"LIMIT {D.SCAN_CAP + 1}", (u,))
            if len(raw) > D.SCAN_CAP:
                complete = False
                notes.append(f"{t} 群成员达到扫描上限 {D.SCAN_CAP}，结果可能不完整")
            for r in raw[:D.SCAN_CAP]:
                rv = r.get(roomc)
                if not isinstance(rv, str) or not rv or rv != u:
                    continue
                m = r.get(memc)
                if not m:
                    continue
                m = str(m)
                fallback = str(r.get(dc) or m) if dc else m
                rows.append({
                    "chatroom": rv,
                    "member": m,
                    "display_name": disp.get(m, fallback),
                    "source_table": t,
                })
            if rows:
                break
    if not rows:
        return _result([], 0, notes + [
            f"未在 contact.db 找到 {u} 的群成员表；候选表: " +
            (", ".join(cand) if cand else "无")], limit=limit, scan_complete=complete)
    return _result(rows, len(rows), notes + _notes(snap), limit=limit, scan_complete=complete)


# --------------------------------------------------------------------------
# 8. Escape hatch: guarded read-only SQL
# --------------------------------------------------------------------------

def sql(database: str, query: str, limit: int = 100) -> dict[str, Any]:
    snap = _snap()
    limit = max(1, min(int(limit), D.MAX_ROWS))
    notes = _notes(snap)
    clean_sql, err = D.guard_select(query)
    if err:
        return _result([], 0, notes + [f"wechat_sql 拒绝: {err}"], limit=limit, scan_complete=False)
    path, derr = snap.resolve_db(database)
    if derr:
        return _result([], 0, notes + [derr], limit=limit, scan_complete=False)
    try:
        with snap.open(path) as conn:
            cur = conn.execute(f"SELECT * FROM ({clean_sql}) AS _q LIMIT ?", (limit + 1,))
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        has_extra = len(rows) > limit
        return _result(rows, len(rows), notes + [
            f"database={database}；只读 SELECT，最多返回 limit={limit} 行；额外观察 1 行用于判断分页"],
            limit=limit, total_is_exact=not has_extra)
    except Exception as exc:
        return _result([], 0, notes + [f"SQL 执行失败: {exc}"], limit=limit, scan_complete=False)
