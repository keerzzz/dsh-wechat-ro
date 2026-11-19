# 代码质量检查

## 检查内容

提交前对 JS/TS、Python、HTML 内联脚本、CSS、JSON/YAML 和 Shell 执行静态检查。外部工具使用固定版本，检查通过状态来自工具退出码与现有回归结果。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
pnpm --dir plugin install --frozen-lockfile --config.auto-install-peers=false
pnpm --dir plugin run check:quality
pnpm --dir plugin run test:ci
```

`check:quality` 通过 ESLint 检查语法、未使用局部绑定、未定义变量、重复键和不可达代码；使用 Ruff 检查 Python 语法、未使用导入/变量；解析 CSS 与 JSON/YAML，并执行 `bash -n`。TypeScript 消费者的赋值和类型别名是编译期正反例，由 `consumer-types` 门禁负责，不按运行时变量删除。

CI 在同一个 plugin Job 中先执行质量检查，再逐项运行七项独立离线门禁。

## 2026-11-19 全仓检查与清理

本次还通过 Knip 核对 DSH 的实际包出口、worker、声明和测试入口，并通过 Vulture 检查 Python 的跨文件未使用候选。

- 清理了 16 处未使用绑定及旧测试分支，移除 7 个内部多余的 export 声明。
- 删除 3 个一次性 MCP 探针；实际 stdio 握手与数据行为由既有回归覆盖。
- Knip 未发现孤立的插件代码文件或循环依赖。
- MCP 装饰器注册的工具、unittest 发现的测试类和 SQLite 的 `row_factory` 有实际入口。
- 默认与命名导出别名、声明源及 4 组 Python 打包副本承担真实宿主/分发用途。
- `runLocalHistory` 的动态导入回归、`listDatabases` / `clean` 的动态数据回归和 `DAILY_CARDS_SPEC` 的声明契约需要保留；静态未引用候选不能单独作为删除依据。

清理后对受影响的查询、原生客户端/Host、工作区、结构、消费者类型和管理界面逐项回归。原生回归仍需要另行提供兼容 SDK。

## 格式规范

现有源码同时采用紧凑 JS 与展开声明格式，默认 Prettier/Ruff 格式器会产生大范围差异。全仓格式重排尚未实施；需单独统一规范，并同步验证内嵌 wire 和生成声明的一致性。当前提交检查使用 `git diff --check`，持续质量门禁检查语法、无用绑定与配置。

静态检查能确认规则覆盖的代码问题；真实微信、每日跨日执行和完整宿主接入按 [使用指南](getting-started.md) 与 [工作流](github-workflow.md) 的现场步骤验收。
