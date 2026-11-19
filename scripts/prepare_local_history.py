#!/usr/bin/env python3
"""Prepare this user's Linux WeChat history without interrupting the client.

--preflight reads only process/build metadata and the database file inventory.
--prepare invokes the reviewed key helper through the OS authentication prompt,
then creates a private committed-WAL snapshot as the ordinary desktop user.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import stat
import fcntl
import build_content_index

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vendor"))
import wcdb_live_snapshot
import wcdb_runtime_keys
import wcdb_key_tool


def current_process() -> int:
    """Resolve one untraced main client owned by this desktop user."""
    matches = []
    for process in Path('/proc').iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if Path(os.readlink(process / 'exe')).name == 'wechat' and process.stat().st_uid == os.geteuid():
                matches.append(int(process.name))
        except OSError:
            continue
    if len(matches) != 1:
        raise ValueError('LOCAL_HISTORY_CLIENT_REQUIRED')
    return matches[0]


def source_stamp(source: Path, paths: list[str]) -> str:
    """Detect DB/WAL changes without hashing every database on each check."""
    inventory = []
    for name in paths:
        for suffix in ('', '-wal', '-journal'):
            path = source / (name + suffix)
            try:
                stream = wcdb_key_tool._regular_file(str(path))
                opened = stream.__enter__()
                fd = opened.fileno()
            except FileNotFoundError:
                inventory.append([name + suffix, None])
                continue
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
                    raise PermissionError('微信数据文件身份改变')
                header = os.read(fd, 32) if suffix == '-wal' else b''
                inventory.append([name + suffix, info.st_dev, info.st_ino, info.st_size,
                                  info.st_mtime_ns, info.st_ctime_ns, header.hex()])
            finally:
                stream.__exit__(None, None, None)
    return hashlib.sha256(json.dumps(inventory).encode()).hexdigest()


def reusable_keys(state: Path, source: Path, paths: list[str]) -> bool:
    keys = wcdb_key_tool._read_private_json(str(state / 'runtime-keys.json'))
    if keys.get('_db_dir') != str(source):
        return False
    for name in paths:
        entry = wcdb_key_tool._get_key_info(keys, name)
        if not isinstance(entry, dict) or 'enc_key' not in entry:
            return False
        with wcdb_key_tool._regular_file(str(source / name)) as database:
            page = database.read(wcdb_key_tool.PAGE_SZ)
        if not wcdb_key_tool.verify_enc_key(wcdb_key_tool._secret_bytes(entry['enc_key']), page):
            return False
    return True


def retain_generations(registry: Path, record: dict, consumer: str, pinned: str | None):
    """Keep live task pins and the last two copies; runs under the source lock."""
    consumer = str(uuid.UUID(consumer))
    if pinned is not None and not re.fullmatch('[a-f0-9]{32}', pinned):
        raise ValueError('历史副本代次参数无效')
    lease_file = registry / 'consumers.json'
    leases = wcdb_key_tool._read_private_json(str(lease_file)) if lease_file.exists() else {}
    active = {}
    for key, value in leases.items():
        try:
            pid = value['pid']
            if type(pid) is not int or not isinstance(value['birth'], str) or not isinstance(value['pins'], list) or any(not re.fullmatch('[a-f0-9]{32}', pin) for pin in value['pins']):
                raise ValueError('历史副本占用记录无效')
            birth = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            if birth == value['birth']:
                active[key] = value
        except FileNotFoundError:
            pass
    pid = os.getppid()
    birth = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
    active[consumer] = {'pid': pid, 'birth': birth, 'pins': list({record['snapshot_id'], *([pinned] if pinned else [])})}
    if len(active) > 128:
        raise ValueError('同时占用历史副本的任务过多')
    wcdb_key_tool._write_private_json(str(lease_file), active)
    pins = {pin for lease in active.values() for pin in lease['pins']}
    generations = registry / 'generations'
    candidates = sorted((path for path in generations.iterdir() if re.fullmatch('snapshot-[a-f0-9]{32}', path.name)), key=lambda path: path.stat(follow_symlinks=False).st_mtime_ns, reverse=True)
    for path in candidates[2:]:
        with wcdb_key_tool._directory(str(path), private=True):
            manifest = wcdb_key_tool._read_private_json(str(path / 'decrypted/.wechat-ro-manifest.json'))
        if manifest['snapshot_id'] not in pins:
            with wcdb_key_tool._directory(str(generations), private=True) as parent:
                wcdb_key_tool._existing_private(parent, path.name, directory=True)
                shutil.rmtree(path.name, dir_fd=parent)


def managed_history(command: str, emit=print, consumer=None, pinned=None) -> dict:
    """Owner-authorized import or refresh. Refresh never reads process memory."""
    if command not in ('import', 'refresh'):
        raise ValueError('未知历史操作')
    registry = Path.home() / '.wechat-ro-local-history'
    registry.mkdir(mode=0o700, exist_ok=True)
    with wcdb_key_tool._directory(str(registry), private=True) as parent:
        wcdb_key_tool._existing_private(parent, 'source.lock')
        fd = os.open('source.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    with os.fdopen(fd, 'r+') as lock:
        wcdb_key_tool._check_private(os.fstat(lock.fileno()))
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        record_file = registry / 'source.json'
        record = wcdb_key_tool._read_private_json(str(record_file)) if record_file.exists() else None
        pid = current_process()
        source, paths, plan = preparation_plan(pid, known_build=record.get('build_identity') if record and command == 'refresh' else None)
        if record is not None and (record.get('account_ref') != plan['account_ref'] or record.get('source') != str(source)):
            if command == 'refresh':
                raise ValueError('当前微信账号已改变，请重新导入')
            record = None
        if command == 'refresh' and record:
            # An installed upgrade keeps refreshing the already-authorized scope.
            # The next explicit import expands it and authenticates new keys.
            stored_keys = wcdb_key_tool._read_private_json(str(Path(record['state']) / 'runtime-keys.json'))
            paths = [name for name in paths if name in stored_keys]
        if record is not None and command == 'import' and not reusable_keys(Path(record['state']), source, paths):
            record = None
        if record is None:
            if command != 'import':
                raise ValueError('请先导入微信历史')
            candidates = []
            for candidate in Path.home().glob('.wechat-ro-history-*'):
                try:
                    info = candidate.stat()
                    if candidate.is_symlink() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                        continue
                    if reusable_keys(candidate, source, paths):
                        candidates.append(candidate)
                except (OSError, ValueError):
                    continue
            state = max(candidates, key=lambda value: value.stat().st_mtime_ns) if candidates else Path(tempfile.mkdtemp(prefix='.wechat-ro-history-', dir=Path.home()))
            if not candidates:
                pkexec = shutil.which('pkexec')
                if pkexec is None:
                    raise RuntimeError('系统认证入口不可用')
                emit(json.dumps({'phase': 'authenticating'}), flush=True)
                birth = (Path('/proc') / str(os.getpid()) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
                capture = subprocess.run([pkexec, '/usr/bin/python3', wcdb_runtime_keys.__file__, '--pid', str(pid),
                    '--db-dir', str(source), '--output', str(state / 'runtime-keys.json'), '--allow-runtime-read',
                    '--caller-pid', str(os.getpid()), '--caller-birth', birth]
                    + [item for name in paths for item in ('--database', name)], capture_output=True, text=True)
                if capture.returncode != 0:
                    raise PermissionError('系统认证或密钥读取未完成')
            record = {'account_ref': plan['account_ref'], 'source': str(source), 'state': str(state)}
        state = Path(record['state'])
        with wcdb_key_tool._directory(str(state), private=True):
            pass
        keys = wcdb_key_tool._read_private_json(str(state / 'runtime-keys.json'))
        if keys.get('_db_dir') != str(source) or any(name not in keys for name in paths):
            raise ValueError('当前账号的密钥集合不完整，请重新导入')
        stamp = source_stamp(source, paths)
        content_cache = Path.home() / '.local/share/dsh-wechat-ro/content-history' / record['account_ref']
        content_stamp = str(content_cache.stat().st_mtime_ns) if content_cache.exists() else 'none'
        existing = record.get('snapshot_directory')
        if existing is not None:
            snapshot = Path(existing)
            if snapshot.parent.parent != registry / 'generations' or snapshot.name != 'decrypted' or not re.fullmatch(r'snapshot-[a-f0-9]{32}', snapshot.parent.name):
                raise ValueError('历史副本记录路径无效')
            with wcdb_key_tool._directory(str(snapshot), private=True):
                pass
            manifest = wcdb_key_tool._read_private_json(str(snapshot / '.wechat-ro-manifest.json'))
            if not manifest.get('complete') or manifest.get('snapshot_id') != record.get('snapshot_id') or record.get('build_sha256') != wcdb_runtime_keys.BUILD_SHA256:
                raise ValueError('历史副本记录不匹配')
            indexed = 'sns/sns.db' in paths or 'favorite/favorite.db' in paths
            if record.get('stamp') == stamp and record.get('content_stamp', 'none') == content_stamp and (not indexed or record.get('content_index_version') == build_content_index.VERSION):
                if consumer:
                    retain_generations(registry, record, consumer, pinned)
                return {**record, 'changed': False, 'database_count': len(paths)}
        generations = registry / 'generations'
        generations.mkdir(mode=0o700, exist_ok=True)
        destination = generations / ('snapshot-' + uuid.uuid4().hex)
        emit(json.dumps({'phase': 'updating', 'databaseCount': len(paths)}), flush=True)
        result = wcdb_live_snapshot.snapshot_live(str(source), str(destination), str(state / 'runtime-keys.json'),
                                                  selected_paths=paths, previous_snapshot=existing)
        if 'sns/sns.db' in paths or 'favorite/favorite.db' in paths:
            manifest_file = destination / 'decrypted/.wechat-ro-manifest.json'
            manifest = wcdb_key_tool._read_private_json(str(manifest_file))
            derived = build_content_index.build_index(destination / 'decrypted', Path(existing) if existing else None,
                {item['path'] for item in manifest['databases'] if item.get('reused')}, record['account_ref'], media_root=source.parent / 'msg')
            content_file = destination / 'decrypted/content/content.db'
            with content_file.open('rb') as content:
                content_hash = hashlib.file_digest(content, 'sha256').hexdigest()
            manifest['files'].append({'path': 'content/content.db', 'size': content_file.stat().st_size, 'sha256': content_hash})
            manifest['content_index'] = derived
            manifest['account_ref'] = record['account_ref']
            wcdb_key_tool._write_private_json(str(manifest_file), manifest)
            record['content_sources'] = ['moments', 'favorites', 'miniprogram', 'voice', 'image', 'video']
            record['content_index_version'] = build_content_index.VERSION
        record.update({'stamp': stamp, 'content_stamp': content_stamp, 'snapshot_directory': str(destination / 'decrypted'),
                       'captured_at': wcdb_live_snapshot._now(), 'snapshot_id': result['snapshot_id'],
                       'database_count': len(paths), 'build_sha256': plan['client_build_sha256'],
                       'build_identity': plan['client_build_identity']})
        wcdb_key_tool._write_private_json(str(record_file), record)
        if consumer:
            retain_generations(registry, record, consumer, pinned)
        return {**record, 'changed': True}


def preparation_plan(pid: int, known_build=None) -> tuple[Path, list[str], dict]:
    if os.geteuid() == 0:
        raise PermissionError("历史准备入口应由微信所属桌面用户运行")
    meta = wcdb_runtime_keys.process_metadata(pid)
    if meta["uid"] != os.geteuid():
        raise PermissionError("微信进程与当前桌面用户不一致")
    binary = meta['binary'].stat()
    identity = [str(meta['binary']), binary.st_dev, binary.st_ino, binary.st_size, binary.st_mtime_ns, binary.st_ctime_ns]
    if known_build != identity:
        with wcdb_key_tool._regular_file(str(meta['binary'])) as executable:
            if hashlib.file_digest(executable, 'sha256').hexdigest() != wcdb_runtime_keys.BUILD_SHA256:
                raise RuntimeError('此微信构建尚未验证，请使用已支持版本')
    roots = list((Path.home() / "Documents/xwechat_files").glob("*/db_storage"))
    if len(roots) != 1:
        raise ValueError("需要在界面选择一个微信账号；当前未检测到唯一账号")
    source = roots[0]
    if source.is_symlink() or source.resolve() != source or source.stat().st_uid != os.geteuid():
        raise ValueError("当前账号目录身份无效")
    paths = ["contact/contact.db", "session/session.db"] + sorted(
        str(path.relative_to(source)) for path in (source / "message").glob("*.db")
        if re.fullmatch(r"(?:biz_)?message_\d+\.db", path.name)
    )
    paths += [name for name in ('sns/sns.db', 'favorite/favorite.db', 'message/media_0.db', 'message/message_resource.db') if (source / name).is_file()]
    if len(paths) < 3 or any(not (source / path).is_file() for path in paths):
        raise ValueError("当前账号缺少联系人、会话或消息分片")
    sizes = [(source / path).stat().st_size for path in paths]
    if len(paths) > 31 or max(sizes) > 134217728 or sum(sizes) > 805306368:
        raise ValueError("当前历史规模超出已验证的查询预算")
    return source, paths, {
        "status": "PREFLIGHT", "client_version": wcdb_runtime_keys.BUILD_VERSION,
        "client_build_sha256": wcdb_runtime_keys.BUILD_SHA256,
        "client_build_identity": identity,
        "pid": pid, "uid": os.geteuid(),
        "account_ref": hashlib.sha256(source.parent.name.encode()).hexdigest()[:12],
        "database_count": len(paths), "database_bytes": sum(sizes),
        "largest_database_bytes": max(sizes),
        "heap_bytes": meta["heap_bytes"], "anonymous_bytes": meta["anonymous_bytes"],
        "scan_budget_bytes": wcdb_runtime_keys.MAX_SCAN_BYTES,
        "authentication": "pkexec", "pkexec_available": shutil.which("pkexec") is not None,
        "writes_original_db": False, "stops_wechat": False,
        "snapshot_consistency": wcdb_live_snapshot.CONSISTENCY,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument('--managed', choices=['import', 'refresh'])
    parser.add_argument('--consumer')
    parser.add_argument('--pinned-snapshot')
    parser.add_argument("--resume-state", type=Path, help="复用本人私有准备目录中的已认证密钥")
    args = parser.parse_args()
    if args.managed:
        result = managed_history(args.managed, consumer=args.consumer, pinned=args.pinned_snapshot)
        print(json.dumps({'phase': 'ready', 'result': result}, ensure_ascii=False), flush=True)
        return 0
    if args.pid is None:
        parser.error('--pid is required for legacy preparation')
    source, paths, plan = preparation_plan(args.pid)
    if args.preflight:
        print(json.dumps(plan, ensure_ascii=False))
        return 0
    state = args.resume_state or Path(tempfile.mkdtemp(prefix=".wechat-ro-history-", dir=Path.home()))
    if not state.is_absolute() or state.is_symlink() or state.resolve() != state or not state.is_dir() \
            or state.stat().st_uid != os.geteuid() or state.stat().st_mode & 0o077:
        raise PermissionError("准备目录必须是本人所属的私有真实目录")
    keys_file = state / "runtime-keys.json"
    if args.resume_state is None:
        pkexec = shutil.which("pkexec")
        if pkexec is None:
            raise RuntimeError("未找到系统认证入口 pkexec")
        print(json.dumps({"status": "AWAITING_SYSTEM_AUTHENTICATION", "state_directory": str(state)}, ensure_ascii=False), flush=True)
        capture = subprocess.run([
            pkexec, "/usr/bin/python3", wcdb_runtime_keys.__file__, "--pid", str(args.pid),
            "--db-dir", str(source), "--output", str(keys_file), "--allow-runtime-read",
        ] + [argument for path in paths for argument in ("--database", path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if capture.returncode != 0:
            print(json.dumps({"status": "KEY_CAPTURE_NOT_COMPLETED", "exit_code": capture.returncode,
                              "state_directory": str(state)}, ensure_ascii=False))
            return capture.returncode
        (state / "capture.json").write_text(capture.stdout)
        os.chmod(state / "capture.json", 0o600)
    if not keys_file.is_file() or keys_file.stat().st_uid != os.geteuid() or keys_file.stat().st_mode & 0o077:
        raise PermissionError("系统助手未交付本人私有密钥文件")
    print(json.dumps({"status": "CAPTURING_COMMITTED_HISTORY", "database_count": len(paths)}, ensure_ascii=False), flush=True)
    result = wcdb_live_snapshot.snapshot_live(str(source), str(state / "snapshot"), str(keys_file), selected_paths=paths)
    record = {"status": "LOCAL_HISTORY_PREPARED", "plan": plan, "result": result,
              "snapshot_directory": str(state / "snapshot/decrypted"), "output_uid": os.geteuid()}
    (state / "preparation.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    os.chmod(state / "preparation.json", 0o600)
    print(json.dumps(record, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, wcdb_live_snapshot.sqlite3.Error) as error:
        code = 'LOCAL_HISTORY_CLIENT_REQUIRED' if str(error) == 'LOCAL_HISTORY_CLIENT_REQUIRED' else 'LOCAL_HISTORY_FAILED'
        print(json.dumps({"status": "PREPARATION_FAILED", "error_type": type(error).__name__, "error_code": code}))
        sys.exit(1)
