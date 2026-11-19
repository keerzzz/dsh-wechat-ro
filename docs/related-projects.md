# 相关开源实现调查

调查日期：2026-11-20。依据是 GitHub README、许可证、具体源码和测试源码；下表的平台状态属于上游说明，未在本项目环境逐个平台运行。

| 项目 | 已核对的能力 | 许可证 | 对本插件的用途 |
| --- | --- | --- | --- |
| [ChisBread/wechat-ai](https://github.com/ChisBread/wechat-ai) | Linux DAT 缓存派生、已知图片探针、文本及原始内存候选验证、wxgf 的 HEVC 预览、MCP 和 RPA | GPL-3.0-or-later | 最接近本机媒体问题的研究参考；保持 MIT 插件时不能直接复制 GPL 实现 |
| [qiaodogbear/ChatTrace](https://github.com/qiaodogbear/ChatTrace) | Windows 微信 4.1.x、V2 缓存派生、图片/语音/视频定位与导出、增量读取 | MIT | 缓存派生与媒体关联的可复用参考；其 Windows 验收不能替代本插件的 Linux 验收 |
| [sgaofen/murmur](https://github.com/sgaofen/murmur) | Windows/macOS 聊天及朋友圈、WAL 增量、FTS5、可选本地语义索引、MCP、关系卡片、wxgf 内嵌封面提取 | MIT | 增量索引、搜索和数据展示；其取钥方式按平台区别处理 |
| [dueti/wechat-export](https://github.com/dueti/wechat-export) | macOS 图片关联、缓存派生、FFmpeg HEVC 解码、Markdown 导出、语音文字回填 | MIT | 小型导出流程及 wxgf 研究参考；语音回填依赖已有文字 |
| [TANGandXUE/wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool) | Linux/macOS/Windows 数据库密钥原料恢复与 PBKDF2；Linux/macOS 新版本路线包含调试器 | MIT | 数据库解密基础；数据库密钥和图片媒体密钥需要分开验证 |
| [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp) | iLink 扫码、ACP 会话、入站附件保存、图片/音频/文件输出、守护与恢复设置 | MIT | 机器人非文本附件链路的优先参考；不会替本插件读取桌面历史 |

另有 [huohuoer/wechat-cli](https://github.com/huohuoer/wechat-cli)，Apache-2.0，提供联系人、聊天、收藏、搜索、统计和增量命令。README 的 npm 安装包当前只内置 macOS arm64 二进制，不能仅凭三平台徽章判定本机 Linux 版本已经兼容。

## 当前问题的直接证据

两份源码独立提供同一 V2 派生关系：缓存 `key_<code>_*.statistic` 中的数字与账号标识拼接，对其计算 MD5，取前 16 个十六进制字符的 ASCII 字节作为 AES-128 密钥；XOR 字节为 `code & 255`。

- [ChatTrace image_key.py](https://github.com/qiaodogbear/ChatTrace/blob/f9fcdb42e8fb99a527c0bcd7d6ff7ea4bc891563/src/chattrace/service/image_key.py)
- [wechat-ai DAT key discovery](https://github.com/ChisBread/wechat-ai/blob/5798de6cadbffb269eafeaf8b268c6cdb1d7e1b3/src/wechat_ai_bot/services/core/wechat_dat_key_discovery.py)
- [wechat-ai wxgf preview](https://github.com/ChisBread/wechat-ai/blob/5798de6cadbffb269eafeaf8b268c6cdb1d7e1b3/src/wechat_ai_bot/services/core/wechat_image.py)
- [Murmur media.py](https://github.com/sgaofen/murmur/blob/b9647f70d937fa42b8a59ef9105dd1fb3e5f5423/cli/media.py)
- [wechat-acp README](https://github.com/formulahendry/wechat-acp#features)

本机验收：调查时已有一个 kvcomm 缓存文件；派生候选同时解开两个不同的 V2 图片头。随后完整解码两张原图，Pillow 加载成功，RGB 像素 SHA-256 与用户提供的两张原图逐一相同，尺寸为 556×204 和 267×87。真实账号、缓存数字、密钥、原图及像素指纹不进入仓库。该结果证明当前账号的这两张图片链路有效；缓存文件出现的原因尚未独立验证。

## 落地顺序

1. 优先以本机 kvcomm 派生并验证媒体密钥，复用现有 DAT 解码。候选验证失败才考虑明确发起的诊断路径。
2. 依据已解密的资源记录关联附件；区分原图、高质量图与缩略图，保留原记录引用。
3. wxgf 先检查内嵌封面，再验证 HEVC 画面；首帧可能为空，须用多帧样例核验。当前插件尚未完成真实 wxgf 验收。
4. 参考 wechat-acp 的 iLink 媒体协议，在现有机器人入口接入入站附件；继续使用 DSH 当前模型和插件工具。
5. 本地批量索引增加持久游标与成功缓存，单包串行测试后再验收搜索和每日卡片。

优先复用现有入口与成熟格式实现，不引入整套 RPA 宿主、独立智能体或第二个数据服务。保留 MIT 项目时，复制 MIT/Apache 源码需要保留相应版权和许可声明；GPL 项目在本阶段作为公开格式研究参考。
