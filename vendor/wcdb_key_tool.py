#!/usr/bin/env python3
"""wcdb-key-tool — 微信数据库密钥提取工具

Linux 微信数据库密钥提取工具。通过 ELF 静态分析自动适配新版本，无需每次更新手动逆向。
Extract WeChat (WCDB/SQLCipher4) database encryption keys on Linux.
Auto-adapts to new versions via ELF static analysis — no manual reverse engineering needed per update.

Usage (explicitly selected synthetic/offline paths shown as placeholders):
    python3 wcdb_key_tool.py extract --db-dir COPY --output PRIVATE/all_keys.json
    python3 wcdb_key_tool.py decrypt --db-dir COPY --keys PRIVATE/all_keys.json
    python3 wcdb_key_tool.py snapshot --db-dir SOURCE --output SNAPSHOT --source-quiescent

Requirements:
    - Python 3.10+, OpenSSL libcrypto, Linux renameat2 for atomic publication
    - Source must be operator-quiesced and have no WAL/SHM/journal for snapshot
    - Private 0700/0600 products, with trusted root/executing-UID path ancestors
    - GDB and explicit --allow-capture only when a new passphrase is needed
    - Live capture separately requires authorized ptrace access and running WeChat

https://github.com/TANGandXUE/wcdb-key-tool
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import fcntl
import glob
import hashlib
import hmac as hmac_mod
import json
import logging
import os
import pathlib
import re
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import textwrap
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

_print = lambda *a, **kw: print(*a, flush=True, **kw)  # noqa: E731

# ============================================================
# Constants
# ============================================================
PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
IV_SZ = 16
HMAC_SZ = 64
RESERVE_SZ = 80  # IV(16) + HMAC(64)
SQLITE_HDR = b"SQLite format 3\x00"

# ============================================================
# AES-CBC via OpenSSL (no third-party deps)
# ============================================================

def _load_openssl() -> ctypes.CDLL:
    """加载 libssl/libcrypto，优先 libcrypto。"""
    for name in ("crypto", "ssl"):
        lib_name = ctypes.util.find_library(name)
        if lib_name:
            try:
                return ctypes.CDLL(lib_name)
            except OSError:
                pass
    # fallback: 直接尝试常见路径
    for path in ("/usr/lib/x86_64-linux-gnu/libcrypto.so.3",
                 "/usr/lib/x86_64-linux-gnu/libcrypto.so.1.1",
                 "/lib/x86_64-linux-gnu/libcrypto.so.3"):
        if os.path.exists(path):
            return ctypes.CDLL(path)
    raise RuntimeError("未找到 libcrypto/libssl，请安装: sudo apt install libssl-dev")


_ssl: ctypes.CDLL | None = None


def _get_ssl() -> ctypes.CDLL:
    global _ssl
    if _ssl is None:
        ssl = _load_openssl()
        # Bind the complete C ABI once, before any EVP call can use a pointer.
        ptr = ctypes.c_void_p
        integer = ctypes.c_int
        length = ctypes.POINTER(integer)
        signatures = {
            "EVP_CIPHER_CTX_new": ([], ptr),
            "EVP_CIPHER_CTX_free": ([ptr], None),
            "EVP_aes_256_cbc": ([], ptr),
            "EVP_DecryptInit_ex": ([ptr, ptr, ptr, ptr, ptr], integer),
            "EVP_CIPHER_CTX_set_padding": ([ptr, integer], integer),
            "EVP_DecryptUpdate": ([ptr, ptr, length, ptr, integer], integer),
            "EVP_DecryptFinal_ex": ([ptr, ptr, length], integer),
        }
        for name, (argtypes, restype) in signatures.items():
            function = getattr(ssl, name)
            function.argtypes = argtypes
            function.restype = restype
        _ssl = ssl
    return _ssl


def aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    """AES-256-CBC 解密，无 padding；拒绝错误长度和任何 EVP 失败。"""
    if len(key) != KEY_SZ or len(iv) != IV_SZ or len(data) % IV_SZ:
        raise ValueError("AES-256-CBC 需要 32 字节 key、16 字节 IV 和整块数据")
    if len(data) > 0x7fffffff:
        raise ValueError("AES 输入超过 EVP int 长度上限")
    ssl = _get_ssl()

    # EVP_CIPHER_CTX_new
    ctx = ssl.EVP_CIPHER_CTX_new()
    if not ctx:
        raise RuntimeError("EVP_CIPHER_CTX_new 失败")
    try:
        # EVP_aes_256_cbc
        cipher = ssl.EVP_aes_256_cbc()
        if not cipher:
            raise RuntimeError("EVP_aes_256_cbc 失败")

        # EVP_DecryptInit_ex
        ret = ssl.EVP_DecryptInit_ex(ctx, cipher, None,
                                     (ctypes.c_ubyte * 32)(*key),
                                     (ctypes.c_ubyte * 16)(*iv))
        if ret != 1:
            raise RuntimeError("EVP_DecryptInit_ex 失败")

        # 关闭 padding（SQLCipher 自管 padding）
        if ssl.EVP_CIPHER_CTX_set_padding(ctx, 0) != 1:
            raise RuntimeError("EVP_CIPHER_CTX_set_padding 失败")

        out_buf = ctypes.create_string_buffer(len(data) + 32)
        out_len = ctypes.c_int(0)

        ret = ssl.EVP_DecryptUpdate(ctx, out_buf, ctypes.byref(out_len),
                                    ctypes.c_char_p(data), len(data))
        if ret != 1:
            raise RuntimeError("EVP_DecryptUpdate 失败")

        final_buf = ctypes.create_string_buffer(32)
        final_len = ctypes.c_int(0)
        if ssl.EVP_DecryptFinal_ex(ctx, final_buf, ctypes.byref(final_len)) != 1:
            raise RuntimeError("EVP_DecryptFinal_ex 失败")
        if not (0 <= out_len.value <= len(data) and 0 <= final_len.value <= 16):
            raise RuntimeError("EVP 返回了无效的输出长度")
        if out_len.value + final_len.value != len(data):
            raise RuntimeError("EVP 无 padding 输出长度不匹配")
        return out_buf.raw[:out_len.value] + final_buf.raw[:final_len.value]
    finally:
        ssl.EVP_CIPHER_CTX_free(ctx)


# ============================================================
# HMAC Verification
# ============================================================

def verify_enc_key(enc_key: bytes, db_page1: bytes) -> bool:
    """通过 HMAC-SHA512 校验 page 1 验证 enc_key 是否正确。

    SQLCipher4 参数：
    - MAC salt = DB salt XOR 0x3A
    - MAC key = PBKDF2(enc_key, mac_salt, iterations=2, sha512, 32B)
    - HMAC 范围: page1[16:4032]
    - 存储的 HMAC: page1[4032:4096] (64B SHA512)
    """
    if len(enc_key) != KEY_SZ or len(db_page1) != PAGE_SZ:
        return False
    return _verify_page(_mac_key(enc_key, db_page1[:SALT_SZ]), db_page1, 1)


def _mac_key(enc_key: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha512", enc_key, bytes(b ^ 0x3A for b in salt), 2, dklen=KEY_SZ,
    )


def _verify_page(mac_key: bytes, page: bytes, pgno: int) -> bool:
    if len(page) != PAGE_SZ or not 1 <= pgno <= 0xffffffff:
        return False
    start = SALT_SZ if pgno == 1 else 0
    hm = hmac_mod.new(mac_key, page[start:PAGE_SZ - HMAC_SZ], hashlib.sha512)
    hm.update(struct.pack("<I", pgno))
    return hmac_mod.compare_digest(hm.digest(), page[PAGE_SZ - HMAC_SZ:])


# ============================================================
# DB File Collection
# ============================================================

def _absolute(path: str) -> str:
    path = os.fspath(path)
    if ".." in pathlib.Path(path).parts:
        raise ValueError("路径不得包含 ..")
    return os.path.abspath(os.path.expanduser(path))


def _check_private(info: os.stat_result, directory: bool = False) -> None:
    expected = 0o700 if directory else 0o600
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != expected:
        raise PermissionError("私有目录/文件必须属于当前执行身份且权限为 0700/0600；拒绝自动修复既有路径")
    if not directory and info.st_nlink != 1:
        raise ValueError("拒绝硬链接文件")


def _check_write_ancestor(info: os.stat_result) -> None:
    # Private leaf modes alone do not prevent an attacker replacing a whole ancestor.
    # A root/own sticky directory (e.g. /tmp) protects our entries from other users.
    if (info.st_uid not in (0, os.geteuid())
            or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX)):
        raise PermissionError("写路径祖先必须由 root/执行身份拥有且不可由其他用户替换；拒绝自动改属主/权限")


@contextmanager
def _directory(path: str, *, create: bool = False, private: bool = False):
    """Anchor every component with openat/O_NOFOLLOW; never chmod a caller path."""
    path = _absolute(path)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in pathlib.Path(path).parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            if create or private:
                _check_write_ancestor(os.fstat(fd))
        if private:
            _check_private(os.fstat(fd), directory=True)
        yield fd
    finally:
        os.close(fd)


@contextmanager
def _regular_file(path: str, mode: str = "rb", *, private: bool = False):
    if mode not in ("rb", "xb"):
        raise ValueError("仅允许只读或独占新建文件")
    path = _absolute(path)
    writing = mode == "xb"
    with _directory(os.path.dirname(path), create=writing, private=private or writing) as parent:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL if writing else os.O_RDONLY
        fd = os.open(os.path.basename(path), flags | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o600, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("只接受无符号/硬链接的普通文件")
        if private or writing:
            _check_private(info)
        stream = os.fdopen(fd, mode)
        fd = -1
        with stream:
            yield stream
    finally:
        if fd != -1:
            os.close(fd)


def _existing_private(parent: int, name: str, *, directory: bool = False):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode):
        raise ValueError("拒绝符号链接及非预期类型的既有目标")
    _check_private(info, directory=directory)
    return info


def _write_private_json(path: str, value: dict) -> None:
    path = _absolute(path)
    name = os.path.basename(path)
    with _directory(os.path.dirname(path), create=True, private=True) as parent:
        _existing_private(parent, name)
        temporary = "." + name + ".tmp-" + uuid.uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(value, output, indent=2, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            _existing_private(parent, name)
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def _read_private_json(path: str) -> dict:
    with _regular_file(path, private=True) as source:
        try:
            value = json.load(source)
        except (ValueError, UnicodeError):
            raise ValueError("私有缓存不是有效 JSON；拒绝输出内容") from None
    if not isinstance(value, dict):
        raise ValueError("私有缓存必须是 JSON 对象")
    return value


def _reject_overlap(source: str, destination: str) -> None:
    source, destination = _absolute(source), _absolute(destination)
    if os.path.commonpath([source, destination]) in (source, destination):
        raise ValueError("原始目录与写入目标不得相同、包含或互为别名")

    def directory_identities(path):
        leaf = pathlib.Path(path)
        leaf_id, ancestors = None, set()
        for ancestor in (leaf, *leaf.parents):
            try:
                with _directory(str(ancestor)) as fd:
                    info = os.fstat(fd)
            except FileNotFoundError:
                continue
            except NotADirectoryError:
                if ancestor == leaf:  # The destination may be a cache file.
                    continue
                raise
            identity = (info.st_dev, info.st_ino)
            ancestors.add(identity)
            if ancestor == leaf:
                leaf_id = identity
        return leaf_id, ancestors

    # Linux // paths and pre-existing bind aliases can bypass lexical commonpath.
    # Compare real anchored directory identities, including nonexistent targets
    # whose existing parent is an alias of the original source.
    source_id, source_ancestors = directory_identities(source)
    destination_id, destination_ancestors = directory_identities(destination)
    if (source_id is not None and source_id in destination_ancestors
            or destination_id is not None and destination_id in source_ancestors):
        raise ValueError("原始目录与写入目标存在目录 inode 别名/包含关系")


def _fingerprint(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _walk_error(error: OSError) -> None:
    raise error


def _check_private_tree(path: str) -> None:
    with _directory(path, private=True) as base:
        for _root, dirs, files, parent in os.fwalk(
                ".", dir_fd=base, follow_symlinks=False, onerror=_walk_error):
            for name in dirs:
                _existing_private(parent, name, directory=True)
            for name in files:
                _existing_private(parent, name)


def _scan_db_inventory(db_dir: str) -> dict:
    """Reject SQLite sidecars and links; hash a stable, complete .db inventory."""
    db_dir = _absolute(db_dir)
    inventory = {}
    with _directory(db_dir) as base:
        for root, dirs, files, parent in os.fwalk(
                ".", dir_fd=base, follow_symlinks=False, onerror=_walk_error):
            for name in dirs:
                if not stat.S_ISDIR(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
                    raise ValueError("数据库树含符号链接目录")
            for name in sorted(files):
                if name.endswith(("-wal", "-shm", "-journal")):
                    raise ValueError("发现 WAL/SHM/journal；只接受操作员已静止且无 sidecar 的输入")
                if not name.endswith(".db"):
                    continue
                rel = os.path.normpath(os.path.join(root, name))
                path = os.path.join(db_dir, rel)
                with _regular_file(path) as source:
                    before = os.fstat(source.fileno())
                    if before.st_size < PAGE_SZ or before.st_size % PAGE_SZ:
                        raise ValueError("数据库必须由完整的 4096 字节页组成")
                    first = source.read(PAGE_SZ)
                    digest = hashlib.sha256(first)
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                    if _fingerprint(before) != _fingerprint(os.fstat(source.fileno())):
                        raise ValueError("数据库在读取期间发生变化")
                inventory[rel] = {"size": before.st_size, "sha256": digest.hexdigest(),
                                  "fingerprint": _fingerprint(before), "page1": first}
    if not inventory:
        raise ValueError("没有数据库；拒绝发布空代次")
    return inventory


def collect_db_files(db_dir: str) -> tuple[list, dict]:
    """Return every input database; malformed or unstable files are not skipped."""
    db_files = []
    salt_to_dbs = {}
    for rel, info in sorted(_scan_db_inventory(db_dir).items()):
        first = info["page1"]
        salt = first[:SALT_SZ].hex()
        db_files.append((rel, os.path.join(_absolute(db_dir), rel), info["size"], salt, first))
        salt_to_dbs.setdefault(salt, []).append(rel)
    return db_files, salt_to_dbs


def copy_stable_databases(db_dir: str, copy_dir: str) -> str:
    """Copy only stable DB-only inputs; never stop, checkpoint, or repair the source."""
    _reject_overlap(db_dir, copy_dir)
    inventory = _scan_db_inventory(db_dir)
    with _directory(copy_dir, create=True, private=True) as parent:
        if os.listdir(parent):
            raise ValueError("加密副本目录必须是本次创建的空目录")
    for rel, info in inventory.items():
        source_path = os.path.join(_absolute(db_dir), rel)
        out_path = os.path.join(_absolute(copy_dir), rel)
        with _regular_file(source_path) as source, _regular_file(out_path, "xb") as output:
            if _fingerprint(os.fstat(source.fileno())) != info["fingerprint"]:
                raise ValueError("数据库在复制前发生变化")
            digest = hashlib.sha256()
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
            if (_fingerprint(os.fstat(source.fileno())) != info["fingerprint"]
                    or digest.hexdigest() != info["sha256"]):
                raise ValueError("数据库在复制期间发生变化")
    if inventory != _scan_db_inventory(db_dir):
        raise ValueError("复制前后数据库清单、内容或身份改变；本次不发布")
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")


@contextmanager
def _publication_lock(destination: str):
    destination = _absolute(destination)
    with _directory(os.path.dirname(destination), create=True) as parent:
        name = "." + os.path.basename(destination) + ".lock"
        _existing_private(parent, name)
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o600, dir_fd=parent)
        try:
            _check_private(os.fstat(fd))
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("另一个进程拥有此快照目标；本次不运行") from None
            if _fingerprint(os.fstat(fd)) != _fingerprint(os.stat(name, dir_fd=parent)):
                raise RuntimeError("快照锁身份发生变化")
            if _existing_private(parent, os.path.basename(destination), directory=True) is not None:
                _check_private_tree(destination)
            yield parent
        finally:
            os.close(fd)  # Keep the lock inode; unlink would permit a split lock.


def _new_stage(destination: str, parent: int) -> tuple[str, tuple[int, int]]:
    # The name becomes the old backup after exchange; cleanup owns only this inode.
    name = "." + os.path.basename(destination) + ".backup-" + uuid.uuid4().hex
    os.mkdir(name, mode=0o700, dir_fd=parent)
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    return os.path.join(os.path.dirname(_absolute(destination)), name), (info.st_dev, info.st_ino)


def _publish_directory(stage: str, destination: str, parent: int) -> str | None:
    """Atomic Linux publication. No two-rename fallback or deletion of an old generation."""
    stage_name, dest_name = os.path.basename(stage), os.path.basename(destination)
    _existing_private(parent, stage_name, directory=True)
    existing = _existing_private(parent, dest_name, directory=True)
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        renameat2 = libc.renameat2
    except AttributeError:
        raise RuntimeError("需要 Linux renameat2；不支持时拒绝发布") from None
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                          ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    # RENAME_NOREPLACE for a new destination, RENAME_EXCHANGE for a refresh.
    flags = 2 if existing is not None else 1
    os.fsync(parent)
    if renameat2(parent, os.fsencode(stage_name), parent, os.fsencode(dest_name), flags) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "原子快照发布失败；未回退到非原子操作")
    # Cancellation can precede acknowledgement: cleanup must retain the exchanged inode.
    return stage if existing is not None else None


def _discard_stage(stage: str, owned: tuple[int, int], parent: int) -> None:
    """Under the publication lock, remove only the original unpublished candidate."""
    name = os.path.basename(stage)
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return  # First publication already moved the candidate to its destination.
    if (info.st_dev, info.st_ino) != owned:
        return  # Exchange committed: this name now holds the old generation.
    _check_private(info, directory=True)
    if not shutil.rmtree.avoids_symlink_attacks:
        raise RuntimeError("平台缺少防符号链接的 staging 清理")
    shutil.rmtree(name, dir_fd=parent)



# ============================================================
# ELF Analysis
# ============================================================

ANCHOR_STRING = b"com.Tencent.WCDB.Config.Cipher"
LEA_RSI = b"\x48\x8D\x35"
LEA_RDI = b"\x48\x8D\x3D"
FUNC_HEAD = b"\x55\x41\x57"
ELF_MAGIC = b"\x7fELF"
EM_X86_64 = 62


class _ELFSection:
    __slots__ = ("name", "addr", "offset", "size", "data")

    def __init__(self, name: str, addr: int, offset: int, size: int, data: bytes) -> None:
        self.name = name
        self.addr = addr
        self.offset = offset
        self.size = size
        self.data = data


def _load_elf_sections(binary_path: pathlib.Path) -> dict[str, _ELFSection]:
    data = binary_path.read_bytes()
    if data[:4] != ELF_MAGIC:
        raise RuntimeError(f"不是 ELF 文件: {binary_path}")
    if data[4] != 2 or data[5] != 1:
        raise RuntimeError(f"仅支持 ELF64 小端序: {binary_path}")

    (
        _etype, machine, _version, _entry, _phoff, shoff,
        _flags, _ehsize, _phentsize, _phnum,
        shentsize, shnum, shstrndx,
    ) = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)

    if machine != EM_X86_64:
        raise RuntimeError(f"仅支持 x86_64 架构: {binary_path}")

    sections_raw: list[tuple[int, int, int, int]] = []
    for index in range(shnum):
        offset = shoff + (index * shentsize)
        sh_name, _sh_type, _flags2, sh_addr, sh_offset, sh_size = (
            struct.unpack_from("<IIQQQQIIQQ", data, offset)[:6]
        )
        sections_raw.append((sh_name, sh_addr, sh_offset, sh_size))

    if shstrndx >= len(sections_raw):
        raise RuntimeError("无效的节字符串表索引")
    _, _, shstr_offset, shstr_size = sections_raw[shstrndx]
    shstr_data = data[shstr_offset: shstr_offset + shstr_size]

    sections: dict[str, _ELFSection] = {}
    for sh_name, sh_addr, sh_offset, sh_size in sections_raw:
        end = shstr_data.find(b"\0", sh_name)
        if end == -1:
            end = len(shstr_data)
        name = shstr_data[sh_name:end].decode("utf-8", errors="replace")
        if not name:
            continue
        section_bytes = data[sh_offset: sh_offset + sh_size]
        sections[name] = _ELFSection(
            name=name, addr=sh_addr, offset=sh_offset, size=sh_size, data=section_bytes,
        )
    return sections


def _find_rip_relative_refs(text: _ELFSection, opcode: bytes, target_va: int) -> list[int]:
    hits = []
    limit = max(0, len(text.data) - 7)
    for offset in range(limit + 1):
        if text.data[offset: offset + 3] != opcode:
            continue
        disp = struct.unpack_from("<i", text.data, offset + 3)[0]
        resolved = text.addr + offset + 7 + disp
        if resolved == target_va:
            hits.append(offset)
    return hits


def find_hook_offset(binary_path: str | pathlib.Path) -> int:
    """分析 ELF 二进制，定位密钥捕获断点的虚拟地址。"""
    binary_path = pathlib.Path(binary_path)
    sections = _load_elf_sections(binary_path)
    try:
        rodata = sections[".rodata"]
        text = sections[".text"]
    except KeyError as exc:
        raise RuntimeError(f"ELF 缺少必要的节: {exc.args[0]}") from exc

    candidates: list[int] = []
    search_from = 0
    while True:
        anchor_offset = rodata.data.find(ANCHOR_STRING, search_from)
        if anchor_offset == -1:
            break
        search_from = anchor_offset + 1
        anchor_va = rodata.addr + anchor_offset

        for first_ref_offset in _find_rip_relative_refs(text, LEA_RSI, anchor_va):
            if first_ref_offset < 7:
                continue
            if text.data[first_ref_offset - 7: first_ref_offset - 4] != LEA_RDI:
                continue

            unk_disp = struct.unpack_from("<i", text.data, first_ref_offset - 4)[0]
            unk_va = text.addr + first_ref_offset + unk_disp

            for second_ref_offset in _find_rip_relative_refs(text, LEA_RSI, unk_va):
                scan_start = max(0, second_ref_offset - 0x500)
                for candidate_offset in range(second_ref_offset, scan_start - 1, -1):
                    if text.data[candidate_offset: candidate_offset + len(FUNC_HEAD)] == FUNC_HEAD:
                        va = text.addr + candidate_offset
                        if va not in candidates:
                            candidates.append(va)
                        break

    if not candidates:
        raise RuntimeError(
            f"未能在 {binary_path} 中定位密钥捕获断点。\n"
            "可能是不支持的微信版本。"
        )
    va = sorted(candidates)[0]
    logger.info(f"找到断点虚拟地址: 0x{va:X}")
    return va


def find_runtime_base(pid: int, binary_path: str | pathlib.Path) -> int:
    """从 /proc/{pid}/maps 找到微信二进制的运行时基址。"""
    binary_path = pathlib.Path(binary_path)
    binary_name = binary_path.name
    maps_path = pathlib.Path(f"/proc/{pid}/maps")
    try:
        maps_text = maps_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"无法读取 /proc/{pid}/maps: {exc}") from exc

    for line in maps_text.splitlines():
        parts = line.split()
        if len(parts) < 6:
            continue
        if not parts[5].endswith("/" + binary_name):
            continue
        if "r" in parts[1] and "x" in parts[1]:
            return int(parts[0].split("-")[0], 16)

    for line in maps_text.splitlines():
        parts = line.split()
        if len(parts) >= 6 and parts[5].endswith("/" + binary_name):
            return int(parts[0].split("-")[0], 16)

    raise RuntimeError(f"未找到 {binary_name} 的内存映射基址 (PID={pid})")


# ============================================================
# GDB Capture
# ============================================================

_GDB_SCRIPT_TEMPLATE = textwrap.dedent("""\
    set pagination off
    attach {pid}
    python
    import gdb

    class CaptureBreakpoint(gdb.Breakpoint):
        def stop(self):
            try:
                rsi = int(gdb.parse_and_eval("$rsi"))
                rdx = int(gdb.parse_and_eval("$rdx"))
                # 方法 1: wxchat-export 方式（rsi=key_ptr, rdx=key_len=32）
                if rsi and rdx == 32:
                    raw = gdb.selected_inferior().read_memory(rsi, 32).tobytes()
                    print("WECHAT_PASSPHRASE=" + raw.hex())
                    gdb.execute("detach")
                    gdb.execute("quit")
                    return True
                # 方法 2: kkocdko 方式（rsi 指向结构体，key 在 *(rsi+8)，size 在 rsi+16）
                if rsi:
                    import struct as _struct
                    try:
                        size_val = int(gdb.parse_and_eval("*(unsigned long long*)($rsi+16)"))
                        if size_val == 32:
                            key_ptr = int(gdb.parse_and_eval("*(unsigned long long*)($rsi+8)"))
                            if key_ptr:
                                raw = gdb.selected_inferior().read_memory(key_ptr, 32).tobytes()
                                print("WECHAT_PASSPHRASE=" + raw.hex())
                                gdb.execute("detach")
                                gdb.execute("quit")
                                return True
                    except:
                        pass
            except Exception as e:
                print("CAPTURE_ERROR=" + str(e))
            return False

    CaptureBreakpoint("*{breakpoint_addr:#x}")
    end
    continue
    quit
