# 原生微信会话接口

接口的权威定义是运行时 [conversation-wire.js](../plugin/lib/conversation-wire.js) 与声明 [conversation-wire.ts](../plugin/src/conversation-wire.ts)。客户端内嵌 wire 实现由已有一致性门禁核对。

## 入口与身份

`wechatConversation` 使用两个 Owner 方法处理状态/来源查询与动作。普通只读会话和受控微信任务以明确请求分支区分；动作名称、字段和错误代码以源码为准。

任务 ID、工作区与来源代次共同确定访问范围。创建或恢复任务复用原生 SDK；恢复时通过当前目录注册表的工作区关联恢复侧栏归属，保持原权限身份。

状态读取不恢复连接授权、消息轮询或自动更新意图。正常连接动作核验目录和准确任务，再准备模型与微信配对。

## 查询与外发

授权档案限定独立副本目录、会话、日期和微信分享范围；查询 worker 使用显式预算。模型调用按来源代次记账，撤销或变代后阻断旧上下文的外发。

普通自动文字连接使用本人配对和持久队列。原生回合完成、微信接口接受与手机实际送达分别记录；结果未知时通过恢复操作核对。

图片与文档交付使用明确来源和本轮 `present` 记录；文件回传拥有自己的确认与校验流程。具体行为见 [conversation-controller.js](../plugin/lib/conversation-controller.js) 和 [task-access.js](../plugin/lib/task-access.js)。

## 验证

独立 CI 覆盖历史、卡片、协议、队列、诊断、查询访问与二维码七项门禁。原生 Host、消费者声明和客户端回归需要兼容 SDK，逐项运行既有 `run-tests.mjs --only` 入口，环境说明见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
