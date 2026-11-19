# 插件安装与 DSH 版本

本指南用于安装 `dsh-wechat-ro` **0.2.1**，包括 DSH 环境、源码安装、启用和首次使用。Windows、macOS、Linux 的功能进度见[平台支持说明](platform-support.md)。

## 版本与兼容环境

| 项目 | 声明要求 | 当前验证环境 |
| --- | --- | --- |
| 微信插件 | `0.2.1`，从本仓库源码安装 | 当前本机验收版本；尚无 npm 包或 GitHub Release |
| DSH 宿主 | `engines.dsh: >=0.2.2-rc.5 <0.3.0` | 官方 npm **0.2.2-rc.5**，Linux 验证环境 |
| DSH SDK peers | 大多数为 `^0.2.2-rc.5`；完整列表见 [package.json](../plugin/package.json) | 由兼容宿主提供，保持宿主与 peers 一致 |
| Node.js | `>=24.9.0` | **24.15.0** |
| pnpm：插件依赖和离线测试 | 使用锁文件 | **10.34.1** |
| pnpm：DSH 源码构建 | 遵循对应 DSH checkout 的 `packageManager` | 本机 DSH checkout 声明 **11.28.5** |
| Python：Linux 一键历史采集 | `/usr/bin/python3`，需 Python **3.11+** | **3.12.3**；还需系统 `pkexec` 与 OpenSSL `libcrypto` |
| Python：独立 MCP | Python **3.10+** 及 [requirements.txt](../requirements.txt) | CI 使用 Python **3.12** |
| 桌面微信采集 | 按系统、版本和构建验收 | Linux **4.1.13.26**；Windows/macOS 采集待实现 |

DSH 官方 `0.2.2-rc.5` 是当前兼容基线。微信自动回复使用官方原生会话 `followup()`；历史搜索、导入、更新、数据卡片和通信由插件提供。插件 **0.2.1** 已退出旧 `sealedHistory` / `sealedFirstText` 单次封印流程，保留历史审计读取和撤销。使用官方发行包即可安装，无需修改 DSH 源码。升级步骤见[插件迁移说明](upgrading-0.2.1.md)。

版本依据：本插件 [engines 与 peers](../plugin/package.json)、DSH 官方 [0.2.2-rc.5 源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)、[官方运行说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/README.zh.md)。本机 DSH CLI 的 `--version` 已核对为 `0.2.2-rc.5`。

## 1. 准备 DSH

已有兼容 DSH 环境时，使用当前窗口和 profile。新环境先安装符合要求的 Node.js，再使用固定版本启动 DSH：

```bash
npx @deepseek-ai/dsh@0.2.2-rc.5 --version
npx @deepseek-ai/dsh@0.2.2-rc.5 web
```

