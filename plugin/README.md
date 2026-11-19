# dsh-wechat-ro

WeChat history search and daily insight cards for DeepSeek Harness, targeting Windows, macOS and Linux.

本插件是多系统微信历史工作区的一部分，面向 Windows、macOS、Linux。平台进度见 [平台支持与适配](../docs/platform-support.md)。当前 Linux 的一键采集和原生历史 worker 已落地；Windows/macOS 的平台实现待补齐。

插件在 DSH 原生微信侧栏提供扫码连接、本人机器人自动文字回复、一键历史导入、搜索前更新、每分钟空闲检查和每日可视化卡片。重点和待办按群聊、个人、公众号、服务号区分，并按会话分组展示原文证据。

## 使用与环境

- [仓库首页](../README.md)
- [安装、连接与 MCP 指南](../docs/getting-started.md)
- [English guide](../docs/guide.en.md)
- [架构与数据口径](../docs/architecture.md)
- [原生接口说明](../docs/native-conversation-contract.md)

当前插件版本为 **0.2.1**，使用官方 **DSH `>=0.2.2-rc.5 <0.3.0`** 与 Node.js **`>=24.9.0`**。安装、版本和启用见[安装指南](../docs/installation.md)，升级见[迁移说明](../docs/upgrading-0.2.1.md)。Linux 微信 4.1.13.26 的采集已完成本机验证。

默认 [cordis.patch.yml](cordis.patch.yml) 插入两项关闭快照读取的旧查询服务和一个受控微信任务预设。加载插件后，通过微信侧栏完成连接及历史导入。`sourceRoot` 留空时，原生协调器使用当前宿主用户的 `Documents/xwechat_files` 作为受保护的原库路径；高级手动配置可指定其他原库位置。

[cordis.snapshot.example.yml](cordis.snapshot.example.yml) 是独立解密副本与 Python MCP 的可选手动示例，需替换项目、原库和副本路径。

## 单包测试

在仓库根目录执行：

```bash
pnpm --dir plugin install --frozen-lockfile --config.auto-install-peers=false
pnpm --dir plugin run test:ci
```

只执行一个门禁：

```bash
cd plugin
node scripts/run-tests.mjs --only test-daily-cards
```

`test:ci` 先执行全仓质量检查，再逐项串行运行七项独立门禁。质量规则见 [代码质量说明](../docs/code-quality.md)。完整声明、Host 和客户端测试需要另外配置 SDK，步骤见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

运行时 `lib/*.js` 为手写实现，`src/*.ts` 为声明源；修改接口时同步并验证声明。打包的 Python 文件由 `pnpm --dir plugin run runtime` 从仓库源文件同步。

## 当前进度

每日摘要覆盖有界，待办线索尚无负责人和完成状态管理。Host 重启需重新连接与导入。朋友圈和小程序内部数据未接入，其他微信构建和平台尚待适配。

MIT 许可证见 [LICENSE](LICENSE)，上游来源与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
