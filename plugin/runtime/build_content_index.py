#!/usr/bin/env python3
"""Normalize locally captured Moments, favorites and mini-program cards.

Source records remain in their original snapshot. The derived index stores text,
origin and stable references so both desktop queries and the bot use the same data.
No links are fetched and no model is used to interpret XML.
"""
from __future__ import annotations

import ctypes
import ctypes.util
from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import xml.etree.ElementTree as ET

MAX_XML_BYTES = 4 * 1024 * 1024
VERSION = 2
_zstd_lib = None


def decode(value) -> str:
    global _zstd_lib
    if isinstance(value, str):
        return value
    if not isinstance(value, bytes):
        return ""
    if value.startswith(bytes.fromhex("28b52ffd")):
        if _zstd_lib is None:
            _zstd_lib = ctypes.CDLL(ctypes.util.find_library("zstd"))
            _zstd_lib.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
            _zstd_lib.ZSTD_decompress.restype = ctypes.c_size_t
            _zstd_lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
            _zstd_lib.ZSTD_isError.restype = ctypes.c_uint
        lib = _zstd_lib
        output = ctypes.create_string_buffer(MAX_XML_BYTES)
        size = lib.ZSTD_decompress(output, MAX_XML_BYTES, value, len(value))
        if lib.ZSTD_isError(size):
            raise ValueError("content-zstd-invalid-or-too-large")
        value = ctypes.string_at(output, size)
    return value.decode("utf-8")


def xml(value) -> ET.Element:
    text = decode(value)
    if len(text.encode()) > MAX_XML_BYTES or re.search(r"<!\s*(DOCTYPE|ENTITY)", text, re.I):
        raise ValueError("content-xml-invalid-or-too-large")
    start = text.find("<")  # Group messages can prefix the XML with a sender ID.
    if start < 0:
        raise ValueError("content-xml-missing")
    # WeChat can encode legacy control characters as numeric XML entities.
    # Drop only XML-1.0-forbidden codepoints, preserving the surrounding text.
    def numeric(match):
        value = int(match[1][1:], 16) if match[1].lower().startswith('x') else int(match[1])
        return match[0] if value in (9, 10, 13) or 32 <= value <= 0xD7FF or 0xE000 <= value <= 0xFFFD or 0x10000 <= value <= 0x10FFFF else ''
    text = re.sub(r'&#(x[0-9a-fA-F]+|[0-9]+);', numeric, text)
    return ET.fromstring(text[start:])


def field(doc, path: str) -> str:
    return (doc.findtext(path) or "").strip() if doc is not None else ""


def mini_card(doc) -> dict | None:
    app = doc if doc.tag == "appmsg" else doc.find(".//appmsg")
    weapp = doc.find(".//weappinfo")
    if weapp is None:
        weapp = doc.find(".//weappInfo")
    if weapp is None or not (field(weapp, "appid") or field(weapp, "username")):
        return None
    title = field(app, "title") if app is not None else ""
    content = field(app, "des") if app is not None else ""
    return {"title": title or field(weapp, "nickname"), "content": content,
            "url": field(app, "url") if app is not None else "",
            "appId": field(weapp, "appid"), "pagePath": field(weapp, "pagepath")}


def open_source(root: Path, rel: str):
    return sqlite3.connect((root / rel).as_uri() + "?mode=ro&immutable=1", uri=True)


