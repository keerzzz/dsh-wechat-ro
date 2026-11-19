#!/usr/bin/env python3
"""Read authenticated WCDB keys from the already logged-in Linux client.

Only the statically inspected Linux WeChat 4.1.13.26 build below is supported.
The reader uses process_vm_readv, never a debugger, signal, or process dump.
Run --preflight without privileges to review the process and read budget. The
live command requires --allow-runtime-read and may be launched through pkexec.
After reading, a privileged helper drops to PKEXEC_UID/SUDO_UID before writing
the private key file. No key material is printed.

Layout evidence: the inspected setCipherKey entry at 0x87b3cf0 constructs a
CipherConfig at 0x87fa9c0. Its Data getters at 0x87c1260 and 0x87c1600 expose
size and buffer; the constructor and invoke method XOR the retained key with
the 32-byte constant at 0x1e2fe00. HMAC authentication, rather than a pointer
or an apparent key pattern, decides whether a recovered candidate is usable.
The existing Tencent WCDB CipherConfig source describes m_key/m_rawKey; this
binary's exact offsets and XOR transform were checked through disassembly.
"""
from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import pwd
import re
import stat
import struct
import sys
from collections.abc import Callable

import wcdb_key_tool as wcdb


BUILD_SHA256 = "2749535f299ba67feb8ef80cab898bb0531fa8f376b16f8a72db706811c84132"
BUILD_VERSION = "4.1.13.26"
CIPHER_VTABLE_VA = 0xAA1AB70
DATA_VTABLE_VA = 0xAA175D8
MASK_VA = 0x1E2FE00
OBJECT_SIZE = 0x1E0
KEY_FIELDS = (0x10, 0x90)
MAX_SCAN_BYTES = 1536 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024
KEY_LITERAL = re.compile(rb"[xX]'([0-9a-fA-F]{96})'")


def inspected_build(binary: pathlib.Path) -> dict:
    if hashlib.sha256(binary.read_bytes()).hexdigest() != BUILD_SHA256:
        raise RuntimeError("尚未验证此微信构建的运行时密钥布局；未读取进程内存")
    sections = wcdb._load_elf_sections(binary)

    def read_va(address: int, length: int) -> bytes:
        for section in sections.values():
            if section.addr <= address and address + length <= section.addr + len(section.data):
                return section.data[address - section.addr:address - section.addr + length]
        raise RuntimeError("受支持构建的静态地址未落在 ELF 节内")

    if read_va(0x87C1260, 5) != bytes.fromhex("488b4710c3"):
        raise RuntimeError("Data size getter 不匹配；未读取进程内存")
    if read_va(0x87C1600, 19) != bytes.fromhex("488b4f084885c9488d05728b5402480f45c1c3"):
        raise RuntimeError("Data buffer getter 不匹配；未读取进程内存")
    mask = read_va(MASK_VA, 32)
    if mask != read_va(0xD54960, 16) + read_va(0xD563C0, 16):
        raise RuntimeError("CipherConfig XOR 两条静态路径不匹配；未读取进程内存")
    return {"mask": mask, "cipher_vtable_va": CIPHER_VTABLE_VA, "data_vtable_va": DATA_VTABLE_VA}


def process_metadata(pid: int, include_anonymous: bool = True) -> dict:
    proc = pathlib.Path("/proc") / str(pid)
    binary = pathlib.Path(os.readlink(proc / "exe"))
    if binary.name != "wechat":
        raise RuntimeError("指定 PID 不是微信主程序；未读取进程内存")
    status = {}
    for line in (proc / "status").read_text().splitlines():
        name, _, value = line.partition(":")
        status[name] = value.strip()
    uid = int(status["Uid"].split()[0])
    if status.get("TracerPid") != "0":
        raise RuntimeError("微信已被调试器占用；未读取进程内存")
    maps = []
    biases = set()
    for line in (proc / "maps").read_text().splitlines():
        parts = line.split(None, 5)
        start, end = (int(value, 16) for value in parts[0].split("-"))
        name = parts[5] if len(parts) == 6 else ""
        if name == str(binary) and int(parts[2], 16) == 0:
            biases.add(start)
        if parts[1] == "rw-p" and (name == "[heap]" or (include_anonymous and not name)):
            maps.append((start, end, name == "[heap]"))
    if len(biases) != 1 or not maps:
        raise RuntimeError("未确定唯一 ELF 基址和可读 heap/匿名区域；未读取进程内存")
    maps.sort(key=lambda region: (not region[2], region[0]))
    # Field 22 after the parenthesized command is the process birth timestamp.
    born = (proc / "stat").read_text().rsplit(")", 1)[1].split()[19]
    return {"pid": pid, "uid": uid, "binary": binary, "base": next(iter(biases)),
            "regions": [(start, end) for start, end, _heap in maps],
            "heap_bytes": sum(end - start for start, end, heap in maps if heap),
            "anonymous_bytes": sum(end - start for start, end, heap in maps if not heap),
            "birth": born}


