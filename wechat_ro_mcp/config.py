"""Where the decrypted WeChat snapshot lives."""

from __future__ import annotations

import os
from pathlib import Path

ENV_VAR = "WECHAT_SNAPSHOT_DIR"


def snapshot_root() -> Path:
    """Directory containing the standard-SQLite databases produced by
    wcdb-key-tool. Override with WECHAT_SNAPSHOT_DIR (set this in the DSH
    cordis patch so the child process never depends on its CWD)."""
    env = os.environ.get(ENV_VAR, "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return (Path(__file__).resolve().parents[1] / "decrypted").resolve()
