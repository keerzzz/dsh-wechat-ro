#!/usr/bin/env python3
"""Read-only SQLCipher4 DB/WAL capture with authenticated committed-page replay.

This does not stop WeChat, checkpoint its databases, or attach to its process.
The caller supplies an already authorized private key file. A changing DB/WAL
pair is retried; independently consistent databases are not a cross-DB transaction.
WAL format: https://www.sqlite.org/fileformat2.html#walformat
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import struct
import tempfile
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone

import wcdb_key_tool


CONSISTENCY = "stable-db-wal-committed-verified"
WAL_HEADER_SIZE = 32
WAL_FRAME_HEADER_SIZE = 24


class SourceChanged(RuntimeError):
    """The source changed while the private DB/WAL copy was being captured."""


def _now() -> str:
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="microseconds")


def _path_fingerprint(path: str):
    with wcdb_key_tool._directory(os.path.dirname(path)) as parent:
        try:
            info = os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("源数据库和 sidecar 必须是无链接的普通文件")
    return wcdb_key_tool._fingerprint(info)


def _copy_file(source, destination: str) -> str:
    digest = hashlib.sha256()
    with wcdb_key_tool._regular_file(destination, "xb") as output:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return digest.hexdigest()


def _capture_pair(db_path: str, private_dir: str) -> dict:
    started = _now()
    wal_path, journal_path = db_path + "-wal", db_path + "-journal"
    with ExitStack() as stack:
        streams = {db_path: stack.enter_context(wcdb_key_tool._regular_file(db_path))}
        wal_identity = _path_fingerprint(wal_path)
        if wal_identity is not None:
            try:
                streams[wal_path] = stack.enter_context(wcdb_key_tool._regular_file(wal_path))
            except FileNotFoundError:
                raise SourceChanged("WAL 在打开期间发生变化") from None
            if wcdb_key_tool._fingerprint(os.fstat(streams[wal_path].fileno())) != wal_identity:
                raise SourceChanged("WAL 在打开期间被替换")
        before = {path: wcdb_key_tool._fingerprint(os.fstat(source.fileno()))
                  for path, source in streams.items()}
        journal_identity = _path_fingerprint(journal_path)
        if journal_identity is not None and journal_identity[2] != 0:
            raise ValueError("活动 rollback journal 需要引擎级读取，不作为 WAL 快照捕获")
        copies = {db_path: os.path.join(private_dir, "source.db")}
        if wal_identity is not None:
            copies[wal_path] = copies[db_path] + "-wal"
        hashes = {path: _copy_file(source, copies[path]) for path, source in streams.items()}
        # Metadata detects replacement/append; the second digest checks the actual
        # bytes and does not assume that timestamp resolution proves stability.
        for path, source in streams.items():
            source.seek(0)
            digest = hashlib.sha256()
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
            if (digest.hexdigest() != hashes[path]
                    or wcdb_key_tool._fingerprint(os.fstat(source.fileno())) != before[path]
                    or _path_fingerprint(path) != before[path]):
                raise SourceChanged("DB/WAL 在捕获期间发生变化")
        if (_path_fingerprint(wal_path) != before.get(wal_path)
                or _path_fingerprint(journal_path) != journal_identity):
            raise SourceChanged("SQLite sidecar 在捕获期间发生变化")
    return {"capture_started_at": started, "captured_at": _now(),
            "source_sha256": hashes[db_path],
            "wal_sha256": hashes.get(wal_path)}


def _checksum(data: bytes, state: tuple[int, int], byte_order: str) -> tuple[int, int]:
    if len(data) % 8:
        raise ValueError("WAL checksum 数据长度必须是 8 的倍数")
    first, second = state
    for left, right in struct.iter_unpack(byte_order + "II", data):
        first = (first + left + second) & 0xffffffff
        second = (second + right + first) & 0xffffffff
    return first, second


def _committed_wal_pages(source) -> tuple[dict[int, int], dict]:
    size = os.fstat(source.fileno()).st_size
    metadata = {"wal_valid_frames": 0, "wal_committed_frames": 0,
                "wal_uncommitted_frames": 0, "wal_tail_bytes": 0,
                "wal_tail_reason": None, "committed_pages": None}
    if size == 0:
        return {}, metadata
    header = source.read(WAL_HEADER_SIZE)
    if len(header) != WAL_HEADER_SIZE:
        raise ValueError("WAL header 不完整")
    magic, version, page_size = struct.unpack(">III", header[:12])
    if magic not in (0x377f0682, 0x377f0683) or version != 3007000:
        raise ValueError("不支持的 WAL magic/version")
    if page_size != wcdb_key_tool.PAGE_SZ:
        raise ValueError("WAL 页大小与 SQLCipher4 参数不匹配")
    byte_order = "<" if magic == 0x377f0682 else ">"
    state = _checksum(header[:24], (0, 0), byte_order)
    if state != struct.unpack(">II", header[24:32]):
        raise ValueError("WAL header checksum 校验失败")
    committed, pending = {}, {}
    frame_size = WAL_FRAME_HEADER_SIZE + page_size
    for index in range((size - WAL_HEADER_SIZE) // frame_size):
        offset = WAL_HEADER_SIZE + index * frame_size
        frame = source.read(WAL_FRAME_HEADER_SIZE)
        page = source.read(page_size)
        # SQLite may keep preallocated frames from an earlier WAL generation.
        if frame[8:16] != header[16:24]:
            metadata["wal_tail_bytes"] = size - offset
            metadata["wal_tail_reason"] = "previous-generation-salt"
            break
        pgno, db_pages = struct.unpack(">II", frame[:8])
        if pgno == 0:
            raise ValueError("WAL frame 页号无效")
        state = _checksum(page, _checksum(frame[:8], state, byte_order), byte_order)
        if state != struct.unpack(">II", frame[16:24]):
            # A matching-generation bad checksum is not silently treated as an
            # old tail: that would hide a damaged committed transaction.
            raise ValueError("WAL frame checksum 校验失败")
        pending[pgno] = offset + WAL_FRAME_HEADER_SIZE
        metadata["wal_valid_frames"] += 1
        if db_pages:
            committed.update(pending)
            pending.clear()
            metadata["committed_pages"] = db_pages
            metadata["wal_committed_frames"] = index + 1
    if not metadata["wal_tail_reason"]:
        metadata["wal_tail_bytes"] = (size - WAL_HEADER_SIZE) % frame_size
        if metadata["wal_tail_bytes"]:
            metadata["wal_tail_reason"] = "incomplete-frame"
    metadata["wal_uncommitted_frames"] = (
        metadata["wal_valid_frames"] - metadata["wal_committed_frames"])
    return committed, metadata


def _decrypt_captured(db_copy: str, out_path: str, enc_key: bytes) -> dict:
    made_output = False
    try:
        with ExitStack() as stack:
            database = stack.enter_context(wcdb_key_tool._regular_file(db_copy, private=True))
            size = os.fstat(database.fileno()).st_size
            if size < wcdb_key_tool.PAGE_SZ or size % wcdb_key_tool.PAGE_SZ:
                raise ValueError("DB 必须由完整的 4096 字节页组成")
            page1 = database.read(wcdb_key_tool.PAGE_SZ)
            mac_key = wcdb_key_tool._mac_key(enc_key, page1[:wcdb_key_tool.SALT_SZ])
            base_header = (wcdb_key_tool._decrypt_page(enc_key, page1, 1)
                           if wcdb_key_tool._verify_page(mac_key, page1, 1) else None)
            wal = None
            try:
                wal = stack.enter_context(wcdb_key_tool._regular_file(db_copy + "-wal", private=True))
            except FileNotFoundError:
                pass
            offsets, metadata = _committed_wal_pages(wal) if wal is not None else ({}, {
                "wal_valid_frames": 0, "wal_committed_frames": 0,
                "wal_uncommitted_frames": 0, "wal_tail_bytes": 0,
                "wal_tail_reason": None, "committed_pages": None})
            metadata["base_pages"] = metadata["base_physical_pages"] = size // wcdb_key_tool.PAGE_SZ
            declared_pages = int.from_bytes(base_header[28:32], "big") if base_header is not None else None
            # SQLite's authenticated in-header size is authoritative only when
            # nonzero and the change-counter equals version-valid-for. WCDB can
            # reserve zero-filled physical pages beyond that logical boundary.
            # https://www.sqlite.org/fileformat2.html#in_header_database_size
            metadata["base_header_page_count"] = declared_pages
            metadata["base_header_page_count_valid"] = (
                base_header is not None and bool(declared_pages)
                and base_header[24:28] == base_header[92:96])
            metadata["base_logical_pages"] = (
                declared_pages if metadata["base_header_page_count_valid"] else metadata["base_physical_pages"])
            count = metadata["committed_pages"] or metadata["base_logical_pages"]
            if count > max(metadata["base_pages"], max(offsets, default=0)):
                raise ValueError("WAL commit 指定了缺失的数据库页面")
            header = base_header
            if 1 in offsets:
                wal.seek(offsets[1])
                selected_page1 = wal.read(wcdb_key_tool.PAGE_SZ)
                if not wcdb_key_tool._verify_page(mac_key, selected_page1, 1):
                    raise ValueError("最终页面 HMAC/长度校验失败")
                header = wcdb_key_tool._decrypt_page(enc_key, selected_page1, 1)
            if header is None:
                raise ValueError("最终页面 HMAC/长度校验失败")
            metadata["wal_commit_page_count"] = metadata["committed_pages"]
            final_declared = int.from_bytes(header[28:32], "big")
            final_valid = bool(final_declared) and header[24:28] == header[92:96]
            metadata["final_header_page_count"] = final_declared
            metadata["final_header_page_count_valid"] = final_valid
            # WCDB can report physical preallocation in a WAL commit while its
            # authenticated SQLite header still declares a smaller logical DB.
            # Trim only an entirely zero base tail with no WAL page in it. Real
            # growth, invalid header counters, and any nonzero tail keep the WAL
            # boundary and must authenticate normally.
            if (final_valid and final_declared < count <= metadata["base_physical_pages"]
                    and max(offsets, default=0) <= final_declared):
                database.seek(final_declared * wcdb_key_tool.PAGE_SZ)
                remaining = (count - final_declared) * wcdb_key_tool.PAGE_SZ
                zero_tail = True
                while remaining:
                    chunk = database.read(min(remaining, 1024 * 1024))
                    if not chunk or any(chunk):
                        zero_tail = False
                        break
                    remaining -= len(chunk)
                if zero_tail:
                    metadata["excluded_zero_preallocation_pages"] = count - final_declared
                    count = final_declared
            with wcdb_key_tool._regular_file(out_path, "xb") as output:
                made_output = True
                # This is a new standalone DB after committed WAL materialization.
                output.write(header[:18] + b"\x01\x01" + header[20:])
                for pgno in range(2, count + 1):
                    source = wal if pgno in offsets else database
                    source.seek(offsets[pgno] if pgno in offsets else (pgno - 1) * wcdb_key_tool.PAGE_SZ)
                    page = source.read(wcdb_key_tool.PAGE_SZ)
                    if not wcdb_key_tool._verify_page(mac_key, page, pgno):
                        raise ValueError("最终页面 HMAC/长度校验失败")
                    output.write(wcdb_key_tool._decrypt_page(enc_key, page, pgno))
                output.flush()
                os.fsync(output.fileno())
        wcdb_key_tool._validate_sqlite(out_path, count * wcdb_key_tool.PAGE_SZ)
        metadata["committed_pages"] = count
        return metadata
    except BaseException:
        if made_output:
            with wcdb_key_tool._directory(os.path.dirname(out_path), private=True) as parent:
                os.unlink(os.path.basename(out_path), dir_fd=parent)
        raise


def decrypt_live_database(db_path: str, out_path: str, enc_key: bytes, max_attempts: int = 3) -> dict:
    """Create one new file; return only after stable capture, page auth and validation."""
    db_path, out_path = wcdb_key_tool._absolute(db_path), wcdb_key_tool._absolute(out_path)
    wcdb_key_tool._reject_overlap(os.path.dirname(db_path), out_path)
    if len(enc_key) != wcdb_key_tool.KEY_SZ or not 1 <= max_attempts <= 10:
        raise ValueError("需要 32 字节密钥及 1–10 次捕获尝试")
    with wcdb_key_tool._directory(os.path.dirname(out_path), create=True, private=True):
        pass
    for attempt in range(1, max_attempts + 1):
        with tempfile.TemporaryDirectory(prefix=".wcdb-live-copy-", dir=os.path.dirname(out_path)) as private_dir:
            try:
                captured = _capture_pair(db_path, private_dir)
            except SourceChanged:
                if attempt == max_attempts:
                    raise
                continue
            metadata = _decrypt_captured(os.path.join(private_dir, "source.db"), out_path, enc_key)
            return {**captured, **metadata, "capture_attempts": attempt}
    raise SourceChanged("源数据库持续变化，本次未创建解密输出")


def _database_paths(db_dir: str, selected_paths: list[str] | None = None) -> list[str]:
    result = []
    with wcdb_key_tool._directory(db_dir) as base:
        for root, directories, files, parent in os.fwalk(
                ".", dir_fd=base, follow_symlinks=False, onerror=wcdb_key_tool._walk_error):
            if selected_paths is not None:
                directories[:] = [name for name in directories if any(
                    selected.startswith(os.path.normpath(os.path.join(root, name)) + os.sep)
                    for selected in selected_paths)]
            for name in directories:
                if not stat.S_ISDIR(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
                    raise ValueError("数据库树含符号链接目录")
            result.extend(os.path.normpath(os.path.join(root, name)) for name in files
                          if name.endswith(".db") and (selected_paths is None
                          or os.path.normpath(os.path.join(root, name)) in selected_paths))
    if not result:
        raise ValueError("没有数据库，本次不发布空快照")
    if selected_paths is not None and sorted(result) != sorted(selected_paths):
        raise ValueError("明确选择的数据库集合不完整")
    return sorted(result)


def snapshot_live(db_dir: str, destination: str, keys_file: str, max_attempts: int = 3,
                  selected_paths: list[str] | None = None) -> dict:
    """Atomically publish a complete generation of independently captured DB/WAL pairs."""
    db_dir, destination = wcdb_key_tool._absolute(db_dir), wcdb_key_tool._absolute(destination)
    wcdb_key_tool._reject_overlap(db_dir, destination)
    wcdb_key_tool._reject_overlap(destination, keys_file)
    if selected_paths is not None and (not selected_paths
            or any(not isinstance(path, str) or "\\" in path or not path.endswith(".db")
                   or any(part in ("", ".", "..") for part in path.split("/")) for path in selected_paths)
            or len(set(selected_paths)) != len(selected_paths)):
        raise ValueError("selected_paths 必须是唯一、明确选择的相对 .db 路径")
    keys = wcdb_key_tool._strip_key_metadata(wcdb_key_tool._read_private_json(keys_file))
    paths = _database_paths(db_dir, selected_paths)
    with wcdb_key_tool._publication_lock(destination) as parent:
        stage, owned = wcdb_key_tool._new_stage(destination, parent)
        try:
            out_dir = os.path.join(stage, "decrypted")
            captures = []
            for rel in paths:
                entry = wcdb_key_tool._get_key_info(keys, rel)
                if not isinstance(entry, dict) or "enc_key" not in entry:
                    raise ValueError("源数据库的私有密钥集合不完整")
                captures.append({"path": rel, **decrypt_live_database(
                    os.path.join(db_dir, rel), os.path.join(out_dir, rel),
                    wcdb_key_tool._secret_bytes(entry["enc_key"]), max_attempts)})
            if paths != _database_paths(db_dir, selected_paths):
                raise SourceChanged("捕获前后数据库集合发生变化")
            files = [{"path": rel, "size": info["size"], "sha256": info["sha256"]}
                     for rel, info in sorted(wcdb_key_tool._scan_db_inventory(out_dir).items())]
            manifest = {"schema_version": 1, "snapshot_id": uuid.uuid4().hex,
                        "captured_at": _now(), "complete": True,
                        "consistency": CONSISTENCY, "files": files, "databases": captures,
                        "source_scope": {"databases": paths}}
            wcdb_key_tool._write_private_json(os.path.join(out_dir, ".wechat-ro-manifest.json"), manifest)
            backup = wcdb_key_tool._publish_directory(stage, destination, parent)
            return {"success": len(files), "failed": 0, "total": len(files),
                    "total_bytes": sum(item["size"] for item in files),
                    "complete": True, "published": True, "backup_dir": backup,
                    "snapshot_id": manifest["snapshot_id"], "consistency": CONSISTENCY}
        finally:
            wcdb_key_tool._discard_stage(stage, owned, parent)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-dir", required=True, help="明确选择的加密 db_storage")
    parser.add_argument("--output", required=True, help="独立快照根目录，解密结果位于 decrypted/")
    parser.add_argument("--keys", required=True, help="已经授权的 0600 派生密钥 JSON 路径")
    parser.add_argument("--max-attempts", type=int, default=3, help="每库变化时最多重试 1–10 次")
    parser.add_argument("--database", action="append", help="只采集指定相对 .db 路径，可重复")
    args = parser.parse_args()
    try:
        print(json.dumps(snapshot_live(args.db_dir, args.output, args.keys, args.max_attempts, args.database), ensure_ascii=False))
    except (ValueError, OSError, RuntimeError, sqlite3.Error) as error:
        # Native/SQLite exception text can contain user data; emit the error class only.
        print(json.dumps({"complete": False, "published": False, "error": type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
