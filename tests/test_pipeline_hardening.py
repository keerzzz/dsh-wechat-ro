#!/usr/bin/env python3
"""Synthetic regressions only: never import/execute the vendor module top level.

Requires explicit WECHAT_FIXTURE_DIR, WECHAT_SNAPSHOT_DIR and TMPDIR under one
Lead-authorized private /tmp/wechat-ro-fix-pipeline-* root. Evidence stays under
audit/2026-11-06-fixes/pipeline. No GDB, sudo, WeChat process or real DB is used.
AES is exercised with the public NIST SP 800-38A AES-256-CBC vector. Database
fixtures use authenticated identity-cipher pages to isolate MAC/SQLite/publish
checks from AES; they are not evidence of compatibility with real WCDB data.
"""
from __future__ import annotations

import argparse
import ast
import contextlib
import ctypes
import errno
import hashlib
import hmac
import io
import json
import logging
import os
from pathlib import Path
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import textwrap
import time
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor/wcdb_key_tool.py"
EVIDENCE = ROOT / "audit/2026-11-06-fixes/pipeline"
PUBLIC_KEY = bytes.fromhex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4")
PUBLIC_SALT = bytes(range(16))
PAGE = 4096


def load_functions() -> dict:
    """Compile only definitions/imports; initialize constants explicitly, no main/logging setup."""
    tree = ast.parse(VENDOR.read_text(encoding="utf-8"), filename=str(VENDOR))
    nodes = [node for node in tree.body if isinstance(
        node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))]
    namespace = {"__name__": "pipeline_synthetic_definitions", "PAGE_SZ": PAGE,
                 "KEY_SZ": 32, "SALT_SZ": 16, "IV_SZ": 16, "HMAC_SZ": 64,
                 "RESERVE_SZ": 80, "SQLITE_HDR": b"SQLite format 3\0", "_ssl": None,
                 "logger": logging.getLogger("pipeline-synthetic"), "_print": print}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(VENDOR), "exec"), namespace)
    for node in tree.body:
        if (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == "_GDB_SCRIPT_TEMPLATE"):
            namespace["_GDB_SCRIPT_TEMPLATE"] = textwrap.dedent(ast.literal_eval(node.value.args[0]))
    return namespace


def make_plain(path: Path) -> bytes:
    """Public, generated SQLite with SQLCipher-compatible 80-byte reserved area."""
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA page_size=4096")
        db.execute("VACUUM")
    page = bytearray(path.read_bytes())
    assert len(page) == PAGE and page[100] == 13 and page[103:105] == b"\0\0"
    page[20] = 80
    page[105:107] = struct.pack(">H", PAGE - 80)
    path.write_bytes(page)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT)")
        db.executemany("INSERT INTO payload(body) VALUES (?)", [("public fixture " * 16,)] * 120)
        assert db.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    path.chmod(0o600)
    data = path.read_bytes()
    assert len(data) >= 3 * PAGE and len(data) % PAGE == 0
    return data