def invoking_identity(process_uid: int) -> tuple[int, int]:
    if os.geteuid() != 0:
        if os.geteuid() != process_uid:
            raise PermissionError("调用者与微信账号所属用户不一致")
        return process_uid, pwd.getpwuid(process_uid).pw_gid
    value = os.environ.get("PKEXEC_UID") or os.environ.get("SUDO_UID")
    if value is None or not value.isdecimal() or int(value) != process_uid or process_uid == 0:
        raise PermissionError("提权助手必须来自微信所属用户的 pkexec/sudo 请求")
    return process_uid, pwd.getpwuid(process_uid).pw_gid


def encrypted_first_pages(
    db_dir: pathlib.Path, owner_uid: int, selected_paths: list[str] | None = None,
) -> list[tuple[str, int, bytes]]:
    if not db_dir.is_absolute() or db_dir.is_symlink() or db_dir.stat().st_uid != owner_uid:
        raise PermissionError("数据库目录必须属于微信进程用户且不是符号链接")
    requested = None
    if selected_paths is not None:
        requested = set(selected_paths)
        if not requested or len(requested) != len(selected_paths):
            raise ValueError("指定数据库集合不得为空或重复")
        for name in requested:
            path = pathlib.PurePosixPath(name)
            if (path.is_absolute() or ".." in path.parts or "\\" in name
                    or path.as_posix() != name or path.suffix != ".db"):
                raise ValueError("指定数据库必须是规范的相对 .db 路径")
    pages = []
    for root, directories, files in os.walk(db_dir, followlinks=False):
        if any((pathlib.Path(root) / name).is_symlink() for name in directories):
            raise ValueError("数据库目录含符号链接；未读取进程内存")
        for name in sorted(files):
            if not name.endswith(".db"):
                continue
            path = pathlib.Path(root) / name
            relative = str(path.relative_to(db_dir))
            if requested is not None and relative not in requested:
                continue
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_size < wcdb.PAGE_SZ:
                    raise ValueError("数据库不是所属用户的完整普通文件")
                first = os.read(fd, wcdb.PAGE_SZ)
            finally:
                os.close(fd)
            if len(first) != wcdb.PAGE_SZ or first.startswith(wcdb.SQLITE_HDR):
                raise ValueError("密钥读取只接受完整加密数据库第一页")
            pages.append((relative, info.st_size, first))
    if requested is not None and {name for name, _size, _page in pages} != requested:
        raise ValueError("指定数据库集合不完整；未读取进程内存")
    if not pages:
        raise ValueError("指定目录没有加密 .db 数据库")
    return pages


