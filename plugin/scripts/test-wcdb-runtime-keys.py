#!/usr/bin/env python3
"""Synthetic contracts for the pinned Linux runtime-key reader (network 0)."""
import hashlib
import hmac
import os
import pathlib
import struct
import sys
import tempfile
import unittest

VENDOR = pathlib.Path(__file__).resolve().parents[2] / "vendor"
sys.path.insert(0, str(VENDOR))
import wcdb_runtime_keys as runtime


def encrypted_page(key, salt, payload_byte=0xA7):
    prefix = salt + bytes([payload_byte]) * (4096 - 16 - 64)
    mac_key = hashlib.pbkdf2_hmac("sha512", key, bytes(value ^ 0x3A for value in salt), 2, 32)
    digest = hmac.new(mac_key, prefix[16:] + struct.pack("<I", 1), hashlib.sha512).digest()
    return prefix + digest


class RuntimeKeyContract(unittest.TestCase):
    def setUp(self):
        self.base = 0x100000
        self.memory = bytearray(4096)
        self.regions = [(self.base, self.base + len(self.memory))]
        self.vtable = 0x80001000
        self.data_vtable = 0x80002000
        self.mask = bytes(range(32))
        self.reads = []
        self.salt = bytes(range(16))
        self.key = bytes(range(32))
        self.pages = [("message/test.db", 4096, encrypted_page(self.key, self.salt))]

    def object(self, decoded, field=0x90, offset=0x100, pointer_offset=0x700):
        struct.pack_into("<Q", self.memory, offset, self.vtable)
        struct.pack_into("<II", self.memory, offset + 0x1D8, 4096, 4)
        struct.pack_into("<QQQ", self.memory, offset + field,
                         self.data_vtable, self.base + pointer_offset, len(decoded))
        blob = bytes(value ^ self.mask[index % 32] for index, value in enumerate(decoded))
        self.memory[pointer_offset:pointer_offset + len(blob)] = blob

    def read(self, address, length):
        self.reads.append((address, length))
        offset = address - self.base
        self.assertGreaterEqual(offset, 0)
        self.assertLessEqual(offset + length, len(self.memory))
        return bytes(self.memory[offset:offset + length])

    def scan(self, reader=None, **options):
        return runtime.scan_cipher_objects(self.regions, reader or self.read,
                                           self.vtable, self.data_vtable, self.mask,
                                           self.pages, **options)

    def test_raw_literal_authenticates_exact_salt(self):
        self.object(b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'")
        keys, counts = self.scan()
        self.assertEqual(keys, {self.salt: self.key})
        self.assertEqual(counts["matched_salts"], 1)
        self.assertEqual(counts["object_count"], 1)
        self.assertEqual(counts["payload_count"], 1)

    def test_retained_passphrase_derives_multiple_salts(self):
        passphrase = bytes(range(32, 64))
        salts = [self.salt, bytes(range(16, 32))]
        expected = {salt: hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, 32) for salt in salts}
        self.pages = [(str(i) + ".db", 4096, encrypted_page(expected[salt], salt)) for i, salt in enumerate(salts)]
        self.object(passphrase, field=0x10)
        keys, counts = self.scan()
        self.assertEqual(keys, expected)
        self.assertEqual(counts["candidate_count"], 1)

    def test_false_key_pattern_does_not_authorize_key(self):
        self.object(b"x'" + bytes(range(32, 64)).hex().encode() + self.salt.hex().encode() + b"'")
        keys, counts = self.scan()
        self.assertEqual(keys, {})
        self.assertEqual(counts["candidate_count"], 1)

    def test_embedded_salt_is_bound_to_its_database(self):
        wrong_salt = bytes(range(16, 32))
        self.object(b"x'" + self.key.hex().encode() + wrong_salt.hex().encode() + b"'")
        self.assertEqual(self.scan()[0], {})

    def test_same_salt_authenticates_every_supplied_page(self):
        other = encrypted_page(bytes(range(32, 64)), self.salt)
        self.pages.append(("second.db", 4096, other))
        self.object(b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'")
        self.assertEqual(self.scan()[0], {})

    def test_corrupt_hmac_is_rejected(self):
        corrupt = bytearray(self.pages[0][2])
        corrupt[-1] ^= 1
        self.pages = [("corrupt.db", 4096, bytes(corrupt))]
        self.object(b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'")
        self.assertEqual(self.scan()[0], {})

    def test_vtable_across_chunk_boundary_is_found(self):
        # The target pointer crosses a deliberately unaligned chunk boundary.
        self.object(b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'", offset=0x100)
        self.assertEqual(self.scan(chunk_size=259)[0], {self.salt: self.key})

    def test_pointer_must_be_inside_selected_regions(self):
        self.object(bytes(range(32)), field=0x10)
        struct.pack_into("<Q", self.memory, 0x100 + 0x18, self.base + len(self.memory) + 128)
        self.assertEqual(self.scan()[0], {})
        self.assertTrue(all(address + length <= self.base + len(self.memory) for address, length in self.reads))

    def test_page_size_and_version_bind_the_object(self):
        self.object(bytes(range(32)), field=0x10)
        struct.pack_into("<II", self.memory, 0x100 + 0x1D8, 1024, 3)
        keys, counts = self.scan()
        self.assertEqual(keys, {})
        self.assertEqual(counts["payload_count"], 0)

    def test_data_vtable_binds_the_field(self):
        self.object(bytes(range(32)), field=0x10)
        struct.pack_into("<Q", self.memory, 0x100 + 0x10, self.data_vtable + 16)
        self.assertEqual(self.scan()[1]["payload_count"], 0)

    def test_budget_stops_before_later_object(self):
        self.object(bytes(range(32)), field=0x10)
        keys, counts = self.scan(max_scan_bytes=64)
        self.assertEqual(keys, {})
        self.assertEqual(counts["scan_bytes"], 64)
        self.assertEqual(self.reads, [(self.base, 64)])

    def test_changing_key_field_is_discarded(self):
        self.object(b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'")

        def changing(address, length):
            blob = self.read(address, length)
            if length == 99:
                struct.pack_into("<Q", self.memory, 0x100 + 0x90 + 8, self.base + 0x800)
            return blob

        keys, counts = self.scan(changing)
        self.assertEqual(keys, {})
        self.assertEqual(counts["candidate_count"], 0)

    def test_partial_memory_reads_do_not_splice_unrelated_bytes(self):
        self.object(bytes(range(32)), field=0x10)

        def partial(address, length):
            blob = self.read(address, length)
            if address == self.base:
                return blob[:4]
            return blob

        keys, counts = self.scan(partial)
        self.assertEqual(keys, {})
        self.assertGreater(counts["read_errors"], 0)

    def test_repeated_payload_is_verified_once(self):
        decoded = b"x'" + self.key.hex().encode() + self.salt.hex().encode() + b"'"
        self.object(decoded)
        self.object(decoded, offset=0x400, pointer_offset=0x900)
        self.pages.append(("missing.db", 4096, encrypted_page(bytes(range(32, 64)), bytes(range(16, 32)))))
        keys, counts = self.scan(chunk_size=512)
        self.assertEqual(keys, {self.salt: self.key})
        self.assertEqual(counts["object_count"], 2)
        self.assertEqual(counts["candidate_count"], 1)

    def test_requested_database_subset_does_not_read_other_database(self):
        with tempfile.TemporaryDirectory(prefix="wcdb-selected-") as temporary:
            root = pathlib.Path(temporary)
            (root / "contact").mkdir()
            (root / "contact" / "contact.db").write_bytes(self.pages[0][2])
            # An unreadable/non-database body outside the requested scope must
            # not make selected contact collection fail.
            (root / "other.db").write_bytes(b"not-an-encrypted-database")
            pages = runtime.encrypted_first_pages(root, os.getuid(), ["contact/contact.db"])
            self.assertEqual([name for name, _size, _page in pages], ["contact/contact.db"])

    def test_requested_database_set_must_be_complete(self):
        with tempfile.TemporaryDirectory(prefix="wcdb-selected-") as temporary:
            root = pathlib.Path(temporary)
            (root / "present.db").write_bytes(self.pages[0][2])
            with self.assertRaisesRegex(ValueError, "集合不完整"):
                runtime.encrypted_first_pages(root, os.getuid(), ["present.db", "missing.db"])

    def test_requested_database_paths_must_be_canonical_and_unique(self):
        with tempfile.TemporaryDirectory(prefix="wcdb-selected-") as temporary:
            root = pathlib.Path(temporary)
            for paths in [[], ["same.db", "same.db"], ["../outside.db"], ["/absolute.db"],
                          ["./local.db"], ["a//b.db"], ["a\\b.db"], ["other.txt"]]:
                with self.subTest(paths=paths), self.assertRaises(ValueError):
                    runtime.encrypted_first_pages(root, os.getuid(), paths)


if __name__ == "__main__":
    unittest.main()
