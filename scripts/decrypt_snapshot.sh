#!/usr/bin/env bash
# Stable DB-only capture. No source writes, forced checkpoint, process stop,
# automatic HOME-cache copying, or partial-generation publication.
# Operator prerequisites: choose WECHAT_DB_ROOT explicitly; manually quiesce it;
# set WECHAT_SOURCE_QUIESCENT=1. WAL/SHM/journal or a changed inventory is refused.
# This is NOT an engine-level transaction across multiple databases.
# Optional cache config: WCDB_PASSPHRASE_FILE, else WCD_PASS_DIR, else the executing
# identity's HOME/.wcdb-key-tool. Only the Python command resolves this source.
# Live GDB capture is opt-in: WCDB_ALLOW_CAPTURE=1; stale cache replacement also
# needs WCDB_RECAPTURE=1. No automatic stop/restart/checkpoint of WeChat is done.
set -euo pipefail
umask 077
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${WECHAT_DB_ROOT:?Set WECHAT_DB_ROOT to an explicitly selected, quiescent db_storage}"
if [[ "${WECHAT_SOURCE_QUIESCENT:-}" != 1 ]]; then
  echo "先由操作员手动静止源数据库，再设置 WECHAT_SOURCE_QUIESCENT=1；本脚本不会停止微信。" >&2
  exit 1
fi
SNAPSHOT_DIR="${WECHAT_SNAPSHOT_DIR:-${PROJECT_DIR}/.snapshot}"
args=(snapshot --db-dir "${WECHAT_DB_ROOT}" --output "${SNAPSHOT_DIR}"
      --source-quiescent --timeout "${WECHAT_DECRYPT_TIMEOUT:-120}")
[[ "${WCDB_ALLOW_CAPTURE:-}" != 1 ]] || args+=(--allow-capture)
[[ "${WCDB_RECAPTURE:-}" != 1 ]] || args+=(--recapture)
command -v python3 >/dev/null || { echo "缺少 python3" >&2; exit 1; }
python3 "${PROJECT_DIR}/vendor/wcdb_key_tool.py" "${args[@]}"
echo "=== 全部输入验证成功，已原子发布 ==="
echo "DSH 的 WECHAT_SNAPSHOT_DIR 应指向: ${SNAPSHOT_DIR}/decrypted"
echo "仅新代参与查询；旧代保留在打印的私有 backup 目录。"
echo "新产物保持执行身份 0700/0600；普通 DSH 服务身份须单独安全配置访问，勿把 DSH 整体改为 root。"
echo "MCP 逻辑只读可能在可写快照目录创建 WAL/SHM；不会写回原始 WeChat 数据。"
