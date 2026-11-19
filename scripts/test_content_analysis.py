#!/usr/bin/env python3
"""Deterministic local document regressions; no models or network required."""
from pathlib import Path
import tempfile
import unittest
import zipfile
from analyze_content import analyze, document


class ContentTests(unittest.TestCase):
    def test_xlsx_string_positions_and_formula(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'sheet.xlsx'
            ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('xl/sharedStrings.xml', f'<sst xmlns="{ns}"><si><t>中文名称</t></si><si><r><t>分段</t></r><r><t>文字</t></r></si></sst>')
                archive.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="验收表" r:id="rId1"/></sheets></workbook>')
                archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
                archive.writestr('xl/worksheets/sheet1.xml', f'<worksheet xmlns="{ns}"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C3" t="inlineStr"><is><t>内联文字</t></is></c><c r="D4"><f>SUM(E1:E2)</f><v>42</v></c></row></sheetData></worksheet>')
            text = document(path, root)['text']
            self.assertEqual(text, '[验收表]\nA1: 中文名称\nB2: 分段文字\nC3: 内联文字\nD4: 42 [=SUM(E1:E2)]')

    def test_docx_and_entity_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'document.docx'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('word/document.xml', '<document><p><t>正文验收</t></p></document>')
            self.assertEqual(document(path, root)['text'], '正文验收')
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('word/document.xml', '<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><doc>&x;</doc>')
            with self.assertRaisesRegex(ValueError, 'DOCUMENT_XML_ENTITY'):
                document(path, root)

    def test_success_cache_and_changed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'text.txt'; cache = root / 'cache'
            path.write_text('本地缓存验收')
            first = analyze(path, cache, root)
            self.assertFalse(first['cached']); self.assertTrue(analyze(path, cache, root)['cached'])
            path.write_text('内容已更新')
            second = analyze(path, cache, root)
            self.assertNotEqual(first['sha256'], second['sha256']); self.assertEqual(second['text'], '内容已更新')


if __name__ == '__main__':
    unittest.main()
