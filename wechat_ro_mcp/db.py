"""Read-only query layer for a decrypted WeChat 4.x db_storage snapshot.

Design goal: *schema tolerance*. WeChat 4.1.x column/table names differ between
builds, so nothing here hard-codes a column. Table and column names are
introspected at runtime and resolved from candidate lists; missing pieces are
reported as notes instead of crashing.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import stat
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from contextlib import contextmanager

# WeChat timestamps are UTC epoch; the operator's zone is Asia/Shanghai (+08,
# no DST). Fixed offset avoids a tzdata dependency.
LOCAL_TZ = timezone(timedelta(hours=8))
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
MAX_ROWS = 500           # hard cap on any tool's returned rows
MAX_TEXT = 1200          # per-cell truncation for context management
SCAN_CAP = 3000          # per-Msg_ table rows scanned by keyword search
MAX_MSG_TABLES = 300     # per-database cap on message tables scanned
MAX_DECODED_BYTES = 16 * 1024 * 1024  # zstd expansion budget, before text truncation

_WRITE_WORDS = re.compile(
    r"\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|"
    r"truncate|reindex|pragma|load_extension|begin|commit|rollback|savepoint|"
    r"end|release|analyze|writable_schema)\b",
    re.I,
)


# --------------------------------------------------------------------------
# Low-level, connection-per-call helpers (thread-safe; FastMCP runs sync tools
# in a worker thread).
# --------------------------------------------------------------------------

def snapshot_file(path: Path, root: Path) -> Path:
    """Validate an ordinary file within the canonical, trusted snapshot root.

    Child symlinks are rejected (including links back into the root). This is
    checked again at open time, not just during discovery. The directory must
    remain owner-controlled: stdlib SQLite cannot atomically open a validated fd.
    """
    if root.resolve(strict=True) != root:
        raise ValueError("snapshot root 已变为符号链接或路径已替换")
    path = path.absolute()
    rel = path.relative_to(root)
    if ".." in rel.parts:
        raise ValueError("snapshot 路径不能包含 ..")
    current = root
    for part in rel.parts:
        current = current / part
        if stat.S_ISLNK(current.lstat().st_mode):
            raise ValueError(f"snapshot 拒绝符号链接: {rel.as_posix()}")
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"snapshot 仅允许普通文件: {rel.as_posix()}")
    return path


def ro_connect(path: Path, *, root: Path | None = None) -> sqlite3.Connection:
    """Open logically read-only SQLite; snapshot WAL/SHM may still be created."""
    if root is not None:
        path = snapshot_file(path, root)
        # SQLite may consult these siblings even for a logically read-only DB.
        for suffix in ("-wal", "-shm", "-journal"):
            sibling = path.with_name(path.name + suffix)
            try:
                sibling.lstat()
            except FileNotFoundError:
                continue
            snapshot_file(sibling, root)
    uri = path.absolute().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


@contextmanager
def ro(path: Path, *, root: Path | None = None):
    """Read-only connection that is always closed. sqlite3.Connection's own
    context manager only commits/rollbacks; it does NOT close the handle."""
    conn = ro_connect(path, root=root)
    try:
        yield conn
    finally:
        conn.close()


def qi(ident: str) -> str:
    """Quote an SQLite identifier (names come from PRAGMA, values never do)."""
    return '"' + str(ident).replace('"', '""') + '"'


def _file_version(path: Path) -> tuple | None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return None
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode)


def list_databases(root: Path, notes: list[str] | None = None) -> list[dict[str, Any]]:
    notes = notes if notes is not None else []
    out: list[dict[str, Any]] = []

    def walk(directory: Path) -> None:
        try:
            children = sorted(directory.iterdir())
        except OSError as exc:
            notes.append(f"snapshot 目录读取失败: {directory.relative_to(root)}: {exc}")
            return
        for p in children:
            rel = p.relative_to(root).as_posix()
            try:
                st = p.lstat()
                if stat.S_ISLNK(st.st_mode):
                    notes.append(f"snapshot 跳过符号链接: {rel}")
                elif stat.S_ISDIR(st.st_mode):
                    walk(p)
                elif p.suffix == ".db" and stat.S_ISREG(st.st_mode):
                    snapshot_file(p, root)
                    out.append({
                        "rel": rel, "path": p, "size": st.st_size,
                        "mtime": datetime.fromtimestamp(st.st_mtime, LOCAL_TZ).isoformat(),
                        "version": tuple(_file_version(p.with_name(p.name + suffix))
                                         for suffix in ("", "-wal", "-shm", "-journal")),
                    })
            except (OSError, ValueError) as exc:
                notes.append(f"snapshot 跳过不可读文件 {rel}: {exc}")

    walk(root)
    return out


def tables(conn: sqlite3.Connection) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()]


def columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({qi(table)})").fetchall()]


def row_count(conn: sqlite3.Connection, table: str) -> int:
    """Count exactly; let the caller retain the original database error."""
    return int(conn.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()[0])


def fetch(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def pick_col(cols: list[str], candidates: list[str | int]) -> str | None:
    """Resolve a logical field from ordered candidate names; int = positional
    fallback (im-mcp documents e.g. 'type/0' compatibility)."""
    low = {c.lower(): c for c in cols}
    for cand in candidates:
        if isinstance(cand, int):
            if 0 <= cand < len(cols):
                return cols[cand]
        elif cand.lower() in low:
            return low[cand.lower()]
    return None


def resolve_table(
    conn: sqlite3.Connection,
    name_candidates: list[str],
    colmap: dict[str, list[str | int]],
    require: list[str] | tuple[str, ...] = (),
    notes: list[str] | None = None,
) -> dict[str, Any] | None:
    """Require usable columns, then rank exact names > substrings > schema.

    Case-insensitive aliases count once. Equal best scores are ambiguous, not
    an invitation to silently choose a table by lexicographic order.
    """
    candidates = {n.lower() for n in name_candidates}
    scored: list[tuple[int, str, dict[str, str], list[str]]] = []
    for t in tables(conn):
        low = t.lower()
        tier = 2 if low in candidates else int(any(n in low for n in candidates))
        cols = columns(conn, t)
        resolved = {k: c for k, cands in colmap.items() if (c := pick_col(cols, cands))}
        if any(k not in resolved for k in require):
            continue
        scored.append((tier * (len(colmap) + 1) + len(resolved), t, resolved, cols))
    scored.sort(key=lambda x: (-x[0], x[1]))
    if not scored:
        return None
    score, t, resolved, cols = scored[0]
    tied = [item[1] for item in scored if item[0] == score]
    if len(tied) > 1:
        if notes is not None:
            notes.append("候选表歧义，拒绝自动选择: " + ", ".join(tied))
        return None
    return {"table": t, "cols": resolved, "all_cols": cols, "score": score}


# --------------------------------------------------------------------------
# Value normalization
# --------------------------------------------------------------------------

def decode_content(value: Any) -> str:
    """WeChat 4.x message_content may be plain text/XML, zstd-compressed bytes,
    or a BLOB. Return best-effort UTF-8 text, never raise."""
    if value is None:
        return ""
    raw: bytes
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
    elif isinstance(value, str):
        raw = value.encode("utf-8", "replace")
    else:
        return str(value)
    if raw[:4] == ZSTD_MAGIC:
        try:
            import zstandard as zstd
            if zstd.frame_content_size(raw) > MAX_DECODED_BYTES:
                raise ValueError(f"解压内容超过 {MAX_DECODED_BYTES} bytes 上限")
            raw = zstd.ZstdDecompressor().decompress(
                raw, max_output_size=MAX_DECODED_BYTES, allow_extra_data=False)
        except Exception as exc:
            return f"[zstd 解压失败: {exc}]"
    return raw.decode("utf-8", "replace")


def norm_ts(value: Any) -> tuple[int | None, str | None]:
    """Return (epoch_seconds, ISO-8601 local) from s / ms / µs epoch numbers."""
    if value is None:
        return None, None
    try:
        n = int(value)
    except (TypeError, ValueError, OverflowError):
        return None, None
    if n <= 0:
        return None, None
    if n > 10 ** 14:      # microseconds
        n //= 1_000_000
    elif n > 10 ** 11:    # milliseconds
        n //= 1000
    try:
        iso = datetime.fromtimestamp(n, LOCAL_TZ).isoformat()
    except (OSError, OverflowError, ValueError):
        return None, None
    return n, iso


def md5_hex(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


_TYPE_LABELS = {
    1: "text", 3: "image", 34: "voice", 43: "video", 47: "sticker",
    49: "appmsg/link/file", 50: "voip", 10000: "system", 10002: "system",
    51: "video_status", 42: "card", 48: "location", 37: "friend_request",
}


def type_label(value: Any) -> str:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return "unknown"
    low = n & 0xFFFFFFFF
    label = _TYPE_LABELS.get(low, f"type_{low}")
    hi = (n >> 32) & 0xFFFFFFFF
    if hi:
        label += f" (subtype {hi})"
    return label


def clean(value: Any, n: int = MAX_TEXT) -> Any:
    """Decode and truncate once, at the final output boundary, for text or BLOB."""
    if isinstance(value, (str, bytes, bytearray, memoryview)):
        return truncate(decode_content(value), n)
    return value


def truncate(s: str, n: int = MAX_TEXT) -> str:
    if s is None:
        return ""
    return s if len(s) <= n else s[:n] + f"…[截断, 共{len(s)}字符]"


def guard_select(sql: str) -> tuple[str, str | None]:
    """Validate an escape-hatch query. Returns (clean_sql, error)."""
    s = sql.strip()
    while s.endswith(";"):
        s = s[:-1].rstrip()
    if not s:
        return "", "SQL 为空"
    if ";" in s:
        return "", "只允许单条 SELECT 语句（检测到额外的分号）"
    if "?" in s:
        return "", "不支持带 ? 占位符的查询，请把值直接写在 SQL 里"
    s2 = re.sub(r"^\s*(?:--[^\n]*\n|/\*.*?\*/\s*)*", "", s, flags=re.S | re.I)
    tokens = s2.split()
    if not tokens or tokens[0].upper() not in ("SELECT", "WITH"):
        return "", "只允许 SELECT 或 WITH ... SELECT 只读查询"
    # Strip string literals before scanning for write keywords so a search for
    # the word "create" inside a LIKE pattern is not rejected.
    no_strings = re.sub(r"'(?:[^']|'')*'", "''", s2)
    m = _WRITE_WORDS.search(no_strings)
    if m:
        return "", f"检测到禁止的写操作关键字: {m.group(0)}"
    return s2, None


# --------------------------------------------------------------------------
# Snapshot: resolved layout, cached across tool calls
# --------------------------------------------------------------------------

_CACHE: dict[tuple, "Snapshot"] = {}
_CACHE_LOCK = threading.Lock()


def get_snapshot(root: Path) -> "Snapshot":
    root = root.resolve()
    notes: list[str] = []
    dbs = list_databases(root, notes) if root.is_dir() else []
    sig = (str(root), tuple((d["rel"], d["version"]) for d in dbs), tuple(notes))
    with _CACHE_LOCK:
        snap = _CACHE.get(sig)
        if snap is None:
            snap = Snapshot(root, dbs, notes)
            _CACHE.clear()          # keep only the current snapshot
            _CACHE[sig] = snap
        return snap


def capture_metadata(root: Path) -> tuple[dict[str, Any], list[str]]:
    """Read producer metadata without inventing a capture time for legacy roots."""
    unknown = {"captured_at": None, "snapshot_id": None,
               "capture_complete": None, "capture_consistency": None}
    path = root / ".wechat-ro-manifest.json"
    try:
        path.lstat()
    except FileNotFoundError:
        return unknown, ["未找到快照 manifest：采集时间/完整性未知（legacy 快照仍可查询）"]
    try:
        path = snapshot_file(path, root)
        if path.stat().st_size > 1024 * 1024:
            raise ValueError("manifest 超过 1 MiB")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
            raise ValueError("schema_version 必须为 1")
        if not isinstance(data.get("snapshot_id"), str) or not data["snapshot_id"].strip():
            raise ValueError("snapshot_id 必须为非空字符串")
        captured = data.get("captured_at")
        if not isinstance(captured, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?"
            r"(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", captured
        ):
            raise ValueError("captured_at 必须为带时区的有效 ISO 时间")
        datetime.fromisoformat(captured.replace("Z", "+00:00"))
        if type(data.get("complete")) is not bool:
            raise ValueError("complete 必须为 boolean")
        if data.get("consistency") not in ("stable-db-only-verified", "stable-db-wal-committed-verified"):
            raise ValueError("未知 consistency")
        files = data.get("files")
        if not isinstance(files, list):
            raise ValueError("files 必须为数组")
        seen: set[str] = set()
        for item in files:
            if not isinstance(item, dict):
                raise ValueError("files 项必须为对象")
            name = item.get("path")
            if (not isinstance(name, str) or not name or "\\" in name
                    or Path(name).is_absolute() or any(p in ("", ".", "..") for p in name.split("/"))
                    or name in seen):
                raise ValueError("files.path 必须为唯一安全相对路径")
            seen.add(name)
            if type(item.get("size")) is not int or item["size"] < 0:
                raise ValueError("files.size 必须为非负整数")
            if not isinstance(item.get("sha256"), str) or not re.fullmatch(r"[0-9a-fA-F]{64}", item["sha256"]):
                raise ValueError("files.sha256 必须为 64 位十六进制")
        notes = [] if data["complete"] else ["manifest 声明采集未完成；结果仅供部分快照参考"]
        return {"captured_at": captured, "snapshot_id": data["snapshot_id"],
                "capture_complete": data["complete"], "capture_consistency": data["consistency"]}, notes
    except (OSError, ValueError, TypeError) as exc:
        return unknown, [f"snapshot manifest 无效或不安全，采集元数据未知: {exc}"]


class Snapshot:
    def __init__(self, root: Path, dbs: list[dict[str, Any]], notes: list[str] | None = None):
        self.root = root
        self.dbs = dbs
        self.by_rel = {d["rel"]: d for d in dbs}
        self.notes = list(notes or [])
        self.message_tables_truncated = False
        self.message_table_counts: dict[str, dict[str, int]] = {}
        self.message_index: list[dict[str, Any]] | None = None
        self.index_lock = threading.Lock()
        self.contact_db = self._find("contact/contact.db") or self._find_suffix("contact/contact.db")
        self.session_db = self._find("session/session.db") or self._find_suffix("session/session.db")
        self.message_dbs = [d["path"] for d in dbs
                            if d["rel"].startswith("message/") and d["rel"].endswith(".db")]
        if not self.contact_db:
            self.notes.append("未找到 contact/contact.db：联系人显示名可能退化为 wxid")
        if not self.session_db:
            self.notes.append("未找到 session/session.db：会话列表可能为空")
        if not self.message_dbs:
            self.notes.append("未找到 message/*.db：消息检索不可用")

    def open(self, path: Path):
        return ro(path, root=self.root)

    def _find(self, rel: str) -> Path | None:
        d = self.by_rel.get(rel)
        return d["path"] if d else None

    def _find_suffix(self, suffix: str) -> Path | None:
        hits = [d["path"] for d in self.dbs if d["rel"].endswith(suffix)]
        return hits[0] if len(hits) == 1 else None

    def resolve_db(self, database: str) -> tuple[Path | None, str | None]:
        """Validate a user-supplied database name against the discovered set.
        Accepts 'contact/contact.db', 'contact/contact', or a unique suffix."""
        if not database:
            return None, "请指定 database（用 wechat_status 查看可用值）"
        d = database.strip().replace("\\", "/").lstrip("/")
        for key in (d, d + ".db"):
            if key in self.by_rel:
                return self.by_rel[key]["path"], None
        hits = [x for x in self.dbs if x["rel"] == d or x["rel"].endswith("/" + d)
                or x["rel"].endswith("/" + d + ".db") or x["rel"] == d + ".db"]
        if len(hits) == 1:
            return hits[0]["path"], None
        if len(hits) > 1:
            return None, f"database 不唯一，匹配到 {len(hits)} 个，请写完整相对路径"
        return None, f"未知 database {d!r}；用 wechat_status 查看可用值"

    # -- contact / session resolution --------------------------------------

    CONTACT_COLMAP = {
        "uname": ["username", "user_name", "wxid", "usr_name", "UserName", 0],
        "alias": ["alias", "Alias", "alias_name"],
        "remark": ["remark", "Remark", "remark_name", "conRemark", "con_remark"],
        "nick": ["nick_name", "nickname", "NickName", "nick"],
        "ctype": ["local_type", "type", "contact_type", "LocalType"],
    }
    SESSION_COLMAP = {
        "uname": ["username", "user_name", "session_username", "wxid", "strUsrName", 0],
        "summary": ["summary", "last_msg_preview", "last_message", "digest", "content"],
        "ts": ["last_timestamp", "last_time", "lastTime", "sort_timestamp", "timestamp", "update_time"],
        "unread": ["unread_count", "unreadCount", "unread", "UnreadCount"],
    }

    def _resolve(self, path: Path | None, names: list[str], colmap: dict) -> dict[str, Any] | None:
        if path is None:
            return None
        try:
            with self.open(path) as conn:
                return resolve_table(conn, names, colmap, require=["uname"], notes=self.notes)
        except (OSError, ValueError, sqlite3.Error) as exc:
            note = f"{path.name} 表解析失败: {exc}"
            if note not in self.notes:
                self.notes.append(note)
            return None

    def contact_table(self) -> dict[str, Any] | None:
        return self._resolve(self.contact_db, ["contact", "friend", "user", "Contact", "WCContact"],
                             self.CONTACT_COLMAP)

    def session_table(self) -> dict[str, Any] | None:
        return self._resolve(self.session_db, ["SessionTable", "session", "sessions", "Session"],
                             self.SESSION_COLMAP)

    def display_map(self) -> dict[str, str]:
        """username -> human-readable name (remark > nick > alias > username)."""
        out: dict[str, str] = {}
        ct = self.contact_table()
        if ct:
            c = ct["cols"]
            with self.open(self.contact_db) as conn:
                for r in fetch(conn, f"SELECT * FROM {qi(ct['table'])}"):
                    u = r.get(c["uname"])
                    if not u:
                        continue
                    name = (r.get(c.get("remark", "")) or ""
                            or r.get(c.get("nick", "")) or ""
                            or r.get(c.get("alias", "")) or str(u))
                    out[str(u)] = str(name)
        st = self.session_table()
        if st:
            c = st["cols"]
            with self.open(self.session_db) as conn:
                for r in fetch(conn, f"SELECT * FROM {qi(st['table'])}"):
                    u = r.get(c["uname"])
                    if u and str(u) not in out:
                        out[str(u)] = str(u)
        return out

    # -- message db resolution ---------------------------------------------

    MSG_COLMAP = {
        "local_id": ["local_id", "localId", "msgLocalId", "id"],
        "sender": ["real_sender_id", "sender_id", "sender", "real_sender", "sender_username"],
        "ltype": ["local_type", "localType", "msg_type", "type", 3],
        "time": ["create_time", "createTime", "createTime", "time", "timestamp", 4],
        "content": ["message_content", "messageContent", "content", "msg_content", "text", 5],
        "source": ["source", "source_name", 6],
    }

    def msg_tables(self, conn: sqlite3.Connection) -> list[tuple[str, dict[str, str]]]:
        found: list[tuple[str, dict[str, str]]] = []
        discovered = 0
        for t in tables(conn):
            if not re.match(r"^Msg_", t, re.I):
                continue
            cols = columns(conn, t)
            resolved = {k: v for k, v in
                        ((k, pick_col(cols, cands)) for k, cands in self.MSG_COLMAP.items())
                        if v}
            if "content" in resolved:
                discovered += 1
                if len(found) < MAX_MSG_TABLES:
                    found.append((t, resolved))
        db_path = str(conn.execute("PRAGMA database_list").fetchone()[2])
        label = Path(db_path).relative_to(self.root).as_posix()
        self.message_table_counts[label] = {"discovered": discovered, "indexed": len(found)}
        if discovered > len(found):
            self.message_tables_truncated = True
            note = (f"{label}: Msg_ 表扫描上限 {MAX_MSG_TABLES}，发现 {discovered} 张，"
                    f"仅索引 {len(found)} 张；结果可能不完整")
            if note not in self.notes:
                self.notes.append(note)
        return found

    def name2id(self, conn: sqlite3.Connection) -> dict[int, str]:
        for t in tables(conn):
            if not re.match(r"^name2id$", t, re.I):
                continue
            cols = columns(conn, t)
            ucol = pick_col(cols, ["user_name", "username", "userName", "name", 1])
            if not ucol:
                continue
            try:
                return {int(r[0]): str(r[1]) for r in conn.execute(
                    f"SELECT rowid, {qi(ucol)} FROM {qi(t)}").fetchall()}
            except sqlite3.Error:
                return {}
        return {}
