# xloom

基于 Pi 的 Windows 双 Agent 安全研究 Loop，当前为 **0.1 MVP**。

两个角色不共享聊天历史，只通过结构化黑板协作。Decide 负责计划与审查，Execute 执行一个有界步骤；元认知是 Decide 的一次全新上下文调用，不是第三个 Agent。

## 快速开始

需要 Windows、Node.js 24+、PowerShell 7（`pwsh.exe` 在 PATH 中）。推荐 Windows Terminal。模型服务凭据由用户提供。

```powershell
Set-Location 'D:\Users\Acer\Desktop\SRC\xloom'
npm ci --ignore-scripts
npm run check

# 不连接模型、不访问外部目标的合成闭环演示
npm start -- demo --headless

# 创建配置；用户输入的目标即授权，不增加二次授权确认
npm start -- init --goal "验证我提供的测试站点的对象归属和租户隔离边界"
# 编辑 xloom.json：目标、身份说明、业务上下文、模型和预算
$env:ANTHROPIC_API_KEY = "填写你的模型服务密钥"
npm start -- doctor
npm start
```

TUI 默认等待 `/start`，不会刚打开就执行。`xloom.example.json` 提供完整配置样例；`init` 不会覆盖已有文件。运行时不会自动加载项目或用户目录中的 AGENTS.md、Skills、MCP、扩展或 Pi CLI 会话。

构建后也可使用 `node dist/cli.js`，或 `npm link` 后使用 `xloom`。

## 本版功能

- Pi `0.84.4` 的真实 Agent 内核与四个原生工具工厂，Execute 仅有 `read / write / edit / powershell`；工具顺序执行。Decide / 元认知不挂载工具。
- 本地 Controller 串行调度；每次 Decide、每个 Execute Step、每次元认知都重新创建 Pi Agent，消息数组从空开始。
- FGS 黑板：Fact / Goal / Step，附带 Finding / Evidence / Hint。控制器验证提案后统一提交，Agent 不直接写权威黑板。
- SQLite WAL 持久化、追加审计事件、步骤 claim、单控制器锁、暂停/停止/恢复。中断步骤标记失败，不会盲目重放。
- 每 3 个步骤、停滞、执行受阻、完成前或 `/meta` 触发元认知；完成必须来自一次 fresh Decide review。
- 技术命中保持 `unrated`；只有证据关联、影响字段、PoC 和 Decide 审查符合规则后才允许 `impact_verified` 与评级。
- 证据归档、SHA-256 校验、引用完整性检查、同一假设合并、无新证据的重复尝试不计进展。
- 暖珊瑚色角色标签、滚动事件流、底部多行输入和状态栏；支持中文、窄终端、流式输出和工具摘要。

## TUI / CLI

| 输入 | 行为 |
| --- | --- |
| `/start` | 启动或恢复，重新规划，不重放中断步骤 |
| 普通文字、`/hint 文字` | 只写入黑板 Hint；下一个规划边界读取 |
| `/meta` | 在安全的运行边界调用 Decide 元认知；空闲时启动 |
| `/pause`、Esc | 取消当前调用并暂停，保留状态 |
| `/stop` | 停止，保留状态和证据 |
| `/board` | 查看简洁 FGS / Finding 视图 |
| `/help` | 查看命令与快捷键帮助 |
| `/exit`、`/quit` | 退出 TUI；取消当前运行并等待清理，保留状态和证据 |
| ↑ / ↓、Ctrl+P / Ctrl+N | 切换上一条 / 下一条已提交输入（当前 TUI 会话最多 100 条），返回最新时恢复未提交草稿 |
| Alt+↑ / Alt+↓ | 在多行输入内移动光标 |
| Alt+Enter / Shift+Enter | 插入换行；Enter 提交 |
| 拖动选择文字 | 松开鼠标后复制到系统剪贴板 |
| Ctrl+C | 输入框有内容（含空格、多行）时清空，不计为退出的第一次；空输入框 2 秒内连续按两次退出。第一次只提示，不暂停任务；期间输入内容会取消退出确认 |
| Ctrl+Shift+C / Ctrl+Insert | 复制选中文字；无选择时复制当前输入框内容 |
| Ctrl+V / Shift+Insert / 右键 | 将系统剪贴板文字粘贴到输入框；支持中文及多行，不会自动提交 |
| 滚轮 / PageUp / PageDown | 滚动会话区；上翻后新输出不会强制拉回底部 |
| End | 回到会话底部，恢复自动跟随新输出 |

界面只保留标题、会话区、输入框和状态栏，不常驻显示功能介绍或底部快捷帮助。需要时手动输入 `/help`。剪贴板只在用户触发复制/粘贴时访问，不传给 Agent；Windows 剪贴板操作在隐藏的 PowerShell 子进程中异步、按顺序完成。终端若拦截 Ctrl+Shift+C/V 或 Shift+Insert，则由终端处理原生复制粘贴；建议使用 Windows Terminal。旧控制台若抢占鼠标选择或右键，仍可使用键盘快捷键及 PageUp/PageDown。

应用收到 Ctrl+V 后会直接插入剪贴板文本，不将换行解释为 Enter。终端自己的粘贴功能则需要支持并透传 bracketed paste（括号粘贴）协议；缺少该协议的旧控制台/PTY 通道可能把换行转成回车提交。此时应使用应用的 Ctrl+V，或换用支持该协议的终端。自动测试使用模拟剪贴板，不会读取或覆盖用户当前的系统剪贴板。

Ctrl+C 不再用于复制或暂停。复制仍可拖选，或使用 Ctrl+Shift+C / Ctrl+Insert；暂停用 Esc 或 `/pause`。清空输入不会提交内容、修改黑板或中断运行，尚未完成的旧粘贴也不会重新填回被清空的输入框。

