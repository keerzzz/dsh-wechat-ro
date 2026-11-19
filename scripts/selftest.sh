#!/usr/bin/env bash
# Synthetic fixture only; require explicit isolated paths, never the default
# tests/fixture_snapshot (make_fixture.py replaces files in its output directory).
set -euo pipefail
umask 077
: "${WECHAT_FIXTURE_DIR:?Set an explicit fresh synthetic fixture directory}"
: "${WECHAT_SNAPSHOT_DIR:?Set this to the same synthetic fixture directory}"
: "${TMPDIR:?Set an explicit private test temporary directory}"
export PYTHONDONTWRITEBYTECODE=1
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_DIR}"
export PYTHONPATH="${PROJECT_DIR}${PYTHONPATH:+:${PYTHONPATH}}"
PY="${PROJECT_DIR}/.venv/bin/python"
[[ -x "${PY}" ]] || PY="$(command -v python3)"
"${PY}" - <<'PY'
import os
from pathlib import Path
fixture = Path(os.environ["WECHAT_FIXTURE_DIR"])
snapshot = Path(os.environ["WECHAT_SNAPSHOT_DIR"])
temporary = Path(os.environ["TMPDIR"])
for path in (fixture, snapshot, temporary):
    if not path.is_absolute() or path.resolve() != path or ".." in path.parts:
        raise SystemExit("测试路径必须为不含符号链接的绝对路径")
if fixture != snapshot:
    raise SystemExit("WECHAT_FIXTURE_DIR 与 WECHAT_SNAPSHOT_DIR 必须相同")
if fixture.exists():
    raise SystemExit("fixture 目标必须全新；拒绝覆盖任何既有目录")
temporary.mkdir(mode=0o700, parents=True, exist_ok=True)
if temporary.stat().st_uid != os.geteuid() or temporary.stat().st_mode & 0o777 != 0o700:
    raise SystemExit("TMPDIR 必须为当前身份的 0700 私有目录")
fixture.mkdir(mode=0o700, parents=True)
PY

echo "=== 1/3 生成合成解密库（显式隔离路径） ==="
"${PY}" tests/make_fixture.py >/dev/null
echo "=== 2/3 直接调用 service 函数 ==="
"${PY}" tests/test_service.py
echo "=== 3/3 通过 MCP stdio 协议调用工具 ==="
"${PY}" tests/test_mcp_stdio.py
echo "SELFTEST_OK — 仅合成数据闭环；未覆盖真实 WCDB/GDB/在线采集"
