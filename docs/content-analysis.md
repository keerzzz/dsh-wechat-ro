# 本地内容与模型分析

微信历史的批量文字处理在本机完成。侧栏“历史来源”按朋友圈、小程序、收藏、通讯录、语音、图片与视频分开展示；每项保留来源、北京时间和记录引用。朋友圈来自桌面客户端已缓存的数据，小程序来自聊天及收藏卡片中的标题、链接与正文。

语音先解码 SILK，再使用 Whisper small 生成转写。转写属于派生文本，可结合原语音核对；保存后随下一次历史更新进入搜索。图片使用 RapidOCR，PDF 提取正文，扫描页使用 PDFium 渲染后 OCR。DOCX、PPTX 提取文本；XLSX 输出工作表名、单元格位置、实际字符串、缓存值与公式。

选中图片或视频时，可开启“将选中的图片和视频画面交给当前模型理解”。插件调用 DSH 原生附件服务，把所选原图或视频抽帧交给当前支持图片输入的模型。批量索引不会启用这一开关。普通文件可在任务对话中请求：`分析工作区中的 image.png`、`转写 voice.silk`、`整理 report.pdf`。

## 安装本地处理环境

在已安装插件的电脑准备 Python 3.11 或 3.12 和 FFmpeg。下面的路径与插件默认路径一致：

```bash
python3 -m venv "$HOME/.local/share/dsh-wechat-ro/content-runtime"
"$HOME/.local/share/dsh-wechat-ro/content-runtime/bin/python" -m pip install -r requirements-content.txt
```

Windows 使用 `python -m venv` 创建 `%USERPROFILE%\.local\share\dsh-wechat-ro\content-runtime`，然后运行 `Scripts\python.exe -m pip install -r requirements-content.txt`。可用 `WECHAT_CONTENT_PYTHON` 指定 Python 的完整路径。

首次使用前下载 `Systran/faster-whisper-small` 的 CTranslate2 模型到 `~/.local/share/dsh-wechat-ro/models/whisper-small`，目录包含 `model.bin`、`config.json`、`tokenizer.json` 和 `vocabulary.json`。下载过程需要网络，分析过程从本地加载模型。RapidOCR 的三个 ONNX 模型随锁定依赖安装；运行期间无需下载。

## 当前处理范围

| 内容 | 实现与验证 |
| --- | --- |
| 微信语音 | 从本地 VoiceInfo 精确读取，SILK 解码、CPU 转写和缓存回放已验证；短音频的语义准确度需要原语音核对 |
| 普通图片 | PNG/JPEG/WebP/GIF/BMP 本地 OCR；原生图片工具回放已验证 |
| 视频文件 | FFmpeg 每 30 秒抽帧，最多 10 帧，结合 OCR 与音轨转写；已验证真实微信 26 MB 视频的原记录关联、8 帧和本地文本提取 |
| PDF | 正文及扫描版中文 PDF 已验证；最多 100 页正文、10 页扫描 OCR |
| Office | DOCX/PPTX 文本，XLSX 字符串引用、单元格位置和公式回归通过 |
| 微信 DAT | XOR、V1、V2 有确定性测试；本机缓存派生密钥后完整解码两张原图，像素与用户附件完全相同。自动缓存派生、重启复用、密钥轮换及真实 WXGF 原图解码已通过验证 |
| 朋友圈／收藏／小程序 | 本机固定副本的 940／33／2,228 条文字记录已解析；不抓取远程正文 |
| 通讯录 | 沿用已导入联系人库的昵称、备注及微信标识 |

单个文件最多 64 MiB；音视频处理前 300 秒；分析文本按工具输出预算截断并标注。成功结果按文件内容哈希缓存；开启历史自动更新后，空闲周期每批最多处理一条语音和一条图片或视频，按时间与同秒偏移保存进度，重启后继续。未下载的媒体会跳过，完成一轮后每小时复查。新消息查询会取消后台分析，让查询优先；已完成的派生文本随下一次刷新进入搜索与每日卡片。新文件首次加载模型的开销仍存在。缓存和模型保存在本机用户数据目录。图片、视频的缓存绑定原记录、账号与文件身份；源文件变化后，旧结果不会进入新的索引。微信附件的硬链接可只读使用；符号链接仍拒绝。WXGF 使用 FFmpeg 输出最多三帧并保留帧编号，便于模型核对画面。

目前一键历史导入的真实客户端验证在 Linux 微信 4.1.13.26。三平台均是插件适配目标；Windows/macOS 的自动导入及媒体端到端验证状态见[平台表](platform-support.md)。

归档查询默认允许子进程运行 10 秒，上限 15 秒，保留行数、字节预算与取消控制。每日卡片使用当前模型的独立输入，避免与机器人原生会话请求混合。

可复用方案与许可证核对见[相关项目调查](related-projects.md)。
