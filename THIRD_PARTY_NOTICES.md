# 第三方代码声明

本仓库原创代码采用 MIT。以下第三方代码保留其原版权和许可证。

## wcdb-key-tool

- 来源：https://github.com/TANGandXUE/wcdb-key-tool
- 本地改编：`vendor/wcdb_key_tool.py` 及打包副本 `plugin/runtime/wcdb_key_tool.py`。
- 许可证：[vendor/LICENSE.wcdb-key-tool](vendor/LICENSE.wcdb-key-tool)。

本地改编包含私有快照、范围与完整性检查；这些修改不改变上游版权。许可证于 2026-11-19 从上游取得，LICENSE blob 为 `741c6f868bf3634c2c17d672eaab1cef9ca0b4ae`。

## Tencent/openclaw-weixin

微信接口和媒体线形状的参考版本、文件摘要及完整 MIT 文本保存在 [plugin/THIRD_PARTY_NOTICES.md](plugin/THIRD_PARTY_NOTICES.md)。

## 运行依赖

Node.js 和 Python 依赖由包管理器安装，版本范围与锁文件分别见 `plugin/package.json`、`plugin/pnpm-lock.yaml` 和 `requirements.txt`。分发依赖时保留各包附带的许可证。