def scan_cipher_objects(
    regions: list[tuple[int, int]], read_memory: Callable[[int, int], bytes],
    cipher_vtable: int, data_vtable: int, mask: bytes,
    pages: list[tuple[str, int, bytes]], *, max_scan_bytes: int = MAX_SCAN_BYTES,
    chunk_size: int = CHUNK_SIZE,
) -> tuple[dict[bytes, bytes], dict]:
    """Scan exact CipherConfig objects; return only page-1-authenticated keys."""
    if len(mask) != 32 or max_scan_bytes <= 0 or chunk_size < 8:
        raise ValueError("扫描参数无效")
    by_salt = {}
    for _name, _size, page in pages:
        if len(page) != wcdb.PAGE_SZ:
            raise ValueError("第一页长度不完整")
        by_salt.setdefault(page[:16], []).append(page)
    if not by_salt:
        raise ValueError("未提供认证页面")
    keys = {}
    stats = {"scan_bytes": 0, "object_count": 0, "payload_count": 0,
             "candidate_count": 0, "matched_salts": 0, "read_errors": 0}
    seen_objects = set()
    seen_payloads = set()
    pattern = struct.pack("<Q", cipher_vtable)

    def contained(address: int, length: int) -> bool:
        return length > 0 and any(start <= address and address + length <= end for start, end in regions)

    def exact_read(address: int, length: int) -> bytes:
        if not contained(address, length):
            return b""
        data = read_memory(address, length)
        if len(data) != length:
            stats["read_errors"] += 1
            return b""
        return data

    def authenticate(decoded: bytes) -> None:
        if decoded in seen_payloads:
            return
        seen_payloads.add(decoded)
        stats["candidate_count"] += 1
        if stats["candidate_count"] > 128:
            raise RuntimeError("准确 CipherConfig 候选超过本次上限；未保存密钥")
        literal = KEY_LITERAL.fullmatch(decoded)
        if literal is not None:
            key_salt = bytes.fromhex(literal.group(1).decode("ascii"))
            salt = key_salt[32:]
            if salt in by_salt and all(wcdb.verify_enc_key(key_salt[:32], page) for page in by_salt[salt]):
                keys[salt] = key_salt[:32]
            return
        if len(decoded) != 32:
            return
        remaining = [salt for salt in by_salt if salt not in keys]
        for salt in remaining:
            if all(wcdb.verify_enc_key(decoded, page) for page in by_salt[salt]):
                keys[salt] = decoded
        remaining = [salt for salt in remaining if salt not in keys]
        if not remaining:
            return
        # Prove one passphrase candidate before paying the KDF cost for all DBs.
        first_salt = remaining[0]
        key = hashlib.pbkdf2_hmac("sha512", decoded, first_salt, 256000, dklen=32)
        if not all(wcdb.verify_enc_key(key, page) for page in by_salt[first_salt]):
            return
        keys[first_salt] = key
        for salt in remaining[1:]:
            key = hashlib.pbkdf2_hmac("sha512", decoded, salt, 256000, dklen=32)
            if all(wcdb.verify_enc_key(key, page) for page in by_salt[salt]):
                keys[salt] = key

    for start, end in regions:
        address = start
        tail = b""
        while address < end and stats["scan_bytes"] < max_scan_bytes:
            size = min(chunk_size, end - address, max_scan_bytes - stats["scan_bytes"])
            data = read_memory(address, size)
            stats["scan_bytes"] += size
            if len(data) != size:
                stats["read_errors"] += 1
                tail = b""
                address += size
                continue
            chunk = tail + data
            chunk_base = address - len(tail)
            position = chunk.find(pattern)
            while position >= 0:
                obj_address = chunk_base + position
                position = chunk.find(pattern, position + 1)
                if obj_address % 8 or obj_address in seen_objects:
                    continue
                seen_objects.add(obj_address)
                obj = exact_read(obj_address, OBJECT_SIZE)
                if not obj or obj[:8] != pattern or struct.unpack_from("<II", obj, 0x1D8) != (4096, 4):
                    continue
                stats["object_count"] += 1
                for offset in KEY_FIELDS:
                    vtable, pointer, length = struct.unpack_from("<QQQ", obj, offset)
                    if vtable != data_vtable or length not in (32, 99):
                        continue
                    blob = exact_read(pointer, length)
                    if not blob:
                        continue
                    # Avoid accepting bytes from a concurrent key-field change.
                    if exact_read(obj_address + offset, 24) != obj[offset:offset + 24]:
                        continue
                    stats["payload_count"] += 1
                    authenticate(bytes(value ^ mask[index % 32] for index, value in enumerate(blob)))
                    if len(keys) == len(by_salt):
                        stats["matched_salts"] = len(keys)
                        return keys, stats
            tail = chunk[-7:]
            address += size
    stats["matched_salts"] = len(keys)
    return keys, stats


class _Iovec(ctypes.Structure):
    _fields_ = [("iov_base", ctypes.c_void_p), ("iov_len", ctypes.c_size_t)]