def build_index(root: Path, previous: Path | None = None, reused: set[str] | None = None, account_ref: str | None = None, media_root: Path | None = None) -> dict:
    import json
    folder = root / "content"
    folder.mkdir(mode=0o700)
    path = folder / "content.db"
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    counts = {}; skipped = 0; reused = reused or set()
    with sqlite3.connect(path) as out:
        out.execute("CREATE TABLE records(record_ref TEXT PRIMARY KEY, kind TEXT NOT NULL, talker TEXT NOT NULL, ts INTEGER, title TEXT, content TEXT, url TEXT, origin_db TEXT, origin_table TEXT, origin_id TEXT, metadata TEXT)")
        out.execute("CREATE INDEX records_kind_time ON records(kind,ts DESC)")
        out.execute("CREATE INDEX records_talker_time ON records(talker,ts DESC)")
        if previous is not None and (previous / 'content/content.db').exists() and reused:
            with open_source(previous, 'content/content.db') as old:
                placeholders = ','.join('?' for _ in reused)
                rows = old.execute("SELECT * FROM records WHERE kind NOT IN ('voice','image','video') AND origin_db IN (" + placeholders + ')', sorted(reused))
                for row in rows:
                    out.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)', row)
                    counts[row[1]] = counts.get(row[1], 0) + 1
        else:
            reused = set()
        def add(kind, talker, ts, title, content, url, rel, table, ident, metadata=None, ref=None):
            ref = ref or hashlib.sha256(f"{rel}/{table}/{ident}/{kind}".encode()).hexdigest()[:32]
            out.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)", (ref, kind, talker or "", ts, title, content, url, rel, table, str(ident), json.dumps(metadata or {}, ensure_ascii=False)))
            counts[kind] = counts.get(kind, 0) + 1
        rel = "sns/sns.db"
        if (root / rel).exists() and rel not in reused:
            with open_source(root, rel) as db:
                for tid, user, raw in db.execute("SELECT tid,user_name,content FROM SnsTimeLine"):
                    try:
                        doc = xml(raw); obj = doc.find("TimelineObject")
                        ts = int(field(obj, "createTime"))
                        add("moments", user, ts, "", field(obj, "contentDesc"), field(obj, "ContentObject/contentUrl"), rel, "SnsTimeLine", tid,
                            {"mediaCount": len(obj.findall("ContentObject/mediaList/media"))})
                    except (ET.ParseError, ValueError, UnicodeError):
                        skipped += 1
        rel = "favorite/favorite.db"
        if (root / rel).exists() and rel not in reused:
            with open_source(root, rel) as db:
                for ident, ts, user, raw in db.execute("SELECT local_id,update_time,fromusr,content FROM fav_db_item"):
                    try:
                        doc = xml(raw)
                        titles = [e.text.strip() for e in doc.findall(".//datatitle") if e.text]
                        descriptions = [e.text.strip() for e in doc.findall(".//datadesc") if e.text]
                        content = "\n".join(filter(None, [field(doc, "desc"), *descriptions]))
                        url = field(doc, ".//weburl") or field(doc, ".//stream_weburl") or field(doc, ".//url")
                        add("favorites", user, ts or None, " · ".join(titles), content, url, rel, "fav_db_item", ident)
                        card = mini_card(doc)
                        if card:
                            add("miniprogram", user, ts or None, card["title"], card["content"], card["url"], rel, "fav_db_item", ident, card)
                    except (ET.ParseError, ValueError, UnicodeError):
                        skipped += 1
        for source in sorted((root / "message").glob("*.db")):
            rel = source.relative_to(root).as_posix()
            if rel in reused or not re.fullmatch(r"message/(?:biz_)?message_\d+\.db", rel):
                continue
            with open_source(root, rel) as db:
                users = {hashlib.md5(name.encode()).hexdigest(): name for (name,) in db.execute("SELECT user_name FROM Name2Id")}
                for (table,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'Msg_*'"):
                    if not re.fullmatch(r"Msg_[0-9a-fA-F]{32}", table):
                        continue
                    for ident, ts, raw in db.execute(f'SELECT local_id,create_time,message_content FROM "{table}" WHERE (local_type >> 32) IN (33,36) OR local_type=49'):
                        try:
                            card = mini_card(xml(raw))
                            if card:
                                add("miniprogram", users.get(table[4:].lower(), ""), ts, card["title"], card["content"], card["url"], rel, table, ident, card)
                        except (ET.ParseError, ValueError, UnicodeError):
                            skipped += 1
        out.execute("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)")
        if account_ref and re.fullmatch('[a-f0-9]{12}', account_ref) and (root / 'message/media_0.db').exists():
            cache = Path.home() / '.local/share/dsh-wechat-ro/content-history' / account_ref
            if cache.exists():
                with open_source(root, 'message/media_0.db') as media:
                    for item in sorted(cache.glob('*.json')):
                        data = json.loads(item.read_text())
                        if data.get('sourceKind') in ('image', 'video'):
                            continue
                        rows = media.execute('SELECT v.voice_data FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id WHERE n.user_name=? AND v.local_id=? AND v.create_time=? LIMIT 2', (data['talker'], data['localId'], data['ts'])).fetchall()
                        if len(rows) != 1 or hashlib.sha256(rows[0][0]).hexdigest() != data['sha256']:
                            continue
                        ident = data['talker'] + '/' + data['localId'] + '/' + str(data['ts'])
                        add('voice', data['talker'], data['ts'], '语音转写', data['text'], '', 'message/media_0.db', 'VoiceInfo', ident,
                            {'engine': data['engine'], 'segments': data.get('segments', []), 'generatedAt': data['generatedAt']})
        rel = 'message/message_resource.db'
        if account_ref and re.fullmatch('[a-f0-9]{12}', account_ref) and media_root is not None and (root / rel).exists():
            cache = Path.home() / '.local/share/dsh-wechat-ro/content-history' / account_ref
            with open_source(root, rel) as resources:
                for item in sorted(cache.glob('*.json')):
                    try:
                        data = json.loads(item.read_text())
                        kind = data.get('sourceKind')
                        if kind not in ('image', 'video'):
                            continue
                        rows = resources.execute('SELECT i.message_local_type,i.packed_info FROM MessageResourceInfo i JOIN ChatName2Id n ON n.rowid=i.chat_id WHERE n.user_name=? AND i.message_local_id=? AND i.message_create_time=? LIMIT 2', (data['talker'], data['localId'], data['ts'])).fetchall()
                        if len(rows) != 1 or rows[0][0] != (3 if kind == 'image' else 43) or rows[0][1] != bytes.fromhex('12220a20') + data['mediaHash'].encode('ascii'):
                            continue
                        month = datetime.fromtimestamp(data['ts'], timezone(timedelta(hours=8))).strftime('%Y-%m')
                        conversation = hashlib.md5(data['talker'].encode()).hexdigest()
                        candidates = [f'attach/{conversation}/{month}/Img/{data["mediaHash"]}{suffix}.dat' for suffix in ('_h', '_hd', '', '_t')] if kind == 'image' else [f'video/{month}/{data["mediaHash"]}.mp4', f'attach/{conversation}/{month}/Video/{data["mediaHash"]}.mp4']
                        if data['sourceFile'] not in candidates:
                            continue
                        original = media_root / data['sourceFile']
                        if any(p.is_symlink() for p in [original, *original.parents]):
                            continue
                        info = original.stat()
                        identity = f'{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}'
                        if not original.is_file() or identity != data['sourceIdentity']:
                            continue
                        ident = data['talker'] + '/' + data['localId'] + '/' + str(data['ts'])
                        ref = hashlib.sha256(f'{rel}/MessageResourceInfo/{ident}'.encode()).hexdigest()[:32]
                        if ref != data['recordRef'] or item.stem != ref:
                            continue
                        add(kind, data['talker'], data['ts'], '图片文字' if kind == 'image' else '视频文字与转写', data['text'], '', rel, 'MessageResourceInfo', ident,
                            {'engine': data['engine'], 'quality': data['quality'], 'generatedAt': data['generatedAt']}, ref=ref)
                    except (OSError, ValueError, KeyError, TypeError, UnicodeError):
                        skipped += 1
        out.executemany("INSERT INTO metadata VALUES(?,?)", [("version", str(VERSION)), ("counts", json.dumps(counts)), ("skipped", str(skipped))])
    return {"counts": counts, "skipped": skipped}
