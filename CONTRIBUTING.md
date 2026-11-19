# 贡献指南

使用短期功能分支和 Pull Request 协作，`main` 保持可用。完整流程见 [GitHub 工作流](docs/github-workflow.md)。

产品目标为 Windows、macOS、Linux 多系统接入。平台改动需分别记录宿主系统、来源微信版本与数据格式，验收要求见 [平台支持说明](docs/platform-support.md)。

## 环境与独立测试

当前公开 CI 使用 Linux、Node.js 24.15.0、pnpm 10.34.1、Python 3.12。安装及 DSH／SDK 版本见[安装指南](docs/installation.md#版本与兼容环境)，插件运行要求见 [plugin/package.json](plugin/package.json)。DSH 源码构建使用它自己的 `packageManager`，与插件独立依赖的 pnpm 版本分别记录。

在仓库根目录执行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
pnpm --dir plugin install --frozen-lockfile --config.auto-install-peers=false
pnpm --dir plugin run test:ci
```

`test:ci` 先运行 [全仓质量检查](docs/code-quality.md)，再运行 plugin 包的七项独立离线门禁。每项使用现有测试入口，串行执行，512 MiB 堆上限、120 秒超时。测试生成独立合成数据目录，不需要微信账号、DSH 工作区或真实数据库。

只验证某项时：

```bash
cd plugin
node scripts/run-tests.mjs --only test-daily-cards
```

DSH 客户端、声明和原生会话门禁需要另行准备兼容的 DSH SDK 开发环境；独立依赖安装不会提供这些能力。已有环境中的界面修改需运行 `test-conversation-client`，类型或接口修改需运行相应声明、消费者和 Host 门禁。真实扫码、手机收发与重启恢复在本人账号上另行验收。

本次原生桥接回归使用官方 npm DSH **0.2.2-rc.5**；插件的 `node_modules/@deepseek-ai` 依赖应解析到同一版本。客户端回归还需在该运行环境中安装 React/ReactDOM、Testing Library、JSDOM，以及官方客户端发布的 `/src/*` 辅助模块依赖。类型检查使用本插件的 TypeScript 6.0.3。

```bash
cd plugin
node scripts/run-tests.mjs --only declarations
node scripts/run-tests.mjs --only consumer-types
node scripts/run-tests.mjs --only test-session-bridge
node scripts/run-tests.mjs --only test-task-context
node scripts/run-tests.mjs --only test-conversation-host
WECHAT_UI_TEST_RUNTIME=/absolute/official-dsh-runtime \
  node scripts/run-tests.mjs --only test-conversation-client
```

每次只运行一个门禁，失败后先修复。原生桥接不依赖 DSH 源码 checkout，客户端回归只读取官方包导出的测试辅助源码，不改写宿主。
兼容 SDK peers 需由该开发环境提供。可选旧管理页的浏览器测试还需 `WECHAT_BROWSER_MODULE`（Playwright 模块路径）和 `WECHAT_DESIGN_PROBE_ROOT`（probe.mjs/rules.mjs 所在目录）；普通离线门禁不需要这些工具。

## 提交与审阅

1. 从最新 `main` 新建功能分支。Codex 分支使用 `codex/主题`。
2. 一次 PR 围绕一个用户行为或问题，复用现有接口和测试入口。
3. 提交格式为 `type(scope): 描述`，例如 `fix(history): preserve valid snapshots on refresh failure`。
4. 在 PR 中写清问题、结果、实际验证和重要兼容性变化。
5. CI 通过且讨论处理完后合并；多人协作时由另一位维护者审阅。

runtime 的 `plugin/lib/*.js` 是手写产物，`plugin/src/*.ts` 用于声明。修改协议、字典或声明时，同步对应内容并运行已有一致性门禁。`plugin/runtime/*.py` 从已审阅的 `scripts/`、`vendor/` 源文件同步，修改后运行 `pnpm --dir plugin run runtime` 并检查差异。

## 数据与许可证

公开 Issue、PR、截图和测试只使用合成或脱敏数据。真实数据库、密钥、扫码凭据、原始聊天及本机日志保留在本地；`.gitignore` 对应现有排除范围。安全问题按 [SECURITY.md](SECURITY.md) 私密报告。

原创贡献沿用 [MIT](LICENSE)。引入或修改第三方代码时保留原版权、许可证和来源，更新 [第三方声明](THIRD_PARTY_NOTICES.md)。
