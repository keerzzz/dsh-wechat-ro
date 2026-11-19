# DSH WeChat RO — 多系统微信历史搜索与每日数据卡片

[![CI](https://github.com/keerzzz/dsh-wechat-ro/actions/workflows/ci.yml/badge.svg)](https://github.com/keerzzz/dsh-wechat-ro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A WeChat history workspace for DeepSeek Harness targeting Windows, macOS and Linux, with history search, daily insight cards and read-only MCP.**

项目面向 **Windows、macOS、Linux 桌面微信**，将各系统的本人微信历史接入统一的 DeepSeek Harness（DSH）工作区，提供联系人、日期和关键词搜索，以及带原文引用的每日数据卡片。采集和文件访问按平台适配，查询、证据与卡片口径共用。当前已落地和验收的采集链路为 Linux，三平台进度见下表。

在已适配环境中，可通过原生微信侧栏扫码连接、一键导入历史。搜索前检查更新，空闲时每分钟检查一次；每天生成卡片的时间可在设置中选择。

[安装与 DSH 版本](docs/installation.md) · [平台支持与适配](docs/platform-support.md) · [使用指南](docs/getting-started.md) · [本地内容分析](docs/content-analysis.md) · [English guide](docs/guide.en.md) · [架构与数据口径](docs/architecture.md) · [开发工作流](docs/github-workflow.md) · [代码质量](docs/code-quality.md) · [贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md)

## 功能

| 能力 | 用户操作与结果 |
| --- | --- |
| 微信机器人 | 选择原生会话目录和模型，扫码连接，在本人机器人对话接收自动文字回复 |
| 一键历史导入 | 从已适配平台的本机微信生成独立解密副本；当前 Linux 链路已实现，Windows/macOS 待适配 |
| 自然语言搜索 | 按姓名、相对日期和关键词检索，返回原文、北京时间和记录引用 |
| 自动更新 | 搜索前检查变化；空闲时每分钟检查，有变化才更新副本 |
| 每日数据卡片 | 指标、近 7 天趋势、消息构成、会话排名，以及带证据的重点和待办线索 |
| 来源分类 | 群聊、个人、公众号、服务号分别展示，卡片按来源会话分组 |
| 可选 MCP | 为支持 MCP 的客户端提供联系人、会话、消息、搜索和时间线等只读工具 |

查询示例：

```text
整理李明近 7 天的聊天内容，列出原文和北京时间。
搜索今天文件传输助手里的“项目验收”，给出记录引用。
总结昨天群聊中的重点和待办线索。
```

示例姓名与关键词为演示数据。

## 快速开始

插件当前版本 **0.2.2-rc.1**，支持官方 **DSH `>=0.2.2-rc.5 <0.3.0`**，Node.js **`>=24.9.0`**。本机验证使用官方 npm DSH **0.2.2-rc.5**、Node.js **24.15.0**、pnpm **10.34.1**。安装与启用见[安装指南](docs/installation.md)，已有用户见[升级说明](docs/upgrading-0.2.1.md)。

打开 DSH **插件 → 添加插件**，在 **包名或地址** 中只填写这一行：

```text
https://github.com/keerzzz/dsh-wechat-ro/releases/download/v0.2.2-rc.1/dsh-wechat-ro-0.2.2-rc.1.tgz
```

点击 **安装 → 立即启用**。这是包含运行入口、界面和采集助手的预构建包。进入原生会话，选择目录和模型，打开微信侧栏并扫码；随后一键导入历史，再设置每日卡片更新时间。

如果宿主无法访问 GitHub，先从 [Release](https://github.com/keerzzz/dsh-wechat-ro/releases/tag/v0.2.2-rc.1) 下载 `.tgz` 并传到宿主，在同一输入框填写该文件的绝对路径。

### 从源码安装

以下命令在运行 DSH 的电脑的**终端**执行：

```bash
git clone https://github.com/keerzzz/dsh-wechat-ro.git
cd dsh-wechat-ro
pnpm --dir plugin install --prod --frozen-lockfile --config.auto-install-peers=false
```

然后在 DSH **包名或地址** 中填写本仓库 `plugin/` 的绝对路径，安装后点击 **立即启用**。仓库根目录没有插件 manifest；直接填写仓库首页地址或粘贴上面的终端命令会安装失败。

新建 DSH 环境、三系统路径、CLI 安装及首次验收见[安装指南](docs/installation.md)。开发依赖和单包串行测试见[贡献指南](CONTRIBUTING.md#环境与独立测试)。

只使用 MCP 时，先按[安装指南](docs/installation.md#只需要-mcp-或开发测试)准备 Python 环境，将 `WECHAT_SNAPSHOT_DIR` 指向独立解密副本，再运行：

```bash
WECHAT_SNAPSHOT_DIR=/absolute/private/snapshot/decrypted \
  .venv/bin/python -m wechat_ro_mcp
```

这会启动 stdio MCP 服务；客户端配置见[使用指南](docs/getting-started.md#可选只读-mcp)。

## 平台支持与进度

| 目标系统 | 一键采集与自动更新 | 原生历史查询 | 当前验证 |
| --- | --- | --- | --- |
| Windows | 待实现平台采集 | 待适配路径和文件读取 | 待环境验收 |
| macOS | 待实现平台采集 | 待适配文件读取 | 待环境验收 |
| Linux | 已实现 | 已实现 | 微信 **4.1.13.26** 已完成本机端到端验收 |

Linux 的已验证记录包括历史导入、自动更新、手机搜索回复和北京时间。当前采集使用 `/proc`、系统认证及已核验构建；原生查询 worker 使用 Linux 文件描述符路径。因此跨系统工作同时包含采集和原生文件查询的适配。平台、微信版本与数据格式分别验收，详见[平台支持说明](docs/platform-support.md)。

每日摘要目前使用有界摘录，界面显示实际覆盖范围。待办卡片表示从历史提取的线索，负责人、完成状态和闭环追踪待实现。真实次日定时执行尚待现场验收；Host 重启后需重新连接和导入。

朋友圈、小程序聊天/收藏卡片、通讯录及本地媒体文字索引已接入。小程序内部业务数据需具体导出或 API。公众号与服务号的分类覆盖已导入的聊天记录。

公开 CI 串行检查离线能力和实际发布包；DSH UI、原生会话和真实微信收发需要兼容 SDK 与本人账号另行验证。

## 项目结构

```text
plugin/          DSH 插件、原生界面、运行时与单包测试
wechat_ro_mcp/   Python 只读 MCP 服务
scripts/        本地历史准备与快照验证
vendor/         WCDB 工具及本地改编
deploy/         可选 MCP 配置示例
docs/           使用、架构、开发与维护指南
.github/        CI、Issue/PR 模板、CODEOWNERS 与依赖更新
```

历史查询采用独立 SQLite 副本；一键导入在首次需要取钥时调用系统认证。机器人配对、模型处理和微信外发在微信连接流程中确认。数据库、密钥和聊天日志保留在本地，详见[架构与数据口径](docs/architecture.md)。

## 贡献与许可证

欢迎通过 [Issues](https://github.com/keerzzz/dsh-wechat-ro/issues) 提交可复现的故障或功能建议，通过 Pull Request 贡献改进。环境、验证和提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题使用[私密报告](https://github.com/keerzzz/dsh-wechat-ro/security/advisories/new)。

原创代码采用 [MIT](LICENSE)。第三方代码保留原许可证与来源，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为社区开发的 DSH 插件。
