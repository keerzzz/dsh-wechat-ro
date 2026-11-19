"""Read-only MCP bridge over a decrypted WeChat 4.x SQLite snapshot.

Nothing in this package writes to any WeChat file. Every SQLite connection is
opened with mode=ro and PRAGMA query_only=ON.
"""

__version__ = "0.1.0"