def authenticated_identity_pages(plain: bytes, salt: bytes = PUBLIC_SALT) -> bytes:
    """Not real encryption: public plaintext + realistic SQLCipher page authentication."""
    mac_key = hashlib.pbkdf2_hmac("sha512", PUBLIC_KEY, bytes(x ^ 0x3A for x in salt), 2, 32)
    pages = []
    for index in range(len(plain) // PAGE):
        page = bytearray(plain[index * PAGE:(index + 1) * PAGE])
        if index == 0:
            page[:16] = salt
        page[4016:4032] = bytes(range(16))
        payload = page[16 if index == 0 else 0:4032] + struct.pack("<I", index + 1)
        page[4032:] = hmac.new(mac_key, payload, hashlib.sha512).digest()
        pages.append(bytes(page))
    return b"".join(pages)


class FakeSSL:
    """Native failure injection without dereferencing the deliberately wide fake pointer."""
    def __init__(self, fail: str | None = None, final_length: int = 4):
        self.freed = []
        self.EVP_CIPHER_CTX_new = mock.Mock(return_value=0 if fail == "new" else 0x123456789ABC)
        self.EVP_CIPHER_CTX_free = self.freed.append
        self.EVP_aes_256_cbc = mock.Mock(return_value=0 if fail == "cipher" else 0x23456789ABCD)
        self.EVP_DecryptInit_ex = mock.Mock(return_value=0 if fail == "init" else 1)
        self.EVP_CIPHER_CTX_set_padding = mock.Mock(return_value=0 if fail == "padding" else 1)
        def update(_ctx, output, length, _input, _count):
            length._obj.value = 12
            ctypes.memmove(output, b"A" * 12, 12)
            return 0 if fail == "update" else 1
        def final(_ctx, output, length):
            length._obj.value = final_length
            ctypes.memmove(output, b"B" * final_length, final_length)
            return 0 if fail == "final" else 1
        self.EVP_DecryptUpdate = update
        self.EVP_DecryptFinal_ex = final


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(os.environ.get("PIPELINE_TEST_ROOT", ""))
        parent = Path("/tmp")
        info = parent.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
                or not info.st_mode & stat.S_ISVTX or parent.resolve() != parent):
            raise RuntimeError("/tmp must be a real root-owned sticky directory")
        if (root.parent != parent or not root.name.startswith("wechat-ro-fix-pipeline-")
                or root.resolve() != root):
            raise RuntimeError("PIPELINE_TEST_ROOT must be the explicitly authorized private mkdtemp root")
        info = root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o7777 != 0o700):
            raise RuntimeError("PIPELINE_TEST_ROOT must be current-UID 0700")
        cls.isolation_root = str(root)
        for name in ("WECHAT_FIXTURE_DIR", "WECHAT_SNAPSHOT_DIR", "TMPDIR"):
            path = Path(os.environ.get(name, ""))
            if not path.is_absolute() or path.resolve() != path or not path.is_relative_to(root) or path == root:
                raise RuntimeError(f"{name} must be explicit and strictly under {root}")
        if os.environ.get("PYTHONDONTWRITEBYTECODE") != "1":
            raise RuntimeError("PYTHONDONTWRITEBYTECODE=1 is required")
        Path(os.environ["TMPDIR"]).mkdir(parents=True, mode=0o700, exist_ok=True)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pipeline-case-", dir=os.environ["TMPDIR"])
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.ns = load_functions()
        self.old_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.old_umask)
        self.input = self.directory("inputs")
        self.secrets = self.directory("secrets")
        self.output = self.base / "output"
        self.plain = make_plain(self.base / "public-fixture.sqlite")
        self.encrypted = authenticated_identity_pages(self.plain)
        self.source = self.input / "one.db"
        self.source.write_bytes(self.encrypted)
        self.source.chmod(0o600)
        self.keys = self.secrets / "keys.json"
        self.pass_file = self.secrets / "passphrase.json"
        self.ns["_write_private_json"](str(self.keys), {"one.db": {"enc_key": PUBLIC_KEY.hex()}})

    def directory(self, name: str) -> Path:
        path = self.base / name
        path.mkdir(parents=True, mode=0o700)
        return path

    def identity(self):
        return mock.patch.dict(self.ns, {"aes_cbc_decrypt": lambda _key, _iv, data: data})

    def args(self, **overrides):
        values = dict(db_dir=str(self.input), output=str(self.keys), passphrase_file=str(self.pass_file),
                      timeout=1, recapture=False, allow_capture=False, decrypt=False,
                      decrypt_output=str(self.output), source_quiescent=True)
        values.update(overrides)
        return argparse.Namespace(**values)

    def old_generation(self):
        self.output.mkdir(mode=0o700)
        old = self.output / "stale.db"
        old.write_bytes(b"old-generation-sentinel")
        old.chmod(0o600)
        return old

    def capture_stubs(self, run):
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.dict(self.ns, {
            "_find_wechat_binary": lambda _pid: Path("/synthetic/not-a-real-wechat"),
            "_check_tracer": lambda _pid: None, "find_hook_offset": lambda _path: 16,
            "find_runtime_base": lambda _pid, _path: 0x12345000,
        }))
        stack.enter_context(mock.patch.object(self.ns["shutil"], "which", return_value="synthetic-gdb-never-executed"))
        runner = stack.enter_context(mock.patch.object(self.ns["subprocess"], "run", side_effect=run))
        return stack, runner

    def test_pipe01_actual_workspace_ancestor_policy_is_not_bypassed(self):
        untrusted = False
        for path in (EVIDENCE, *EVIDENCE.parents):
            try:
                self.ns["_check_write_ancestor"](path.stat())
            except PermissionError:
                untrusted = True
        if untrusted:
            with self.assertRaises(PermissionError):
                with self.ns["_directory"](str(EVIDENCE), create=True):
                    self.fail("untrusted deployment ancestors were accepted")
        else:
            with self.ns["_directory"](str(EVIDENCE), create=True):
                pass

    def test_pipe01_real_directory_identity_aliases_are_rejected(self):
        alias = "/" + str(self.input)  # Linux accepts //tmp/... as the same directory.
        before = self.source.read_bytes()
        self.assertEqual((os.stat(alias).st_dev, os.stat(alias).st_ino),
                         (self.input.stat().st_dev, self.input.stat().st_ino))
        nested_output = self.input / "nested-output"
        with self.assertRaises(ValueError):
            self.ns["decrypt_all"](alias, str(nested_output), str(self.keys))
        with self.assertRaises(ValueError):
            self.ns["_reject_overlap"](str(self.input), "/" + str(self.base))
        self.assertFalse(nested_output.exists())
        self.assertEqual(self.source.read_bytes(), before)
        # Distinct siblings have common ancestors, but are not aliases/overlaps.
        self.ns["_reject_overlap"](str(self.input), str(self.output))

    def test_pipe01_source_links_and_overlap_never_write_original(self):
        original = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            self.ns["decrypt_all"](str(self.input), str(self.input), str(self.keys))
        for kind in ("symlink", "hardlink"):
            with self.subTest(kind=kind):
                link = self.input / "alias.db"
                if kind == "symlink":
                    link.symlink_to(self.source)
                else:
                    os.link(self.source, link)
                with self.assertRaises((ValueError, OSError)):
                    self.ns["collect_db_files"](str(self.input))
                link.unlink()
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), original)
        files, _salts = self.ns["collect_db_files"](str(self.input))
        self.assertEqual([entry[0] for entry in files], ["one.db"])

    def test_pipe01_directory_and_destination_links_are_rejected(self):
        link = self.base / "linked-input"
        link.symlink_to(self.input, target_is_directory=True)
        with self.assertRaises(OSError):
            self.ns["collect_db_files"](str(link))
        self.output.symlink_to(self.input, target_is_directory=True)
        with self.identity(), self.assertRaises((ValueError, OSError)):
            self.ns["decrypt_all"](str(self.input), str(self.output), str(self.keys))
        nested = self.input / "linked-dir"
        nested.symlink_to(self.secrets, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.ns["collect_db_files"](str(self.input))
        self.assertEqual(self.source.read_bytes(), self.encrypted)

    def test_pipe01_output_file_alias_and_secret_symlink_are_rejected(self):
        destination = self.directory("candidate") / "one.db"
        os.link(self.source, destination)
        with self.identity(), self.assertRaises((ValueError, OSError)):
            self.ns["_decrypt_database"](str(self.source), str(destination), PUBLIC_KEY)
        destination.unlink()
        self.pass_file.symlink_to(self.source)
        with self.assertRaises((OSError, ValueError)):
            self.ns["save_passphrase"](PUBLIC_KEY.hex(), str(self.pass_file))
        self.assertEqual(self.source.read_bytes(), self.encrypted)

    def test_pipe01_replaceable_write_ancestors_are_rejected_before_creation(self):
        ancestor = self.directory("replaceable-parent")
        ancestor.chmod(0o777)
        target = ancestor / "private" / "passphrase.json"
        with self.assertRaises(PermissionError):
            self.ns["save_passphrase"](PUBLIC_KEY.hex(), str(target))
        self.assertFalse(target.parent.exists())
        self.assertEqual(ancestor.stat().st_mode & 0o777, 0o777)
        # Owned, non-writable-to-others ancestors need not themselves be 0700.
        ancestor.chmod(0o755)
        self.ns["save_passphrase"](PUBLIC_KEY.hex(), str(target))
        self.assertEqual(self.ns["load_passphrase"](str(target)), PUBLIC_KEY.hex())
        # A trusted-owner sticky parent also protects our private entry.
        ancestor.chmod(0o1777)
        self.ns["save_passphrase"](PUBLIC_KEY.hex(), str(target))
        foreign = types.SimpleNamespace(st_uid=os.geteuid() + 1, st_mode=0o40755)
        with self.assertRaises(PermissionError):
            self.ns["_check_write_ancestor"](foreign)

    def test_pipe02_existing_permissions_and_owner_are_not_silently_fixed(self):
        self.keys.chmod(0o644)
        before = self.keys.read_bytes()
        for function in (lambda: self.ns["_read_private_json"](str(self.keys)),
                         lambda: self.ns["_write_private_json"](str(self.keys), {})):
            with self.assertRaises(PermissionError):
                function()
        self.assertEqual(self.keys.read_bytes(), before)
        self.assertEqual(self.keys.stat().st_mode & 0o777, 0o644)
        self.keys.chmod(0o600)
        self.secrets.chmod(0o755)
        with self.assertRaises(PermissionError):
            self.ns["save_passphrase"](PUBLIC_KEY.hex(), str(self.pass_file))
        foreign = types.SimpleNamespace(st_uid=os.geteuid() + 1, st_mode=0o100600, st_nlink=1)
        with self.assertRaises(PermissionError):
            self.ns["_check_private"](foreign)

    def test_pipe02_unsafe_existing_tree_refused_and_new_files_private(self):
        old = self.old_generation()
        old.chmod(0o644)
        with self.identity(), self.assertRaises(PermissionError):
            self.ns["decrypt_all"](str(self.input), str(self.output), str(self.keys))
        self.assertEqual(old.read_bytes(), b"old-generation-sentinel")
        old.chmod(0o600)
        with self.identity():
            summary = self.ns["decrypt_all"](str(self.input), str(self.output), str(self.keys))
        self.assertTrue(summary["published"])
        for path in self.output.rglob("*"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)

    def test_pipe03_all_sidecars_are_refused_even_when_empty(self):
        for suffix in ("-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix):
                sidecar = self.input / ("one.db" + suffix)
                sidecar.touch(mode=0o600)
                with self.assertRaisesRegex(ValueError, "WAL/SHM/journal"):
                    self.ns["copy_stable_databases"](str(self.input), str(self.base / "copy"))
                sidecar.unlink()
        captured = self.ns["copy_stable_databases"](str(self.input), str(self.base / "copy"))
        self.assertTrue(captured.endswith("+08:00"))
        self.assertEqual((self.base / "copy/one.db").read_bytes(), self.encrypted)

    def test_pipe03_real_synthetic_wal_commits_are_not_silently_omitted(self):
        live = self.input / "live.db"
        with sqlite3.connect(live) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE recent(value)")
            connection.execute("INSERT INTO recent VALUES ('public committed row')")
            connection.commit()
            wal = Path(str(live) + "-wal")
            before = (live.read_bytes(), wal.read_bytes())
            with self.assertRaisesRegex(ValueError, "WAL/SHM/journal"):
                self.ns["copy_stable_databases"](str(self.input), str(self.base / "copy"))
            self.assertEqual((live.read_bytes(), wal.read_bytes()), before)

    def test_pipe03_mutation_or_new_file_aborts_before_publication(self):
        original_scan = self.ns["_scan_db_inventory"]
        for mutation in ("content", "inventory", "sidecar"):
            with self.subTest(mutation=mutation):
                calls = 0
                def scan(directory):
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        if mutation == "content":
                            self.source.write_bytes(bytes([self.encrypted[0] ^ 1]) + self.encrypted[1:])
                        elif mutation == "inventory":
                            (self.input / "late.db").write_bytes(self.encrypted)
                        else:
                            (self.input / "one.db-wal").touch()
                    return original_scan(directory)
                with mock.patch.dict(self.ns, {"_scan_db_inventory": scan}), self.assertRaises(ValueError):
                    self.ns["cmd_snapshot"](self.args(output=str(self.output)))
                self.assertFalse(self.output.exists())
                self.assertEqual(list(self.base.glob(".output.backup-*")), [])
                self.source.write_bytes(self.encrypted)
                for name in ("late.db", "one.db-wal"):
                    (self.input / name).unlink(missing_ok=True)

    def test_pipe03_explicit_quiescence_is_a_precondition(self):
        with self.assertRaisesRegex(ValueError, "source-quiescent"):
            self.ns["cmd_snapshot"](self.args(output=str(self.output), source_quiescent=False))
        self.assertFalse(self.output.exists())

    def test_pipe04_public_nist_aes256_cbc_vector_and_complete_abi(self):
        ciphertext = bytes.fromhex(
            "f58c4c04d6e5f1ba779eabfb5f7bfbd6" "9cfc4e967edb808d679f777bc6702c7d"
            "39f23369a9d9bacfa530e26304231461" "b2eb05e2c39be9fcda6c19078c6a9d1b")
        plaintext = bytes.fromhex(
            "6bc1bee22e409f96e93d7e117393172a" "ae2d8a571e03ac9c9eb76fac45af8e51"
            "30c81c46a35ce411e5fbc1191a0a52ef" "f69f2445df4f9b17ad2b417be66c3710")
        self.assertEqual(self.ns["aes_cbc_decrypt"](PUBLIC_KEY, bytes(range(16)), ciphertext), plaintext)
        ssl = self.ns["_get_ssl"]()
        self.assertIs(ssl.EVP_CIPHER_CTX_new.restype, ctypes.c_void_p)
        self.assertIs(ssl.EVP_aes_256_cbc.restype, ctypes.c_void_p)
        self.assertIsNone(ssl.EVP_CIPHER_CTX_free.restype)
        for name, count in (("EVP_DecryptInit_ex", 5), ("EVP_CIPHER_CTX_set_padding", 2),
                            ("EVP_DecryptUpdate", 5), ("EVP_DecryptFinal_ex", 3)):
            function = getattr(ssl, name)
            self.assertEqual(len(function.argtypes), count)
            self.assertIs(function.restype, ctypes.c_int)
        self.assertEqual(self.ns["aes_cbc_decrypt"](PUBLIC_KEY, bytes(16), b""), b"")

    def test_pipe04_each_native_failure_frees_only_owned_context(self):
        for failure in ("new", "cipher", "init", "padding", "update", "final"):
            with self.subTest(failure=failure):
                ssl = FakeSSL(failure)
                with mock.patch.dict(self.ns, {"_get_ssl": lambda: ssl}), self.assertRaises(RuntimeError):
                    self.ns["aes_cbc_decrypt"](PUBLIC_KEY, bytes(16), bytes(16))
                self.assertEqual(ssl.freed, [] if failure == "new" else [0x123456789ABC])
        ssl = FakeSSL()
        with mock.patch.dict(self.ns, {"_get_ssl": lambda: ssl}):
            self.assertEqual(self.ns["aes_cbc_decrypt"](PUBLIC_KEY, bytes(16), bytes(16)), b"A" * 12 + b"B" * 4)
        bad = FakeSSL(final_length=17)
        with mock.patch.dict(self.ns, {"_get_ssl": lambda: bad}), self.assertRaises(RuntimeError):
            self.ns["aes_cbc_decrypt"](PUBLIC_KEY, bytes(16), bytes(16))
        self.assertEqual(bad.freed, [0x123456789ABC])

    def test_pipe04_invalid_lengths_fail_before_native_calls(self):
        native = mock.Mock(side_effect=AssertionError("native must not run"))
        with mock.patch.dict(self.ns, {"_get_ssl": native}):
            for key, iv, data in ((bytes(31), bytes(16), bytes(16)),
                                  (PUBLIC_KEY, bytes(15), bytes(16)), (PUBLIC_KEY, bytes(16), bytes(15))):
                with self.assertRaises(ValueError):
                    self.ns["aes_cbc_decrypt"](key, iv, data)
        native.assert_not_called()

    def test_pipe05_truncation_wrong_key_and_later_mac_fail_closed(self):
        for variant in (self.encrypted[:-1], self.encrypted[:PAGE - 1],
                        self.encrypted[:PAGE + 123] + bytes([self.encrypted[PAGE + 123] ^ 1]) + self.encrypted[PAGE + 124:]):
            with self.subTest(size=len(variant)):
                self.source.write_bytes(variant)
                destination = self.base / "bad.db"
                with self.identity(), self.assertRaises(ValueError):
                    self.ns["_decrypt_database"](str(self.source), str(destination), PUBLIC_KEY)
                self.assertFalse(destination.exists())
        self.source.write_bytes(self.encrypted)
        with self.assertRaises(ValueError):
            self.ns["_decrypt_database"](str(self.source), str(self.base / "wrong-key.db"), bytes(32))
        with self.identity():
            self.assertTrue(self.ns["_decrypt_database"](str(self.source), str(self.base / "valid.db"), PUBLIC_KEY))
        self.assertEqual((self.base / "valid.db").read_bytes(), self.plain)

    def test_pipe05_non_schema_corruption_fails_full_integrity(self):
        corrupted = bytearray(self.plain)
        corrupted[PAGE] = 255  # sqlite_master remains readable, payload root btree is corrupt.
        damaged = self.base / "schema-only-readable.sqlite"
        damaged.write_bytes(corrupted)
        with sqlite3.connect(f"file:{damaged}?mode=ro&immutable=1", uri=True) as db:
            self.assertEqual(db.execute("SELECT name FROM sqlite_master").fetchall(), [("payload",)])
        self.source.write_bytes(authenticated_identity_pages(corrupted))
        with self.identity(), self.assertRaises((ValueError, sqlite3.Error)):
            self.ns["_decrypt_database"](str(self.source), str(self.base / "bad.db"), PUBLIC_KEY)
        self.assertFalse((self.base / "bad.db").exists())

    def test_pipe05_partial_key_sets_are_never_saved(self):
        files, salts = self.ns["collect_db_files"](str(self.input))
        target = self.secrets / "new-keys.json"
        with self.assertRaises(RuntimeError):
            self.ns["_save_results"](files, salts, {}, str(self.input), str(target))
        self.assertFalse(target.exists())
        self.ns["_save_results"](files, salts, {PUBLIC_SALT.hex(): PUBLIC_KEY.hex()}, str(self.input), str(target))
        self.assertEqual(set(self.ns["_read_private_json"](str(target))), {"one.db", "_db_dir"})

    def test_pipe06_one_failure_keeps_entire_old_generation(self):
        old = self.old_generation()
        (self.input / "missing-key.db").write_bytes(self.encrypted)
        with self.identity():
            result = self.ns["decrypt_all"](str(self.input), str(self.output), str(self.keys))
        self.assertEqual((result["success"], result["failed"], result["total"]), (1, 1, 2))
        self.assertFalse(result["published"])
        self.assertFalse(result["complete"])
        self.assertEqual(old.read_bytes(), b"old-generation-sentinel")
        self.assertFalse((self.output / "one.db").exists())
        self.assertEqual(list(self.base.glob(".output.backup-*")), [])
        with self.identity(), self.assertRaises(RuntimeError):
            self.ns["cmd_decrypt_inner"](str(self.input), str(self.keys), str(self.output))

    def test_pipe06_atomic_linux_refresh_retains_private_backup_without_stale_rows(self):
        self.old_generation()
        with self.identity():
            result = self.ns["decrypt_all"](str(self.input), str(self.output), str(self.keys))
        self.assertTrue(result["complete"])
        self.assertEqual({path.name for path in self.output.iterdir()}, {"one.db"})
        backup = Path(result["backup_dir"])
        self.assertEqual((backup / "stale.db").read_bytes(), b"old-generation-sentinel")
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.output / "one.db").read_bytes(), self.plain)

    def assert_publication_cancellation(self, entry, existing, boundary, exception):
        """Interrupt real renameat2 boundaries; never mock inode or permission checks."""
        output = self.base / f"cancel-{entry}-{existing}-{boundary}-{exception.__name__}"
        old_identity = None
        if existing:
            output.mkdir(mode=0o700)
            (output / "stale.db").write_bytes(b"old-generation-sentinel")
            info = output.stat()
            old_identity = (info.st_dev, info.st_ino)
        source_before = self.source.read_bytes()
        tree = ast.parse(VENDOR.read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == entry)
        publication = next(node for node in ast.walk(function) if isinstance(node, ast.Assign)
                           and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                           and node.value.func.id == "_publish_directory")
        caller_next = min(node.lineno for node in ast.walk(function)
                          if isinstance(node, ast.stmt) and node.lineno > publication.end_lineno)
        publisher = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                         and node.name == "_publish_directory")
        before_native = next(node.lineno for node in ast.walk(publisher) if isinstance(node, ast.If)
                             and any(isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
                                     and call.func.id == "renameat2" for call in ast.walk(node.test)))
        after_native = next(node.lineno for node in publisher.body if isinstance(node, ast.Return))
        seen = {}
        def trace(frame, event, _arg):
            if (frame.f_code is self.ns["_publish_directory"].__code__
                    and frame.f_locals.get("destination") == str(output)):
                if event == "call":
                    stage = Path(frame.f_locals["stage"])
                    info = stage.stat()
                    seen.update(stage=stage, owned=(info.st_dev, info.st_ino))
                point = before_native if boundary == "before-native" else after_native
                if boundary != "after-caller" and event == "line" and frame.f_lineno == point:
                    seen["interrupted"] = True
                    raise exception("synthetic publication cancellation")
            elif (boundary == "after-caller" and frame.f_code is self.ns[entry].__code__
                  and event == "line" and frame.f_lineno == caller_next):
                seen["interrupted"] = True
                raise exception("synthetic publication cancellation")
            return trace
        def extract(args):
            self.ns["_write_private_json"](args.output, {"one.db": {"enc_key": PUBLIC_KEY.hex()}})
        previous_trace = sys.gettrace()
        try:
            with self.identity(), mock.patch.dict(self.ns, {"cmd_extract": extract}):
                with self.assertRaisesRegex(exception, "synthetic publication cancellation"):
                    sys.settrace(trace)
                    if entry == "cmd_snapshot":
                        self.ns[entry](self.args(output=str(output)))
                    else:
                        self.ns[entry](str(self.input), str(output), str(self.keys))
        finally:
            sys.settrace(previous_trace)
        self.assertTrue(seen.get("interrupted"), "trace must reach the intended commit boundary")
        self.assertEqual(self.source.read_bytes(), source_before)
        if boundary == "before-native":
            self.assertFalse(seen["stage"].exists(), "unpublished owned candidate must be cleaned")
            if existing:
                self.assertEqual((output / "stale.db").read_bytes(), b"old-generation-sentinel")
                info = output.stat()
                self.assertEqual((info.st_dev, info.st_ino), old_identity)
            else:
                self.assertFalse(output.exists())
        else:
            # A cancelled acknowledgement is not a rollback: the new generation committed.
            info = output.stat()
            self.assertEqual((info.st_dev, info.st_ino), seen["owned"])
            db_path = output / ("decrypted/one.db" if entry == "cmd_snapshot" else "one.db")
            self.assertEqual(db_path.read_bytes(), self.plain)
            self.assertFalse((output / "stale.db").exists())
            if existing:
                self.assertTrue(seen["stage"].is_dir(), "committed old backup must never be discarded")
                info = seen["stage"].stat()
                self.assertEqual((info.st_dev, info.st_ino), old_identity)
                self.assertEqual(info.st_mode & 0o777, 0o700)
                self.assertEqual((seen["stage"] / "stale.db").read_bytes(), b"old-generation-sentinel")
            else:
                self.assertFalse(seen["stage"].exists(), "first publication moves the owned name away")
        with self.ns["_publication_lock"](str(output)):
            pass  # Cancellation must also release this invocation's lock.

    def test_pipe06_snapshot_refresh_cancellation_preserves_old_backup(self):
        for boundary in ("after-native", "after-caller"):
            for exception in (KeyboardInterrupt, SystemExit):
                with self.subTest(boundary=boundary, exception=exception.__name__):
                    self.assert_publication_cancellation("cmd_snapshot", True, boundary, exception)

    def test_pipe06_snapshot_first_publication_preserves_cancellation(self):
        for boundary in ("after-native", "after-caller"):
            for exception in (KeyboardInterrupt, SystemExit):
                with self.subTest(boundary=boundary, exception=exception.__name__):
                    self.assert_publication_cancellation("cmd_snapshot", False, boundary, exception)

    def test_pipe06_snapshot_precommit_cancellation_cleans_only_candidate(self):
        for existing in (False, True):
            for exception in (KeyboardInterrupt, SystemExit):
                with self.subTest(existing=existing, exception=exception.__name__):
                    self.assert_publication_cancellation("cmd_snapshot", existing, "before-native", exception)

    def test_pipe06_decrypt_refresh_cancellation_preserves_old_backup(self):
        for boundary in ("after-native", "after-caller"):
            for exception in (KeyboardInterrupt, SystemExit):
                with self.subTest(boundary=boundary, exception=exception.__name__):
                    self.assert_publication_cancellation("decrypt_all", True, boundary, exception)

    def test_pipe06_decrypt_first_publication_preserves_cancellation(self):
        for boundary in ("after-native", "after-caller"):
            for exception in (KeyboardInterrupt, SystemExit):
                with self.subTest(boundary=boundary, exception=exception.__name__):
                    self.assert_publication_cancellation("decrypt_all", False, boundary, exception)

    def test_pipe06_decrypt_precommit_cancellation_cleans_only_candidate(self):
        for existing in (False, True):
            for exception in (KeyboardInterrupt, SystemExit):
                with self.subTest(existing=existing, exception=exception.__name__):
                    self.assert_publication_cancellation("decrypt_all", existing, "before-native", exception)

    def test_pipe06_unsupported_atomic_rename_never_uses_two_step_fallback(self):
        old = self.old_generation()
        def denied(*_args):
            ctypes.set_errno(errno.ENOSYS)
            return -1
        rename = mock.Mock(side_effect=denied)
        library = types.SimpleNamespace(renameat2=rename)
        with self.identity(), mock.patch.object(ctypes, "CDLL", return_value=library):
            with self.assertRaises(OSError) as caught:
                self.ns["decrypt_all"](str(self.input), str(self.output), str(self.keys))
        self.assertEqual(caught.exception.errno, errno.ENOSYS)
        self.assertEqual(old.read_bytes(), b"old-generation-sentinel")
        self.assertEqual(list(self.base.glob(".output.backup-*")), [])
        self.assertEqual(rename.argtypes, [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint])
        self.assertIs(rename.restype, ctypes.c_int)

    def test_pipe06_publication_lock_blocks_a_competing_process(self):
        lock = self.base / ".output.lock"
        code = "import os,fcntl,sys; f=os.open(sys.argv[1],os.O_RDWR);\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)\n"
        with self.ns["_publication_lock"](str(self.output)):
            competing = subprocess.run([sys.executable, "-c", code, str(lock)], capture_output=True, timeout=5)
            self.assertEqual(competing.returncode, 73, competing.stderr)
            with self.assertRaises(RuntimeError):
                with self.ns["_publication_lock"](str(self.output)):
                    self.fail("second publisher acquired an owned lock")
        control = subprocess.run([sys.executable, "-c", code, str(lock)], capture_output=True, timeout=5)
        self.assertEqual(control.returncode, 0, control.stderr)

    def test_pipe06_manifest_has_original_capture_time_and_complete_file_hashes(self):
        timestamp = "2026-01-02T03:04:05+08:00"
        original_copy = self.ns["copy_stable_databases"]
        def copy(source, output):
            original_copy(source, output)
            return timestamp
        def extract(args):
            self.ns["_write_private_json"](args.output, {"one.db": {"enc_key": PUBLIC_KEY.hex()}})
        with self.identity(), mock.patch.dict(self.ns, {"copy_stable_databases": copy, "cmd_extract": extract}):
            result = self.ns["cmd_snapshot"](self.args(output=str(self.output)))
        manifest = json.loads((self.output / "decrypted/.wechat-ro-manifest.json").read_text())
        self.assertEqual(manifest["captured_at"], timestamp)
        self.assertEqual(manifest["schema_version"], 1)
        self.assertTrue(manifest["complete"] and result["published"])
        self.assertEqual(manifest["consistency"], "stable-db-only-verified")
        self.assertRegex(manifest["snapshot_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(manifest["files"], [{"path": "one.db", "size": len(self.plain),
                                           "sha256": hashlib.sha256(self.plain).hexdigest()}])

    def test_pipe06_snapshot_keys_follow_published_generation_on_refresh(self):
        def extract(args):
            self.ns["_write_private_json"](args.output, {
                "one.db": {"enc_key": PUBLIC_KEY.hex()}, "_db_dir": args.db_dir})
        with self.identity(), mock.patch.dict(self.ns, {"cmd_extract": extract}):
            self.ns["cmd_snapshot"](self.args(output=str(self.output)))
            with sqlite3.connect(self.base / "public-fixture.sqlite") as db:
                db.execute("UPDATE payload SET body = ? WHERE id = 1", ("new generation",))
            refreshed = (self.base / "public-fixture.sqlite").read_bytes()
            self.assertNotEqual(refreshed, self.plain)
            self.source.write_bytes(authenticated_identity_pages(refreshed))
            result = self.ns["cmd_snapshot"](self.args(output=str(self.output)))
            published_keys = self.output / "all_keys.json"
            metadata = self.ns["_read_private_json"](str(published_keys))
            self.assertEqual(metadata["_db_dir"], str(self.output / "encrypted_copy"))
            repeated = self.base / "default-decrypt"
            self.ns["cmd_decrypt"](argparse.Namespace(
                db_dir=None, keys=str(published_keys), output=str(repeated)))
        self.assertEqual((repeated / "one.db").read_bytes(), refreshed)
        self.assertEqual((self.output / "decrypted/one.db").read_bytes(), refreshed)
        self.assertEqual((Path(result["backup_dir"]) / "decrypted/one.db").read_bytes(), self.plain)

    def test_pipe07_configured_cache_is_only_read_write_source(self):
        explicit = self.secrets / "explicit.json"
        with mock.patch.dict(os.environ, {"HOME": str(self.base / "unused-home"),
                                          "WCD_PASS_DIR": str(self.secrets),
                                          "WCDB_PASSPHRASE_FILE": str(explicit)}):
            self.assertEqual(self.ns["default_passphrase_file"](), str(explicit))
            self.ns["save_passphrase"](PUBLIC_KEY.hex(), str(explicit))
            self.assertEqual(self.ns["load_passphrase"](str(explicit)), PUBLIC_KEY.hex())
            os.environ["WCDB_PASSPHRASE_FILE"] = ""
            self.assertEqual(self.ns["default_passphrase_file"](), str(self.secrets / "wechat-passphrase.json"))
        self.assertFalse((self.base / "unused-home").exists())

    def test_pipe07_cache_hit_never_checks_or_launches_gdb(self):
        forbidden = mock.Mock(side_effect=AssertionError("GDB must not be used"))
        with mock.patch.dict(self.ns, {"check_prerequisites": forbidden, "capture_passphrase": forbidden}):
            self.ns["cmd_extract"](self.args())
        forbidden.assert_not_called()

    def test_pipe07_invalid_cache_fails_clearly_without_automatic_recapture(self):
        self.keys.unlink()
        self.ns["save_passphrase"](PUBLIC_KEY.hex(), str(self.pass_file))
        capture = mock.Mock(side_effect=AssertionError("capture not authorized"))
        with mock.patch.dict(self.ns, {"_derive_keys_from_passphrase": lambda *_args: {}, "capture_passphrase": capture}):
            with self.assertRaisesRegex(RuntimeError, "recapture"):
                self.ns["cmd_extract"](self.args())
        self.assertFalse(self.keys.exists())
        self.assertEqual(self.ns["load_passphrase"](str(self.pass_file)), PUBLIC_KEY.hex())
        self.pass_file.write_text('{"passphrase":"not-a-valid-secret"}')
        with self.assertRaisesRegex(ValueError, "内容不回显"):
            self.ns["cmd_extract"](self.args())
        capture.assert_not_called()

    def test_pipe07_missing_cache_requires_explicit_capture_permission(self):
        self.keys.unlink()
        capture = mock.Mock(side_effect=AssertionError("capture not authorized"))
        with mock.patch.dict(self.ns, {"capture_passphrase": capture}), self.assertRaisesRegex(RuntimeError, "allow-capture"):
            self.ns["cmd_extract"](self.args())
        capture.assert_not_called()

    def test_pipe08_no_secret_or_prefix_in_success_logs(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), mock.patch.dict(self.ns, {
                "capture_passphrase": lambda **_kwargs: PUBLIC_KEY.hex(),
                "check_prerequisites": lambda: [],
                "_derive_keys_from_passphrase": lambda *_args: {PUBLIC_SALT.hex(): PUBLIC_KEY.hex()}}):
            self.ns["cmd_extract"](self.args(recapture=True, allow_capture=True))
        self.assertNotIn(PUBLIC_KEY.hex(), output.getvalue())
        self.assertNotIn(PUBLIC_KEY.hex()[:8], output.getvalue())
        self.assertEqual(self.ns["load_passphrase"](str(self.pass_file)), PUBLIC_KEY.hex())

    def test_pipe08_child_errors_never_relay_memory_or_accept_failed_exit(self):
        for code, text in ((0, "CAPTURE_ERROR=" + PUBLIC_KEY.hex()),
                           (7, "WECHAT_PASSPHRASE=" + PUBLIC_KEY.hex())):
            stack, _runner = self.capture_stubs(lambda *_args, **_kwargs: subprocess.CompletedProcess([], code, text, ""))
            with stack, self.assertRaises(self.ns["CaptureError"]) as caught:
                self.ns["capture_passphrase"](pid=12345, timeout=1)
            self.assertNotIn(PUBLIC_KEY.hex(), str(caught.exception))
            self.assertNotIn(PUBLIC_KEY.hex()[:8], str(caught.exception))

    def test_pipe09_timeout_reaps_owned_child_and_leaves_other_child_running(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        real_run = subprocess.run
        owned = []
        def timeout_only_owned(_argv, **_kwargs):
            # A real synthetic child timeout exercises subprocess.run cleanup; no GDB executes.
            command = [sys.executable, "-c", "import time; time.sleep(30)"]
            owned.append(command)
            return real_run(command, capture_output=True, text=True, timeout=0.03)
        stack, runner = self.capture_stubs(timeout_only_owned)
        try:
            with stack, self.assertRaises(self.ns["CaptureError"]):
                self.ns["capture_passphrase"](pid=12345, timeout=1)
            self.assertIsNone(unrelated.poll())
            self.assertEqual(len(owned), 1)
            self.assertEqual(runner.call_count, 1)
            self.assertNotIn("_cleanup_tracer", self.ns)
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)

    def test_pipe09_success_does_not_run_global_process_cleanup(self):
        stack, runner = self.capture_stubs(lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "WECHAT_PASSPHRASE=" + PUBLIC_KEY.hex(), ""))
        with stack:
            self.assertEqual(self.ns["capture_passphrase"](pid=12345), PUBLIC_KEY.hex())
        self.assertEqual(runner.call_count, 1)
        self.assertEqual(runner.call_args.args[0][0], "synthetic-gdb-never-executed")

    def test_selftest_refuses_existing_fixture_in_explicit_evidence_paths(self):
        fixture = self.directory("already-exists")
        sentinel = fixture / "sentinel"
        sentinel.write_text("do not replace")
        environment = dict(os.environ, WECHAT_FIXTURE_DIR=str(fixture), WECHAT_SNAPSHOT_DIR=str(fixture))
        result = subprocess.run(["bash", str(ROOT / "scripts/selftest.sh")], env=environment,
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture 目标必须全新", result.stderr)
        self.assertEqual(sentinel.read_text(), "do not replace")

    def test_cli_failure_exit_is_nonzero_without_vendor_top_level(self):
        command = mock.Mock(side_effect=RuntimeError("synthetic incomplete generation"))
        with mock.patch.dict(self.ns, {"cmd_decrypt": command}), mock.patch.object(
                sys, "argv", [str(VENDOR), "decrypt", "--db-dir", str(self.input),
                              "--keys", str(self.keys), "--output", str(self.output)]):
            with self.assertRaises(SystemExit) as caught:
                self.ns["main"]()
        self.assertEqual(caught.exception.code, 1)


class EvidenceResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = []
        self.started = {}
    def startTest(self, test):
        self.started[test.id()] = time.monotonic()
        super().startTest(test)
    def addSuccess(self, test):
        self.cases.append({"test": test.id(), "status": "passed",
                           "duration_seconds": round(time.monotonic() - self.started[test.id()], 4)})
        super().addSuccess(test)
    def addFailure(self, test, err):
        self.cases.append({"test": test.id(), "status": "failed", "detail": self._exc_info_to_string(err, test)})
        super().addFailure(test, err)
    def addError(self, test, err):
        self.cases.append({"test": test.id(), "status": "error", "detail": self._exc_info_to_string(err, test)})
        super().addError(test, err)
    def addSubTest(self, test, subtest, err):
        if err:
            self.cases.append({"test": subtest.id(), "status": "failed", "detail": self._exc_info_to_string(err, test)})
        super().addSubTest(test, subtest, err)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PipelineTests)
    result = unittest.TextTestRunner(verbosity=2, resultclass=EvidenceResult).run(suite)
    report = {"suite": "pipeline-hardening", "synthetic_only": True, "tests_run": result.testsRun,
              "success": result.wasSuccessful(), "failures": len(result.failures), "errors": len(result.errors),
              "python": sys.version, "cases": result.cases,
              "isolation": {"root": PipelineTests.isolation_root,
                            "permission_metadata_injection": False,
                            "real_uid_ancestors_io_swap_and_locks": True},
              "limitations": ["No real WCDB/account/process/credential", "No vendor module top-level or live GDB",
                              "Identity-cipher SQLite fixtures plus a separate public AES vector",
                              "No power-loss durability or real service UID deployment validation",
                              "Current 0775 workspace remains unsuitable for production publication"]}
    target = EVIDENCE / "regression-results.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() else 1)
