# 复用当前 Chrome

Execute 默认提供一个 `chrome` 工具，使用固定版本 `chrome-devtools-mcp 1.9.0` 连接已运行的 Chrome，沿用该浏览器中的登录状态与 Cookie。普通聊天仍使用原四工具，Decide／元认知仍只有 `read`。角色系统提示词没有增长。

## 使用

1. 安装依赖后打开平时使用的 Chrome。
2. 在 `chrome://inspect/#remote-debugging` 启用远程调试。Chrome 显示连接请求时允许连接。
3. 在 Xloom 用 `/run` 提供浏览器任务和目标网址。Execute 可查询已打开标签页并按 `pageId` 操作。

自动连接至少需要 Chrome 144；本配置同时启用的扩展工具需要 Chrome 149+。WebMCP 调试要求 Chrome 150+ 且该 Chrome 已启用 WebMCP；Xloom 不重启浏览器以修改这些条件。

项目 settings.json（位置见 `/paths`）可省略 `chrome`，默认启用 stable；也可配置：

```json
"chrome": { "enabled": true, "channel": "stable" }
```

`channel` 支持 `stable / beta / dev / canary`，须与正在运行的 Chrome 一致。`enabled: false` 从 Execute 移除 Chrome 工具。全局 settings.json 支持相同字段；修改后重启 Xloom，已有任务重新打开时使用当前项目设置。配置不接受任意 MCP 命令、启动参数或浏览器可执行路径。

## 模型调用

```json
{"action":"list"}
{"action":"describe","tool":"take_snapshot"}
{"action":"call","tool":"take_snapshot","args":{"pageId":2}}
```

先查询列表及工具参数，再调用；页面 ID 应来自 `list_pages`，不能猜测或使用旧版 `pageIdx`。标签页、快照、点击、输入、导航、网络、控制台、截图、性能、内存、扩展和实验工具按需发现，定义不会全部塞进每轮提示词。`new_page` 只可在现有浏览器默认会话中打开标签页，拒绝非空 `isolatedContext`。

浏览器调用的原始参数、时间和完整 MCP 结果自动保存在本 run 的 `artifacts/chrome-*.json`。返回的图片另存为同名图片文件，并作为 Pi 图片内容交给支持图片的模型。返回文本最多 24,000 字符，截断会标明完整原件位置；归档不会截断。模型可直接将这些路径作为 Evidence 提交，仍由既有 Store 校验和入库，不自动制造 Fact 或 Finding。

`take_screenshot` 不传 `format / quality / filePath` 时默认返回 WebP 图片：质量 85、最大 1920×1080、保留比例。显式传 `filePath` 时，上游保存文件并返回文件信息；需要模型直接收图时省略它。文字模型可用页面快照读取内容和保存截图，但不能凭此声称看过截图像素。

## 连接与边界

只在首次 `chrome` 调用时加载 MCP 客户端并通过当前 Node 启动固定包的 stdio 入口，不在运行时调用 `npx @latest` 或下载包。固定使用 `--autoConnect`，没有启动新 Chrome／新 profile 的回退路径。运行结束、失败或取消会关闭连接进程，保留用户的 Chrome 和标签页；浏览器工具主动关闭的标签页除外。连接初始化和工具目录请求上限 30 秒，具体调用上限 120 秒，并服从既有运行取消／超时。传输失败后停止当前连接，不自动重放动作；动作可能已发生，应先检查页面状态。

原示例的参数适配如下：

| 参数 | 当前处理 |
| --- | --- |
| `--experimental-page-id-routing` | 使用正式 `--page-id-routing` |
| DevTools、vision、structured-content、include-all-pages、memory、third-party、WebMCP、extensions | 按原请求启用；目标 Chrome／页面仍须具备对应能力 |
| `--category-experimental-webmcp` | 1.9.0 中是隐藏参数，仍支持 |
| `--allow-unrestricted-paths` | 已弃用；用 `--workspace` 明确提供项目与当前 run 的 artifacts 路径 |
| `--accept-insecure-certs` | 1.9.0 只在启动浏览器路径传给 Puppeteer；连接已有 Chrome 时无效，因此不传、不声称忽略证书错误 |
| usage statistics、CrUX、更新检查 | 关闭；禁用更新检查也避免派生更新进程 |

这是特定浏览器适配层，没有加载用户 MCP 配置、Pi CLI 会话、扩展、Skills、额外 Agent 或 hook。文件与 PowerShell 工具仍有当前用户权限；Chrome 的文件根限制不是 Xloom 的操作系统沙箱。浏览器操作使用真实登录态；只有操作所需的页面和响应会通过工具返回，原始证据按项目既有规则保存，并非全量脱敏归档。

实现依据：[Chrome MCP 说明](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/v1.9.0)、包内 `config/mcp-options.js`、`config/category-options.js`、`index.js` 和 `browser.js`。以锁文件安装的 1.9.0 行为为准。

## 验证

离线测试覆盖懒启动、实际 stdio 协议和固定服务器能力发现、分页、参数／错误、截图及完整归档、取消／断线／子进程回收、Execute 工具循环、角色隔离与设置持久化。不要求 Chrome 已打开，不访问真实网页，不请求模型。

显式使用项目配置的 Execute 模型和已有 Chrome：

```powershell
npx tsx scripts/validate-chrome.ts --live
```

脚本在现有浏览器打开本地合成页，预置 HttpOnly Cookie 后断开；真实 Execute 模型重新连接、点击确认、读取返回码并截图，然后将原始证据和 Fact 提交 Store。服务器独立核验 Cookie 延续，Windows stable 还比较 Chrome 调试端点指纹；最后删除测试 Cookie、关闭测试标签页，保留其他页面。报告保存模型、用量、检查结果和原件目录，不打印 Cookie 或模型密钥。这验证原生连接与证据闭环，不代表任意网站或全部实验工具已通过实测。