Web UI 默认地址为 `http://127.0.0.1:3080`。在 DSH 中配置模型提供方，并确认普通原生会话可以回复。使用源码宿主时，遵循[官方源码构建说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/README.zh.md#运行)，使用它自己的 pnpm 版本；插件的 pnpm 版本见上表。

检查现有安装版本：全局 CLI 使用 `dsh --version`；DSH 源码目录使用 `pnpm dsh --version`。这些命令检查被调用的安装，安装插件时继续使用同一宿主。

## 2. 下载插件并安装依赖

在运行 DSH 的电脑上执行：

```bash
git clone https://github.com/keerzzz/dsh-wechat-ro.git
cd dsh-wechat-ro
pnpm --dir plugin install --prod --frozen-lockfile --config.auto-install-peers=false
```

插件的运行入口 `lib/`、界面和 Python 采集助手已经随源码提交，此步骤安装第三方运行依赖，无需先构建整个 DSH。宿主提供的 DSH peers 由宿主解析。

在 DSH 的安装输入框中使用 **`plugin/` 的绝对路径**，该目录直接包含 `package.json` 和 `cordis.patch.yml`：

| 系统 | 本地路径示例 |
| --- | --- |
| Windows | `C:\Users\YourName\Projects\dsh-wechat-ro\plugin` |
| macOS | `/Users/YourName/Projects/dsh-wechat-ro/plugin` |
| Linux | `/home/YourName/Projects/dsh-wechat-ro/plugin` |

路径属于 DSH 宿主所在的电脑；远程浏览器连接时也填写宿主路径。上表为安装路径写法，各系统的历史采集状态见平台表。

## 3. 在插件管理器安装并启用

1. 打开 DSH 侧栏的 **插件**。
2. 选择 **添加插件**，或其菜单中的 **安装第三方插件**。
3. 在 **包名或地址** 填入上一步 `plugin/` 的绝对路径，点击 **安装**。
4. 核对安装信息为 `dsh-wechat-ro`、版本 `0.2.1`。
5. 安装完成后点击 **立即启用**；也可在 **已安装插件** 中打开该组合包并启用。
6. 查看组合包的三个组件，确认均为 active／已激活，再打开原生会话里的 **微信** 侧栏。

DSH 自动读取 [cordis.patch.yml](../plugin/cordis.patch.yml)，加载查询模块、控制器和微信任务预设。安装页没有可管理的 profile 时，使用正常的 DSH Web／桌面 profile 启动。组件出现 pending／failed 时，查看 Host 日志中的缺失依赖或错误，再核对上表的 DSH 与 Node.js 版本。

这些安装入口和启用操作来自 DSH 官方[插件管理器说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-plugin-manager/README.zh.md)。

### 可选：用 CLI 安装到 Web profile

在已有兼容宿主上，也可使用它的 `dsh` CLI：

```bash
dsh plugin --profile web add /absolute/dsh-wechat-ro/plugin
dsh web
```

`web` 是此例的目标 profile；其他部署填写实际 profile 名称。源码宿主在其目录中使用 `pnpm dsh plugin --profile web add /absolute/dsh-wechat-ro/plugin`，随后 `pnpm dsh web`。本地安装通过链接引用 checkout，安装后保留该目录。CLI 语法与 profile 规则见[官方打包与安装教程](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/develop/basic/publish.zh.md)。

## 4. 首次使用与验收

在兼容宿主和已适配采集环境中：

1. 打开原生会话，选择自己的本地项目目录和模型。
2. 在 **微信** 侧栏点击 **扫码连接微信**，本人手机扫码；已有配对时点击 **连接微信**。
3. 在同一电脑登录桌面微信本人账号，点击 **一键导入微信历史**。Linux 首次取钥按系统认证窗口完成 `pkexec` 认证。
4. 在桌面微信 **文件传输助手** 发送一个新的文字标记，例如 `安装验收20261119`。
5. 在本人机器人对话中请求：`搜索今天文件传输助手里的“安装验收20261119”，给出原文、北京时间和记录引用。`
6. 核对原文、`+08:00` 时间、引用和副本更新时间。在设置中选择每天生成卡片的时间，再检查 **群聊／个人／公众号／服务号** 页签。

完整使用、更新规则与故障排查见[使用指南](getting-started.md)。

## 5. 更新与关闭

本地链接安装的插件使用该 checkout 的文件。更新源码后重新安装运行依赖，在插件管理器关闭并重新启用组合包；Host 提示需要重启时按提示重启，再重新连接并导入历史。

关闭插件：在 **已安装插件** 中关闭 `dsh-wechat-ro` 组合包。更换安装来源或路径：通过插件管理器卸载旧组合包，再从新路径安装。DSH 版本升级后，重新核对版本兼容范围并按第 4 节验收。

## 只需要 MCP 或开发测试

已有解密 SQLite 副本时，可单独安装 Python MCP：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Windows 使用 `python -m venv .venv`，随后 `.venv\Scripts\python.exe -m pip install -r requirements.txt`。客户端配置和 `WECHAT_SNAPSHOT_DIR` 见[只读 MCP 指南](getting-started.md#可选只读-mcp)。

开发者安装开发依赖后运行单包串行门禁，步骤见[贡献指南](../CONTRIBUTING.md#环境与独立测试)。离线测试使用合成数据；首次完整安装按第 4 节检查实际微信收发。