底部状态栏示例 `idle · r0 · step 0/24 · 0 tokens · $0.000`：`idle` 表示空闲、尚未开始运行；`r0` 是黑板 revision（版本号）0，每次保存状态、Hint 或执行结果等都会递增，不是 Agent 轮数；`step 0/24` 表示已结算 0 个 Execute 步骤、配置上限 24 个。步骤计数包含已返回并提交结果的无进展/受阻步骤，不等于成功次数、消息数或漏洞数。tokens 为累计模型用量，美元数为估算费用。

```powershell
npm start -- run --headless
npm start -- status
npm start -- report
npm start -- run --workspace "D:\Work\my-research"
```

`status` / `report` 只读数据库，不调用模型、不启动 Loop。报告输出到标准输出。`--headless` 会立即启动，适合明确要运行的终端任务；非交互环境不会隐式启动 TUI 或模型。

## 配置与预算

两个角色可以配置不同的 provider / model；元认知始终复用 `models.decide`。默认值来自 Pi 模型目录，实际账户能否调用需要用户验证；`doctor` 只检查本地环境和凭据解析，不发起模型请求。

接入兼容端点时，在相应模型配置中设置：

```json
{
  "provider": "my-endpoint",
  "model": "your-model-id",
  "api": "openai-completions",
  "baseUrl": "https://your-endpoint.example/v1",
  "apiKeyEnv": "XLOOM_MODEL_KEY",
  "contextWindow": 128000,
  "maxTokens": 8192,
  "thinking": "off"
}
```

支持 `openai-completions`、`openai-responses`、`anthropic-messages`。Key 只从环境变量读取，不写进配置；无认证的本地兼容服务也需要设置一个非空占位 Key。兼容性以具体端点为准。

默认上限：24 个执行步骤、连续 3 次无进展、累计运行 30 分钟、200000 tokens、估算 5 美元；每次运行最多 12 个模型回合、180 秒。步骤预算不会阻挡最终规划/元认知；token、时间和费用仍适用于它们。预算耗尽只暂停，不生成研究结论；修改 `xloom.json` 后重启以加载新预算。

Token / 费用在模型回合结束后累计，正在进行的调用可能超出软上限；超时由取消信号处理。自定义端点价格可能未知，费用上限不能视为准确账单硬限额。暂停时间不计入运行时间；进程被强制结束时，最后一次调用的 token 统计可能不完整。

## 数据与恢复

```text
workspace/
  xloom.json                      用户配置（默认不进 Git）
  state/blackboard.md              自动生成的可读投影，不是输入或权威状态
  .xloom/
    controller.lock               防止同时运行两个本地控制器
    blackboard.sqlite             权威状态、追加审计事件、运行生命周期
    evidence/<sha256>.bin          原始证据的归档副本
    runs/<run-id>/
      input.json                  该次独立调用的输入
      events.jsonl                该次调用的运行记录
      output.json                 该次调用的结果
      artifacts/                  Execute 写入的原始证据
```

黑板投影中的 `tested` 使用 Jase 的 `target / finding_status / rating / evidence / next` 字段。已有非 xloom 生成的 `state/blackboard.md` 会被保留并提示，不会覆盖。

证据单文件最多 10 MiB，单次结果最多 50 MiB；Agent 输入只获得归档引用、哈希和每份最多 4096 字节的原始片段，大正文留在文件中。片段不完整时应安排 Execute 进一步查阅，不应据此确认影响。

正常暂停会取消 Pi 调用及 PowerShell 子进程树；硬杀进程、断电或远端已经产生的效果不能回滚。重新打开时会保留失败/中断信息，由新 Decide 判断下一步，不自动再次执行原步骤。

`.xloom` 及报告可能含研究目标的敏感证据。默认不加入 Git、不自动上传、不全量脱敏目标证据；应由使用者管理本地文件和报告的访问权限。模型服务凭据会在运行日志/显示文本中尽量过滤，但这不是密钥保险库。

## 明确的边界

这是上下文隔离，不是操作系统沙箱。Execute 的原生文件和 PowerShell 工具拥有当前用户权限；没有权限 Hook、审批系统或额外隔离层。程序不向另一角色注入聊天历史，提示词也禁止读取其他 run 的聊天/日志，但不声称能用提示词阻止越权读文件。

引用、文件哈希、JSON 校验只能保证结构和证据完整性，**不能独立证明请求确实发生或漏洞成立**。真实性、可复现性、实际影响和缺失输入的判断仍依赖模型对原始证据的审查及用户复核。`NEED_INPUT` 不能用一般停滞代替；预算/错误/空计划只进入操作暂停或错误状态。

本版没有完整浏览器、网络代理、扫描器插件、MCP、Skills、额外工具注册、第三 Agent、自动长程记忆、向量检索或多任务并发。当前发送完整结构化黑板（不是完整聊天），适合有界任务；尚无自动上下文压缩，不承诺无限长 Loop。审计事件是追加日志，不是可从事件完整重建数据库的事件溯源系统。

`demo` 和单元测试中的合成证据仅验证软件闭环，不能作为真实漏洞研究结果。未提供模型 Key 时也可以运行全部离线测试；这不等于完成真实模型/真实目标验收。

## 扩展位置

详见 [架构说明](docs/architecture.md)。稳定边界是 `AgentRunner`、结果契约、黑板 Store、Controller 事件和 TUI 适配；先留接口，不预装未来功能。设计参考 Cairn / Cairn_Y 的黑板协作与 FGS、Jase 的动态验证与元认知，独立实现，不复用 Cairn 的 AGPL 源码。Pi 依赖使用 MIT 许可证；保留各依赖原有许可。
