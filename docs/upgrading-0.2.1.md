# 升级到插件 0.2.1

插件 0.2.1 使用官方 DSH 0.2.2-rc.5 的公开接口。自动回复继续在原生会话执行；微信历史导入、搜索前刷新、每分钟检查、每日卡片和通信均由插件承担。

## 升级步骤

1. 有 DSH 源码改动时，先保存提交或 `git stash push --include-untracked`，再升级官方版本。保留原 profile 和数据目录。
2. 安装 Node.js 24.9.0 或更新版本，用官方 `@deepseek-ai/dsh@0.2.2-rc.5` 启动原 Web profile。
3. 更新本插件 checkout，并运行 `pnpm --dir plugin install --prod --frozen-lockfile --config.auto-install-peers=false`。
4. 在插件管理器重新启用插件；需要重启时关闭原 Host 后再启动，使用同一份 profile。
5. 打开原微信会话，点击连接，并导入历史。核对模型选择、查询结果、数据卡片和每天生成时间。

## 行为变化

- 模型与推理等级在 DSH 原生输入区选择。微信侧栏的打开对话入口进入对应的原生会话。
- 旧 `sealedHistory` / `sealedFirstText` 单次封印执行入口退出。已有审计记录保留可读、可撤销；旧许可不会启动模型或消息发送。
- 工具执行使用官方 `NativeToolExecutor` 和 `tools.setExecutor()`。插件只向微信任务提供已授权的工具目录。
- 微信侧栏按官方实现 ID 渲染，并复用对应标签类型和原会话标识。

## 验收

在桌面文件传输助手发送一个新标记，随后在本人微信机器人请求检索该标记。核对原文、本地时间、记录引用和副本更新时间。再检查每日卡片的群聊、个人、公众号、服务号分类及时间设置。

Linux 微信 4.1.13.26 是当前已验证采集环境；Windows/macOS 采集适配、朋友圈和小程序数据接入进度见[平台说明](platform-support.md)。