def runtime_reader(pid: int, check_cancelled: Callable[[], None] = lambda: None) -> Callable[[int, int], bytes]:
    libc = ctypes.CDLL(None, use_errno=True)
    readv = libc.process_vm_readv
    readv.argtypes = [ctypes.c_int, ctypes.POINTER(_Iovec), ctypes.c_ulong,
                     ctypes.POINTER(_Iovec), ctypes.c_ulong, ctypes.c_ulong]
    readv.restype = ctypes.c_ssize_t

    def read(address: int, length: int) -> bytes:
        check_cancelled()
        buf = ctypes.create_string_buffer(length)
        local = _Iovec(ctypes.cast(buf, ctypes.c_void_p), length)
        remote = _Iovec(address, length)
        count = readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
        if count >= 0:
            return buf.raw[:count]
        error = ctypes.get_errno()
        if error in (errno.EPERM, errno.EACCES):
            raise PermissionError("process_vm_readv 被系统拒绝；需由本人通过 pkexec 授权此助手")
        if error == errno.ESRCH:
            raise RuntimeError("微信进程已退出；未保存密钥")
        if error == errno.EFAULT:
            return b""
        raise OSError(error, "process_vm_readv 失败；内部数据不回显")

    return read


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", required=True, type=int)
    parser.add_argument("--db-dir", type=pathlib.Path)
    parser.add_argument("--database", action="append", help="重复指定本次需要的相对 .db 路径")
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--allow-runtime-read", action="store_true")
    parser.add_argument("--heap-only", action="store_true")
    parser.add_argument("--max-scan-bytes", type=int, default=MAX_SCAN_BYTES)
    parser.add_argument('--caller-pid', type=int)
    parser.add_argument('--caller-birth')
    args = parser.parse_args()
    def check_cancelled():
        if args.caller_pid is None and args.caller_birth is None:
            return
        if args.caller_pid is None or not (args.caller_birth or '').isdecimal():
            raise ValueError('调用者身份参数无效')
        try:
            birth = (pathlib.Path('/proc') / str(args.caller_pid) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        except OSError:
            raise RuntimeError('历史导入已取消；未保存密钥') from None
        if birth != args.caller_birth:
            raise RuntimeError('历史导入调用者已改变；未保存密钥')
    check_cancelled()
    if args.max_scan_bytes <= 0 or args.max_scan_bytes > MAX_SCAN_BYTES:
        raise ValueError("扫描预算必须在 1..1536 MiB 范围内")
    meta = process_metadata(args.pid, not args.heap_only)
    identity = invoking_identity(meta["uid"])
    layout = inspected_build(meta["binary"])
    summary = {"status": "PREFLIGHT", "version": BUILD_VERSION, "pid": args.pid,
               "uid": meta["uid"], "build_sha256": BUILD_SHA256,
               "heap_bytes": meta["heap_bytes"], "anonymous_bytes": meta["anonymous_bytes"],
               "scan_budget_bytes": args.max_scan_bytes, "chunk_bytes": CHUNK_SIZE,
               "payload_lengths": [32, 99], "candidate_authentication": "page1-hmac-sha512",
               "writes_original_db": False, "stops_wechat": False,
               "requires_system_privilege": os.geteuid() != 0 and
               pathlib.Path("/proc/sys/kernel/yama/ptrace_scope").read_text().strip() != "0"}
    if args.preflight:
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    if not args.allow_runtime_read or args.db_dir is None or args.output is None:
        raise ValueError("请先审阅 --preflight，再提供 --allow-runtime-read、--db-dir 和私有 --output")
    if not args.output.is_absolute() or args.output.exists():
        raise ValueError("密钥输出须为尚不存在的绝对路径私有文件")
    if args.db_dir == args.output or args.db_dir in args.output.parents:
        raise ValueError("密钥输出必须位于原数据库目录之外")
    pages = encrypted_first_pages(args.db_dir, identity[0], args.database)
    keys, counts = scan_cipher_objects(meta["regions"], runtime_reader(args.pid, check_cancelled),
                                      meta["base"] + layout["cipher_vtable_va"],
                                      meta["base"] + layout["data_vtable_va"], layout["mask"],
                                      pages, max_scan_bytes=args.max_scan_bytes)
    after = process_metadata(args.pid, not args.heap_only)
    if meta["birth"] != after["birth"] or meta["binary"] != after["binary"] or meta["uid"] != after["uid"]:
        raise RuntimeError("读取期间微信进程身份发生变化；未保存密钥")
    if set(keys) != {page[:16] for _name, _size, page in pages}:
        print(json.dumps({"status": "NO_COMPLETE_KEY_SET", **counts, "database_count": len(pages)}, ensure_ascii=False))
        return 2
    product = {name: {"enc_key": keys[page[:16]].hex(), "salt": page[:16].hex(),
                      "size_mb": round(size / 1024 / 1024, 1)} for name, size, page in pages}
    product["_db_dir"] = str(args.db_dir)
    check_cancelled()
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(identity[1])
        os.setuid(identity[0])
    wcdb._write_private_json(str(args.output), product)
    print(json.dumps({"status": "AUTHENTICATED_KEYS_SAVED", **counts,
                      "database_count": len(pages), "output_uid": os.geteuid()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"status": "FAILED", "reason": str(error)}, ensure_ascii=False))
        sys.exit(1)