""")


class CaptureError(RuntimeError):
    pass


def check_prerequisites() -> list[str]:
    """预检查环境，返回问题列表（空列表表示一切正常）。"""
    issues = []

    if not shutil.which("gdb"):
        issues.append("未安装 GDB，请运行: sudo apt install gdb")

    try:
        scope = int(pathlib.Path("/proc/sys/kernel/yama/ptrace_scope").read_text().strip())
        if scope > 0 and os.geteuid() != 0:
            issues.append(
                f"ptrace_scope={scope}，需要 root 权限。"
                "仅在明确授权后使用 sudo 捕获；无需修改系统 ptrace 策略"
            )
    except (OSError, ValueError):
        pass

    return issues


def _find_wechat_pid() -> int:
    """查找微信主进程 PID。"""
    for pid_str in os.listdir("/proc"):
        if not pid_str.isdigit():
            continue
        pid = int(pid_str)
        try:
            exe = os.readlink(f"/proc/{pid}/exe")
            if exe.endswith("/wechat"):
                return pid
        except (OSError, PermissionError):
            continue
    raise CaptureError("微信未运行，请先启动微信")


def _find_wechat_binary(pid: int) -> pathlib.Path:
    """从 /proc/pid/exe 获取微信二进制路径。"""
    try:
        return pathlib.Path(os.readlink(f"/proc/{pid}/exe"))
    except OSError:
        for candidate in [pathlib.Path("/opt/wechat/wechat"), pathlib.Path("/usr/bin/wechat")]:
            if candidate.exists():
                return candidate
        raise CaptureError("未找到微信二进制文件")


def _check_tracer(pid: int) -> None:
    """检查进程是否已被其他调试器附加。"""
    try:
        status = pathlib.Path(f"/proc/{pid}/status").read_text()
        for line in status.splitlines():
            if line.startswith("TracerPid:"):
                tracer = int(line.split(":")[1].strip())
                if tracer != 0:
                    raise CaptureError(
                        f"微信进程已被 PID={tracer} 调试，请先关闭其他调试器"
                    )
    except OSError:
        pass


def capture_passphrase(pid: int | None = None, timeout: int = 120) -> str:
    """通过 GDB 断点捕获微信数据库 passphrase。

    需要用户在微信中退出登录并重新登录来触发断点。

    Args:
        pid: 微信主进程 PID（None 则自动检测）
        timeout: 等待登录的超时秒数

    Returns:
        64 字符的 hex 字符串（32 字节 passphrase）

    Raises:
        CaptureError: 捕获失败
    """
    if pid is None:
        pid = _find_wechat_pid()

    binary_path = _find_wechat_binary(pid)
    _check_tracer(pid)

    # ELF 分析：找断点虚拟地址
    hook_va = find_hook_offset(binary_path)
    base_addr = find_runtime_base(pid, binary_path)
    breakpoint_addr = base_addr + hook_va

    logger.info(f"微信 PID={pid}, binary={binary_path}")
    logger.info(f"断点地址: base=0x{base_addr:X} + offset=0x{hook_va:X} = 0x{breakpoint_addr:X}")

    # 生成 GDB 脚本
    with tempfile.TemporaryDirectory(prefix="wechat-key-") as tmpdir:
        script_path = pathlib.Path(tmpdir) / "capture.gdb"
        script_content = _GDB_SCRIPT_TEMPLATE.format(
            pid=pid,
            breakpoint_addr=breakpoint_addr,
        )
        script_path.write_text(script_content)

        gdb_binary = shutil.which("gdb")
        if not gdb_binary:
            raise CaptureError("未安装 GDB；未启动任何捕获进程")
        try:
            proc = subprocess.run(
                [gdb_binary, "-q", "--nx", "-batch", "-x", str(script_path)],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            # subprocess.run kills and reaps only its own child on timeout.
            # Never signal WeChat or unrelated debugger processes by name.
            raise CaptureError(
                f"等待 {timeout} 秒后超时。请确保在微信中退出登录并重新登录。"
            ) from None

    if proc.returncode != 0:
        raise CaptureError("GDB 子进程未成功完成；内部输出不回显")
    combined = proc.stdout + "\n" + proc.stderr

    if "Operation not permitted" in combined or "ptrace" in combined.lower():
        raise CaptureError(
            "GDB 无法附加到微信进程；仅在明确授权后使用 sudo 捕获，勿修改全局 ptrace 策略"
        )

    match = re.search(r"WECHAT_PASSPHRASE=([0-9a-fA-F]{64})", combined)
    if match:
        passphrase = match.group(1).lower()
        logger.info("passphrase 捕获成功")
        return passphrase

    error_match = re.search(r"CAPTURE_ERROR=(.*)", combined)
    if error_match:
        # Child diagnostics may contain captured memory; do not relay them.
        raise CaptureError("GDB 捕获失败；内部诊断已隐藏以免泄露敏感材料")

    raise CaptureError("未能捕获 passphrase，断点可能未触发。请确保重新登录了微信。")


def default_passphrase_file() -> str:
    """One cache configuration source, shared by every command and the shell wrapper."""
    return _absolute(os.environ.get("WCDB_PASSPHRASE_FILE") or os.path.join(
        os.environ.get("WCD_PASS_DIR") or os.path.expanduser("~/.wcdb-key-tool"),
        "wechat-passphrase.json",
    ))


def _secret_bytes(value: str) -> bytes:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-fA-F]{64}", value) is None:
        raise ValueError("秘密字段必须是 32 字节十六进制；内容不回显")
    return bytes.fromhex(value)


def load_passphrase(path: str) -> str | None:
    try:
        data = _read_private_json(path)
    except FileNotFoundError:
        return None
    value = data.get("passphrase")
    _secret_bytes(value)
    return value


def save_passphrase(passphrase: str, path: str) -> None:
    _secret_bytes(passphrase)
    _write_private_json(path, {"passphrase": passphrase})
    logger.info("passphrase 已保存到配置的私有缓存（不输出秘密内容）")


# ============================================================
# PBKDF2 Key Derivation
# ============================================================

def _derive_keys_from_passphrase(
    passphrase: bytes,
    db_files: list,
    salt_to_dbs: dict,
) -> dict:
    """用 passphrase 通过 PBKDF2 派生所有数据库的 enc_key。

    Args:
        passphrase: 32 字节 passphrase（从 GDB 捕获）
        db_files: collect_db_files() 返回的数据库列表
        salt_to_dbs: salt -> db_names 映射

    Returns:
        key_map: {salt_hex: enc_key_hex, ...}，验证通过的密钥
    """
    key_map: dict[str, str] = {}
    total = len(salt_to_dbs)
    for i, salt_hex in enumerate(salt_to_dbs):
        salt = bytes.fromhex(salt_hex)
        enc_key = hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, dklen=KEY_SZ)
        pages = [page1 for _rel, _path, _sz, s, page1 in db_files if s == salt_hex]
        if pages and all(verify_enc_key(enc_key, page1) for page1 in pages):
            key_map[salt_hex] = enc_key.hex()
        if (i + 1) % 5 == 0 or i == total - 1:
            _print(f"  PBKDF2 派生: {i + 1}/{total} ({len(key_map)} 验证通过)")
    return key_map


# ============================================================
# Key helpers
# ============================================================

def _strip_key_metadata(keys: dict) -> dict:
    """移除以下划线开头的元数据字段。"""
    return {k: v for k, v in keys.items() if not k.startswith("_")}


def _key_path_variants(rel_path: str) -> list[str]:
    """生成同一路径的多种分隔符表示，兼容 Windows/Linux JSON key。"""
    normalized = rel_path.replace("\\", "/")
    variants: list[str] = []
    for candidate in (
        rel_path,
        normalized,
        normalized.replace("/", "\\"),
        normalized.replace("/", os.sep),
    ):
        if candidate not in variants:
            variants.append(candidate)
    return variants


def _get_key_info(keys: dict, rel_path: str) -> dict | None:
    """按相对路径查找数据库密钥，自动兼容不同平台分隔符。"""
    if ".." in rel_path.replace("\\", "/").split("/"):
        return None
    for candidate in _key_path_variants(rel_path):
        if candidate in keys and not candidate.startswith("_"):
            return keys[candidate]
    return None


def _save_results(
    db_files: list,
    salt_to_dbs: dict,
    key_map: dict,
    db_dir: str,
    out_file: str,
) -> None:
    """Only persist a complete, page-1-verified key set into a private file."""
    _reject_overlap(db_dir, out_file)
    if not db_files or set(key_map) != set(salt_to_dbs):
        raise RuntimeError("密钥集合不完整；拒绝保存部分成功结果")
    for _rel, _path, _size, salt, first in db_files:
        if not verify_enc_key(_secret_bytes(key_map[salt]), first):
            raise RuntimeError("数据库密钥校验失败；本次不保存")
    _print(f"\n{'=' * 60}")
    _print(f"结果: {len(key_map)}/{len(salt_to_dbs)} salts 找到密钥")

    result: dict = {}
    for rel, _path, sz, salt_hex, _page1 in db_files:
        result[rel] = {
            "enc_key": key_map[salt_hex],
            "salt": salt_hex,
            "size_mb": round(sz / 1024 / 1024, 1),
        }
        _print(f"  OK: {rel} ({sz / 1024 / 1024:.1f}MB)")

    result["_db_dir"] = db_dir
    _write_private_json(out_file, result)
    _print(f"\n密钥保存到: {out_file}")


# ============================================================
# Config Detection (auto-detect WeChat db dir)
# ============================================================

def auto_detect_db_dir() -> str | None:
    """自动检测微信数据库目录（db_storage）。"""
    home = pathlib.Path.home()

    # 常见位置
    candidates = [
        home / ".local/share/com.tencent.wechat" / "xwechat_files",
        home / ".xwechat",
        home / ".local/share/wechat",
    ]

    # 也扫描 xwechat_files 的子目录
    xwechat = home / ".local/share/com.tencent.wechat" / "xwechat_files"
    if xwechat.exists():
        # 子目录可能是 wxid_xxx/db_storage
        for sub in xwechat.iterdir():
            if sub.is_dir():
                db_cand = sub / "db_storage"
                if db_cand.exists():
                    candidates.insert(0, db_cand)

    # 用 glob 搜索常见模式
    for pattern in [
        str(home / ".local/share/com.tencent.wechat/xwechat_files/*/db_storage"),
        str(home / ".xwechat/*/db_storage"),
        str(home / "xwechat_files/*/db_storage"),
    ]:
        for match in glob.glob(pattern):
            p = pathlib.Path(match)
            if p.is_dir() and p not in candidates:
                candidates.insert(0, p)

    for candidate in candidates:
        p = pathlib.Path(candidate)
        if p.is_dir():
            # 检查是否包含 .db 文件
            for _ in p.rglob("*.db"):
                return str(p)

    return None


# ============================================================
# Database Decryption
# ============================================================

def _decrypt_page(enc_key: bytes, page_data: bytes, pgno: int) -> bytes:
    """Decode one authenticated SQLCipher4 page (the caller verifies its MAC)."""
    if len(page_data) != PAGE_SZ or pgno < 1:
        raise ValueError("SQLCipher 页面不完整或页号无效")
    start = SALT_SZ if pgno == 1 else 0
    iv = page_data[PAGE_SZ - RESERVE_SZ:PAGE_SZ - HMAC_SZ]
    plaintext = aes_cbc_decrypt(enc_key, iv, page_data[start:PAGE_SZ - RESERVE_SZ])
    return (SQLITE_HDR if pgno == 1 else b"") + plaintext + bytes(RESERVE_SZ)


def _validate_sqlite(path: str, expected_size: int) -> None:
    # immutable is safe ONLY here: a fresh, private, authenticated staging file,
    # never a live source/WAL database. It prevents verifier sidecar writes.
    with _regular_file(path, private=True) as source:
        if os.fstat(source.fileno()).st_size != expected_size:
            raise ValueError("解密后的数据库长度不匹配")
        connection = sqlite3.connect(
            f"file:/proc/self/fd/{source.fileno()}?mode=ro&immutable=1", uri=True,
        )
        try:
            if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("SQLite 完整性校验失败")
            page_size = connection.execute("PRAGMA page_size").fetchone()[0]
            page_count = connection.execute("PRAGMA page_count").fetchone()[0]
            if page_size != PAGE_SZ or page_count * page_size != expected_size:
                raise ValueError("SQLite 页大小/页数与输入集合不匹配")
        finally:
            connection.close()


def _decrypt_database(db_path: str, out_path: str, enc_key: bytes) -> bool:
    """Authenticate EVERY full page and validate SQLite before reporting success."""
    if len(enc_key) != KEY_SZ:
        raise ValueError("数据库密钥长度错误")
    made_output = False
    try:
        with _regular_file(db_path) as source:
            before = os.fstat(source.fileno())
            if before.st_size < PAGE_SZ or before.st_size % PAGE_SZ:
                raise ValueError("数据库必须由完整的 4096 字节页组成；禁止补零")
            page1 = source.read(PAGE_SZ)
            mac_key = _mac_key(enc_key, page1[:SALT_SZ])
            if not _verify_page(mac_key, page1, 1):
                raise ValueError("数据库 page 1 HMAC 校验失败")
            with _regular_file(out_path, "xb") as output:
                made_output = True
                for pgno in range(1, before.st_size // PAGE_SZ + 1):
                    page = page1 if pgno == 1 else source.read(PAGE_SZ)
                    if not _verify_page(mac_key, page, pgno):
                        raise ValueError(f"数据库 page {pgno} HMAC/整页校验失败")
                    output.write(_decrypt_page(enc_key, page, pgno))
                output.flush()
                os.fsync(output.fileno())
            if source.read(1) or _fingerprint(before) != _fingerprint(os.fstat(source.fileno())):
                raise ValueError("解密期间输入发生变化")
        _validate_sqlite(out_path, before.st_size)
        return True
    except BaseException:
        if made_output:
            with _directory(os.path.dirname(_absolute(out_path)), private=True) as parent:
                os.unlink(os.path.basename(out_path), dir_fd=parent)
        raise


def decrypt_all(db_dir: str, out_dir: str, keys_file: str) -> dict:
    """All-or-nothing generation: old files never mix with this complete input set."""
    db_dir, out_dir = _absolute(db_dir), _absolute(out_dir)
    _reject_overlap(db_dir, out_dir)
    keys = _strip_key_metadata(_read_private_json(keys_file))
    inventory = _scan_db_inventory(db_dir)
    summary = {"success": 0, "failed": 0, "total": len(inventory), "total_bytes": 0,
               "complete": False, "published": False, "backup_dir": None, "errors": []}
    with _publication_lock(out_dir) as parent:
        stage, owned = _new_stage(out_dir, parent)
        try:
            for rel, info in sorted(inventory.items()):
                try:
                    entry = _get_key_info(keys, rel)
                    if not isinstance(entry, dict) or "enc_key" not in entry:
                        raise ValueError("缺少数据库密钥")
                    _decrypt_database(os.path.join(db_dir, rel), os.path.join(stage, rel),
                                      _secret_bytes(entry["enc_key"]))
                    summary["success"] += 1
                    summary["total_bytes"] += info["size"]
                except (ValueError, OSError, RuntimeError, sqlite3.Error) as error:
                    summary["failed"] += 1
                    # Do not echo exceptions from native/JSON/SQLite data containing secrets.
                    summary["errors"].append({"path": rel, "error": type(error).__name__})
                    _print(f"[ERROR] 数据库验证失败: {rel} ({type(error).__name__})")
            if not summary["failed"]:
                if inventory != _scan_db_inventory(db_dir):
                    raise ValueError("解密前后输入集合或内容变化；不发布")
                actual = set(_scan_db_inventory(stage))
                if actual != set(inventory):
                    raise ValueError("候选输出集合与输入不一致；不发布")
                summary["backup_dir"] = _publish_directory(stage, out_dir, parent)
                summary["complete"] = summary["published"] = True
            _print(f"结果: {summary['success']} 验证通过, {summary['failed']} 失败, "
                   f"共 {summary['total']}；已发布={summary['published']}")
            return summary
        finally:
            _discard_stage(stage, owned, parent)



# ============================================================
# CLI
# ============================================================

def cmd_extract(args: argparse.Namespace) -> None:
    """Use one explicit private cache; capture is opt-in, never an error fallback."""
    db_dir = args.db_dir or auto_detect_db_dir()
    if not db_dir:
        raise ValueError("请使用 --db-dir 明确指定数据库目录")
    out_file = _absolute(args.output)
    pass_file = _absolute(args.passphrase_file)
    _reject_overlap(db_dir, out_file)
    _reject_overlap(db_dir, pass_file)
    if out_file == pass_file:
        raise ValueError("passphrase 缓存和派生密钥输出不得相同")
    # Check both write boundaries before capture or reuse, without chmod/chown.
    for path in (out_file, pass_file):
        with _directory(os.path.dirname(path), create=True, private=True) as parent:
            _existing_private(parent, os.path.basename(path))
    db_files, salt_to_dbs = collect_db_files(db_dir)
    _print(f"找到 {len(db_files)} 个数据库, {len(salt_to_dbs)} 个不同的 salt")
    if not args.recapture:
        try:
            existing = _strip_key_metadata(_read_private_json(out_file))
        except FileNotFoundError:
            existing = None
        if existing is not None:
            for rel, _path, _size, _salt, first in db_files:
                entry = _get_key_info(existing, rel)
                if (not isinstance(entry, dict) or "enc_key" not in entry
                        or not verify_enc_key(_secret_bytes(entry["enc_key"]), first)):
                    raise RuntimeError("既有密钥缓存不完整/已失效；本次退出，重新捕获须显式 --recapture --allow-capture")
            _print("[+] 缓存密钥对全部输入验证通过；不捕获、不回显秘密")
            if args.decrypt:
                cmd_decrypt_inner(db_dir, out_file, args.decrypt_output)
            return
    passphrase_hex = None if args.recapture else load_passphrase(pass_file)
    captured = passphrase_hex is None
    if captured:
        if not args.allow_capture:
            raise RuntimeError("需要新 passphrase；仅在操作员明确授权后使用 --allow-capture")
        issues = check_prerequisites()
        if issues:
            raise RuntimeError("GDB 捕获环境未就绪：" + "; ".join(issues))
        _print("请在微信中手动退出登录并重新登录；工具不会停止或重启微信。")
        passphrase_hex = capture_passphrase(timeout=args.timeout)
        _print("[+] passphrase 捕获成功（不输出秘密内容）")
    key_map = _derive_keys_from_passphrase(_secret_bytes(passphrase_hex), db_files, salt_to_dbs)
    if set(key_map) != set(salt_to_dbs):
        raise RuntimeError("passphrase 未能验证全部输入；缓存不自动覆盖/回退，重新捕获须显式 --recapture --allow-capture")
    _save_results(db_files, salt_to_dbs, key_map, db_dir, out_file)
    if captured:
        save_passphrase(passphrase_hex, pass_file)
    if args.decrypt:
        cmd_decrypt_inner(db_dir, out_file, args.decrypt_output)


def cmd_decrypt_inner(db_dir: str, keys_file: str, out_dir: str) -> dict:
    summary = decrypt_all(db_dir, out_dir, keys_file)
    if not summary["complete"] or not summary["published"]:
        raise RuntimeError(f"解密未发布：{summary['failed']}/{summary['total']} 个数据库失败")
    return summary


def cmd_decrypt(args: argparse.Namespace) -> None:
    db_dir = args.db_dir
    if not db_dir:
        db_dir = _read_private_json(args.keys).get("_db_dir")
    if not isinstance(db_dir, str) or not db_dir:
        raise ValueError("请使用 --db-dir 明确指定数据库目录")
    cmd_decrypt_inner(db_dir, args.keys, args.output)


def cmd_snapshot(args: argparse.Namespace) -> dict:
    """Stable copy -> complete decryption -> manifest -> one atomic publication."""
    if not args.source_quiescent:
        raise ValueError("必须由操作员先静止源数据库并显式 --source-quiescent；不自动停止微信")
    db_dir, destination = _absolute(args.db_dir), _absolute(args.output)
    _reject_overlap(db_dir, destination)
    _reject_overlap(db_dir, args.passphrase_file)
    _reject_overlap(destination, args.passphrase_file)
    with _directory(db_dir):
        pass
    with _publication_lock(destination) as parent:
        stage, owned = _new_stage(destination, parent)
        try:
            copy_dir = os.path.join(stage, "encrypted_copy")
            captured_at = copy_stable_databases(db_dir, copy_dir)
            keys_file = os.path.join(stage, "all_keys.json")
            cmd_extract(argparse.Namespace(
                db_dir=copy_dir, output=keys_file, passphrase_file=args.passphrase_file,
                timeout=args.timeout, recapture=args.recapture, allow_capture=args.allow_capture,
                decrypt=False, decrypt_output=None,
            ))
            out_dir = os.path.join(stage, "decrypted")
            summary = cmd_decrypt_inner(copy_dir, keys_file, out_dir)
            # The candidate name becomes the old backup on refresh; never persist it
            # as the default input for a later decrypt command.
            keys = _read_private_json(keys_file)
            keys["_db_dir"] = os.path.join(destination, "encrypted_copy")
            _write_private_json(keys_file, keys)
            files = [{"path": rel, "size": info["size"], "sha256": info["sha256"]}
                     for rel, info in sorted(_scan_db_inventory(out_dir).items())]
            manifest = {"schema_version": 1, "snapshot_id": uuid.uuid4().hex,
                        "captured_at": captured_at, "complete": True,
                        "consistency": "stable-db-only-verified", "files": files}
            _write_private_json(os.path.join(out_dir, ".wechat-ro-manifest.json"), manifest)
            backup = _publish_directory(stage, destination, parent)
            summary["backup_dir"] = backup
            _print(f"[+] 完整快照已发布: {os.path.join(destination, 'decrypted')}")
            if backup:
                _print(f"[+] 旧代私有备份保留: {backup}")
            _print("产物保持执行身份的 0700/0600 权限；DSH 服务身份的访问须另行安全配置，勿把 DSH 整体改为 root。")
            return summary
        finally:
            _discard_stage(stage, owned, parent)


def main() -> None:
    parser = argparse.ArgumentParser(description="wcdb-key-tool — 私有、完整代次的数据库快照")
    parser.add_argument("--verbose", "-v", action="store_true", help="显示非秘密诊断")
    sub = parser.add_subparsers(dest="command", required=True)
    extract_cmd = sub.add_parser("extract", help="提取/派生密钥；GDB 捕获必须显式选择")
    extract_cmd.add_argument("--db-dir", help="数据库目录（建议使用静止副本）")
    extract_cmd.add_argument("--output", default=".wcdb-key-tool/all_keys.json", help="私有密钥输出文件")
    extract_cmd.add_argument("--decrypt", action="store_true", help="提取后完整验证并解密")
    extract_cmd.add_argument("--decrypt-output", default="decrypted", help="解密目录")
    snapshot_cmd = sub.add_parser("snapshot", help="静止采集、验证、原子发布整个快照")
    snapshot_cmd.add_argument("--db-dir", required=True, help="操作员明确选择的源数据库目录")
    snapshot_cmd.add_argument("--output", required=True, help="快照根目录，其 decrypted 子目录供消费者读取")
    snapshot_cmd.add_argument("--source-quiescent", action="store_true", help="声明已手动静止源；仍会拒绝 sidecar/变化")
    for command in (extract_cmd, snapshot_cmd):
        command.add_argument("--passphrase-file", default=default_passphrase_file(), help="唯一私有 passphrase 缓存")
        command.add_argument("--timeout", type=int, default=120, help="显式捕获的超时秒数")
        command.add_argument("--allow-capture", action="store_true", help="明确允许本次 GDB 附加/登录捕获")
        command.add_argument("--recapture", action="store_true", help="显式忽略旧缓存；还需 --allow-capture")
    decrypt_cmd = sub.add_parser("decrypt", help="完整验证并原子发布解密副本")
    decrypt_cmd.add_argument("--db-dir", help="默认采用私有密钥文件的 _db_dir")
    decrypt_cmd.add_argument("--keys", default=".wcdb-key-tool/all_keys.json", help="私有密钥文件")
    decrypt_cmd.add_argument("--output", default="decrypted", help="解密目录")
    args = parser.parse_args()
    if getattr(args, "timeout", 1) <= 0:
        parser.error("--timeout 必须为正整数")
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    try:
        {"extract": cmd_extract, "decrypt": cmd_decrypt, "snapshot": cmd_snapshot}[args.command](args)
    except (ValueError, OSError, RuntimeError, sqlite3.Error) as error:
        # All entrypoint errors are classified, not data/native-output dumps.
        detail = str(error) if isinstance(error, (ValueError, RuntimeError)) else "请检查私有路径、权限和 SQLite 输入"
        _print(f"[ERROR] 本次未完成 ({type(error).__name__})：{detail}")
        sys.exit(1)


if __name__ == "__main__":
    main()
