# DSH 插件布局

DSH WeChat RO 使用原生侧栏、会话和模型选择。客户端实现位于 [plugin/lib/client.js](plugin/lib/client.js)，完整模块职责见 [docs/architecture.md](docs/architecture.md)。

- 默认 bundle 通过 [plugin/cordis.patch.yml](plugin/cordis.patch.yml) 声明两项关闭快照读取的旧查询服务和一个受控微信 Task 预设。
- 原生微信连接使用 `wechatConversation` Owner RPC，复用宿主任务与工作区关联。
- 旧 `wechatRo` 查询接口和可选 Python MCP 读取独立解密副本，保持各自入口与数据范围。
- 设置、数据卡片和原文引用在原生界面展示。

接口说明见 [原生会话契约](docs/native-conversation-contract.md)，操作说明见 [使用指南](docs/getting-started.md)。
