#!/usr/bin/env python3
"""Local-only media analysis. Inputs are staged by the authorized plugin caller."""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import xml.etree.ElementTree as ET
import zipfile

VERSION = 4
MAX_BYTES = 64 * 1024 * 1024
MAX_SECONDS = 300
MAX_TEXT = 16000


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', *map(str, args)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)


def transcribe(path: Path, work: Path, model: Path) -> dict:
    from faster_whisper import WhisperModel
    with path.open('rb') as source:
        raw = source.read(16)
    source = path
    if b'#!SILK_V3' in raw:
        import pilk
        pcm = work / 'voice.pcm'
        pilk.decode(str(path), str(pcm))
        source = work / 'voice.wav'
        ffmpeg('-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, '-t', MAX_SECONDS, source)
    wav = work / 'audio.wav'
    ffmpeg('-i', source, '-t', MAX_SECONDS, '-vn', '-ar', '16000', '-ac', '1', wav)
    if not (model / 'model.bin').is_file():
        raise RuntimeError('LOCAL_ASR_MODEL_REQUIRED')
    engine = WhisperModel(str(model), device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)
    segments, info = engine.transcribe(str(wav), beam_size=5, language='zh', vad_filter=True)
    rows = [{'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip()} for s in segments]
    return {'text': '\n'.join(r['text'] for r in rows), 'segments': rows, 'duration': info.duration,
            'partial': info.duration >= MAX_SECONDS - 0.1, 'engine': 'faster-whisper-small-cpu-int8'}


def ocr(path: Path) -> dict:
    from PIL import Image
    from rapidocr import RapidOCR
    Image.MAX_IMAGE_PIXELS = 20_000_000
    with Image.open(path) as image:
        if image.width * image.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError('IMAGE_PIXEL_BUDGET')
        image.verify()
    result = RapidOCR()(str(path))
    txts = list(result.txts or [])
    scores = [round(float(score), 4) for score in (result.scores or [])]
    return {'text': '\n'.join(txts), 'lines': [{'text': text, 'confidence': score} for text, score in zip(txts, scores)], 'engine': 'rapidocr-local-onnx'}


def wxgf_preview(path: Path, work: Path) -> list[Path]:
    from PIL import Image
    data = path.read_bytes()
    start = data.find(b'\x00\x00\x00\x01', 4)
    if not data.startswith(b'wxgf') or start < 0:
        raise ValueError('WXGF_HEVC_REQUIRED')
    stream = work / 'image.hevc'; stream.write_bytes(data[start:])
    ffmpeg('-threads', '2', '-f', 'hevc', '-i', stream, '-frames:v', '3', work / 'preview-%02d.png')
    frames = list(sorted(work.glob('preview-*.png')))
    if not frames:
        raise ValueError('WXGF_FRAME_REQUIRED')
    for frame in frames:
        with Image.open(frame) as image:
            if image.width * image.height > 20_000_000:
                raise ValueError('IMAGE_PIXEL_BUDGET')
    return frames


def document(path: Path, work: Path) -> dict:
    suffix = path.suffix.lower()
    if suffix == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        texts = []; scanned = []; render_doc = None
        try:
            for index, page in enumerate(reader.pages[:100]):
                text = page.extract_text() or ''
                if not text.strip() and len(scanned) < 10:
                    import pypdfium2 as pdfium
                    if render_doc is None:
                        render_doc = pdfium.PdfDocument(str(path))
                    render_page = render_doc[index]
                    bitmap = render_page.render(scale=min(2, 1600 / max(render_page.get_size())))
                    image = bitmap.to_pil(); image_path = work / f'page-{index + 1}.png'
                    image.save(image_path); image.close(); bitmap.close(); render_page.close()
                    text = ocr(image_path)['text']; scanned.append(index + 1)
                texts.append(f'[Page {index + 1}]\n{text}')
        finally:
            if render_doc is not None: render_doc.close()
        empty_pages = sum(not (page.extract_text() or '').strip() for page in reader.pages[:100])
        return {'text': '\n'.join(texts), 'pages': len(reader.pages), 'ocrPages': scanned,
                'partial': len(reader.pages) > 100 or empty_pages > 10, 'engine': 'pypdf-pdfium-rapidocr-local'}
    if suffix in ('.docx', '.pptx', '.xlsx'):
        with zipfile.ZipFile(path) as archive:
            total = 0
            def read_xml(name):
                nonlocal total
                entry = archive.getinfo(name); total += entry.file_size
                if total > 32 * 1024 * 1024:
                    raise ValueError('DOCUMENT_EXPANSION_BUDGET')
                raw = archive.read(name)
                if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
                    raise ValueError('DOCUMENT_XML_ENTITY')
                return ET.fromstring(raw)
            if suffix == '.xlsx':
                ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                strings = []
                if 'xl/sharedStrings.xml' in archive.namelist():
                    strings = [''.join(t.text or '' for t in si.findall('.//s:t', ns)) for si in read_xml('xl/sharedStrings.xml').findall('s:si', ns)]
                labels = {}
                if 'xl/workbook.xml' in archive.namelist() and 'xl/_rels/workbook.xml.rels' in archive.namelist():
                    rels = {node.get('Id'): node.get('Target') for node in read_xml('xl/_rels/workbook.xml.rels')}
                    for sheet in read_xml('xl/workbook.xml').findall('s:sheets/s:sheet', ns):
                        target = rels.get(sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'), '')
                        labels[target.lstrip('/') if target.startswith('/') else 'xl/' + target] = sheet.get('name', '')
                texts = []
                for name in sorted(n for n in archive.namelist() if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')):
                    cells = []
                    for cell in read_xml(name).findall('.//s:sheetData/s:row/s:c', ns):
                        value = cell.find('s:v', ns); text = value.text if value is not None else ''
                        if cell.get('t') == 's':
                            text = strings[int(text)]
                        elif cell.get('t') == 'inlineStr':
                            text = ''.join(t.text or '' for t in cell.findall('.//s:t', ns))
                        formula = cell.find('s:f', ns)
                        if formula is not None: text = (text or '') + ' [=' + (formula.text or '') + ']'
                        if text: cells.append((cell.get('r') or '?') + ': ' + text)
                    texts.append('[' + (labels.get(name) or name) + ']\n' + '\n'.join(cells))
            else:
                names = [n for n in archive.namelist() if n == 'word/document.xml' or n.startswith('ppt/slides/slide') and n.endswith('.xml')]
                texts = ['\n'.join(node.text for node in read_xml(name).iter() if node.tag.rsplit('}', 1)[-1] == 't' and node.text) for name in sorted(names)]
            return {'text': '\n'.join(texts), 'engine': 'office-openxml-local'}
    return {'text': path.read_text(encoding='utf-8'), 'engine': 'utf8-local'}


def analyze(path: Path, cache: Path, model: Path) -> dict:
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise ValueError('MEDIA_BYTE_BUDGET')
    with path.open('rb') as source:
        sha = hashlib.file_digest(source, 'sha256').hexdigest()
    key = hashlib.sha256(f'{VERSION}/{sha}/{path.suffix.lower()}'.encode()).hexdigest()
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    output = cache / (key + '.json')
    if output.exists():
        return {**json.loads(output.read_text()), 'cached': True}
    with tempfile.TemporaryDirectory(prefix='analysis-', dir=cache) as temporary:
        work = Path(temporary)
        suffix = path.suffix.lower()
        if suffix == '.wxgf':
            previews = wxgf_preview(path, work)
            assets = cache / 'assets'; assets.mkdir(mode=0o700, exist_ok=True)
            image_files = []; texts = []
            for index, preview in enumerate(previews):
                name = sha + '-frame-' + str(index).zfill(2) + '.png'
                shutil.copyfile(preview, assets / name); (assets / name).chmod(0o600)
                image_files.append({'name': name, 'frame': index})
                texts.append(f'[WXGF frame {index + 1}] ' + ocr(preview)['text'])
            result = {'text': '\n'.join(texts), 'imageFiles': image_files, 'convertedFrom': 'wxgf-hevc-frames', 'partial': True, 'engine': 'ffmpeg-rapidocr-local'}
        elif suffix in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'):
            result = ocr(path)
        elif suffix in ('.silk', '.wav', '.mp3', '.m4a', '.ogg', '.aac', '.flac'):
            result = transcribe(path, work, model)
        elif suffix in ('.mp4', '.mov', '.mkv', '.webm'):
            frames = []
            ffmpeg('-i', path, '-t', MAX_SECONDS, '-vf', 'fps=1/30:start_time=0:round=up,scale=1280:-2', '-frames:v', '10', work / 'frame-%02d.png')
            assets = cache / 'assets'; assets.mkdir(mode=0o700, exist_ok=True)
            image_files = []
            for index, frame in enumerate(sorted(work.glob('frame-*.png'))):
                value = ocr(frame); frames.append({'seconds': index * 30, 'text': value['text']})
                name = sha + '-frame-' + str(index).zfill(2) + '.png'
                shutil.copyfile(frame, assets / name); (assets / name).chmod(0o600)
                image_files.append({'name': name, 'seconds': index * 30})
            try:
                audio = transcribe(path, work, model)
            except subprocess.CalledProcessError:
                audio = {'text': '', 'segments': [], 'audioUnavailable': True}
            result = {'text': '\n'.join([audio['text'], *[f"[{f['seconds']}s] {f['text']}" for f in frames]]), 'frames': frames, 'imageFiles': image_files, 'audio': audio, 'partial': True, 'engine': 'ffmpeg-rapidocr-whisper-local'}
        else:
            result = document(path, work)
    result = {**result, 'version': VERSION, 'sha256': sha, 'bytes': size, 'cached': False,
              'truncated': len(result['text']) > MAX_TEXT, 'text': result['text'][:MAX_TEXT], 'untrusted': True}
    # Leave room for the host's image references in the existing 64 KiB tool page.
    if len(json.dumps(result, ensure_ascii=False).encode()) > 48000:
        result.pop('lines', None); result.pop('segments', None)
        if isinstance(result.get('audio'), dict):
            result['audio'] = {'text': result['audio'].get('text', '')[:4000]}
        for frame in result.get('frames', []): frame['text'] = frame['text'][:400]
        result['truncated'] = True
        while len(json.dumps(result, ensure_ascii=False).encode()) > 48000 and result['text']:
            result['text'] = result['text'][:-1000]
    # Cache only successful results; failed or missing models are retried later.
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream, ensure_ascii=False)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    args = parser.parse_args()
    try:
        with redirect_stdout(sys.stderr):
            value = analyze(args.input, args.cache, args.model)
        print(json.dumps({'ok': True, 'result': value}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': 'LOCAL_ASR_MODEL_REQUIRED' if str(error) == 'LOCAL_ASR_MODEL_REQUIRED' else type(error).__name__}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
