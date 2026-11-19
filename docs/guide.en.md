# WeChat history search for DeepSeek Harness

DSH WeChat RO connects a personal WeChat bot to a native DeepSeek Harness conversation. It imports local chat history into separate decrypted snapshots, searches by contact, date and keyword, and presents daily insight cards with original message citations.

## Features

- QR pairing and automatic text replies in the paired user's bot conversation.
- One-click history import from the supported Linux WeChat build.
- Refresh checks before searches and once per idle minute; new snapshots only when data changes.
- Daily metrics, a seven-day trend, message composition and conversation rankings.
- Evidence cards split into group chats, personal chats, public accounts and service accounts.
- A configurable daily update time, using Beijing time (`UTC+08:00`).
- An optional read-only Python MCP server for existing decrypted snapshots.

## Development setup

```bash
git clone https://github.com/keerzzz/dsh-wechat-ro.git
cd dsh-wechat-ro
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
pnpm --dir plugin install --frozen-lockfile --config.auto-install-peers=false
pnpm --dir plugin run test:ci
```

CI uses Node.js 24.15.0, pnpm 10.34.1 and Python 3.12. Seven independent plugin gates run serially with synthetic fixtures.

Native DSH integration requires a compatible host SDK and session extensions. A reproducible public SDK installation is still being prepared. In an existing compatible host, load `plugin/` through Plugin Manager, select a conversation directory and model, connect from the WeChat sidebar, then import history.

Linux WeChat 4.1.13.26 was validated locally for import, automatic updates and phone search replies. Other client builds, Windows and macOS require further adaptation and validation.

## Read-only MCP

Point `WECHAT_SNAPSHOT_DIR` at a separate decrypted SQLite snapshot:

```bash
WECHAT_SNAPSHOT_DIR=/absolute/private/snapshot/decrypted \
  .venv/bin/python -m wechat_ro_mcp
```

The stdio service provides status, contacts, sessions, messages, search, timeline, group members and restricted read-only SQL tools. See the [client configuration](getting-started.md#可选只读-mcp) and [DSH example](../deploy/wechat-ro.cordis.yml).

## Current progress

Daily summaries use bounded excerpts and display their coverage. To-do cards identify leads; ownership and completion tracking are pending. A real next-day scheduled run still needs on-device validation. Reconnect and reimport after host restarts.

Moments and internal mini-program data are not integrated. Dedicated parsing of mini-program chat cards also needs validation. Public and service account tabs classify imported chat records.

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for tests, SDK requirements and pull requests. Report bugs through [Issues](https://github.com/keerzzz/dsh-wechat-ro/issues), and security issues through [private vulnerability reporting](https://github.com/keerzzz/dsh-wechat-ro/security/advisories/new).

Original code is MIT licensed; upstream notices are retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). This is a community project.
