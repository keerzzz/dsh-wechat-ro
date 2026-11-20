# Cross-platform WeChat history workspace for DeepSeek Harness

DSH WeChat RO targets **Windows, macOS and Linux desktop WeChat**. The goal is one DeepSeek Harness workspace for history search, original message citations and daily insight cards, with platform-specific capture and file access. The current implemented capture and native archive worker are Linux-specific; see the [platform support plan](platform-support.md).

In the implemented environment, it connects a personal WeChat bot to a native DSH conversation and imports local history into separate decrypted snapshots.

## Features

- QR pairing and automatic text replies in the paired user's bot conversation.
- One-click history import on adapted platforms; Linux is implemented, Windows and macOS are pending.
- Refresh checks before searches and once per idle minute; new snapshots only when data changes.
- Daily metrics, a seven-day trend, message composition and conversation rankings.
- Evidence cards split into group chats, personal chats, public accounts and service accounts.
- A configurable daily update time, using Beijing time (`UTC+08:00`).
- An optional read-only Python MCP server for existing decrypted snapshots.

## Installation and DSH versions

Plugin **0.2.2-rc.2** supports the official **DSH `>=0.2.2-rc.5 <0.3.0`** release and **Node.js `>=24.9.0`**. Automatic replies use native DSH conversations; the previous sealed history and first-text workflows have been retired. Installation requires no DSH source changes. See the [installation guide](installation.md) and [upgrade notes](upgrading-0.2.1.md).

Open **Plugins → Add plugin** and enter this single address:

```text
https://github.com/keerzzz/dsh-wechat-ro/releases/download/v0.2.2-rc.2/dsh-wechat-ro-0.2.2-rc.2.tgz
```

Select **Install → Enable now**. If the host cannot reach GitHub, download the `.tgz` from the [Release](https://github.com/keerzzz/dsh-wechat-ro/releases/tag/v0.2.2-rc.2), copy it to the host and enter its absolute file path instead. Source installation commands in the [installation guide](installation.md) run in a terminal; the plugin dialog accepts one package address or the absolute path to `plugin/`, whose directory contains the bundle manifest.

Select a conversation directory and model, connect from the WeChat sidebar, then import history.

## Development setup

```bash
git clone https://github.com/keerzzz/dsh-wechat-ro.git
cd dsh-wechat-ro
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
pnpm --dir plugin install --frozen-lockfile --config.auto-install-peers=false
pnpm --dir plugin run test:ci
```

CI uses Node.js 24.15.0, pnpm 10.34.1 and Python 3.12. Independent plugin gates and distribution checks run serially with synthetic fixtures.

Native DSH integration requires the host capabilities listed in the installation guide. Development tests using SDK peers need a compatible SDK environment; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Linux WeChat 4.1.13.26 was validated locally for import, automatic updates and phone search replies. Windows and macOS require both capture and native archive-file access implementations, followed by on-platform validation. Existing decrypted snapshots can be evaluated through the separate Python MCP reader; their schemas and host platforms still need validation.

## Read-only MCP

Point `WECHAT_SNAPSHOT_DIR` at a separate decrypted SQLite snapshot:

```bash
WECHAT_SNAPSHOT_DIR=/absolute/private/snapshot/decrypted \
  .venv/bin/python -m wechat_ro_mcp
```

The stdio service provides status, contacts, sessions, messages, search, timeline, group members and restricted read-only SQL tools. See the [client configuration](getting-started.md#可选只读-mcp) and [DSH example](../deploy/wechat-ro.cordis.yml).

## Current progress

Daily summaries page through the full day, continue long text and merge validated batches. Completed batches persist and resume after input verification. Confirm a to-do lead as your task or name an assignee, then mark it complete or reopen it; confirmed tasks remain across report dates. Successful connection/import saves run intent. Host startup verifies the same Task, workspace, account and pairing before restoring updates and replies. A real model summary and repeated scheduled runs still need on-device validation.

Moments and internal mini-program data are not integrated. Dedicated parsing of mini-program chat cards also needs validation. Public and service account tabs classify imported chat records.

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for tests, SDK requirements and pull requests. Report bugs through [Issues](https://github.com/keerzzz/dsh-wechat-ro/issues), and security issues through [private vulnerability reporting](https://github.com/keerzzz/dsh-wechat-ro/security/advisories/new).

Original code is MIT licensed; upstream notices are retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). This is a community project.
