# xloom

基于 Pi 的 Windows 双 Agent 安全研究 Loop，当前为 **0.1 MVP**。

默认以普通聊天打开，模型可以使用四工具。输入 `/run 目标` 切换到双 Agent 红队任务：两个角色不共享聊天历史，只通过结构化黑板协作。Decide 负责计划、工具核验与审查，Execute 执行一个有界步骤；元认知是 Decide 的一次全新上下文调用，不是第三个 Agent。普通聊天不是第三个红队角色，聊天历史不会注入任务。

## 快速开始

需要 Windows、Node.js 24+、PowerShell 7（`pwsh.exe` 在 PATH 中）。推荐 Windows Terminal。模型服务凭据由用户提供。

```powershell
Set-Location 'D:\Users\Acer\Desktop\SRC\xloom'
npm ci --ignore-scripts
npm run check

# 不连接模型、不访问外部目标的合成闭环演示
npm start -- demo --headless

# 打开普通聊天 TUI；首次自动生成不含凭据的 xloom.json
npm start -- run
# 在 TUI 中使用 /model 选择模型、/apikey 设置 Key 或 /login 登录
# 普通文字聊天；/run 加实际目标启动双 Agent；/hint 补充任务信息
```

打开 TUI 不会自动请求模型。`xloom.example.json` 提供配置样例；显式 `init --goal "目标"` 仍支持旧的预配置任务工作流，且不会覆盖已有文件。运行时不会自动加载项目或用户目录中的 AGENTS.md、Skills、MCP、扩展或 Pi CLI 会话。

构建后也可使用 `node dist/cli.js`，或 `npm link` 后使用 `xloom`。

## 本版功能

- Pi `0.84.4` 的真实 Agent 内核与四个原生工具工厂，普通聊天、Decide、Execute 和元认知均只有 `read / write / edit / powershell`；工具顺序执行。
- 普通聊天保留当前进程内的独立会话；`/new` 清空聊天，切换模型或凭据也会清空，避免把旧聊天转发到新端点。聊天不写入黑板，不持久化聊天记录。
- 本地 Controller 串行调度；每次 Decide、每个 Execute Step、每次元认知都重新创建 Pi Agent，消息数组从空开始。
- FGS 黑板：Fact / Goal / Step，附带 Finding / Evidence / Hint。控制器验证提案后统一提交，Agent 不直接写权威黑板。
- 按角色投影黑板：Decide / 元认知查看目标、待办和未关闭线索；Execute 查看当前 Step 及相关依赖。共享的是任务事实与证据，不是双方聊天。
- SQLite WAL 持久化、追加审计事件、步骤 claim、单控制器锁、暂停/停止/恢复。中断步骤标记失败，不会盲目重放。
- 新技术命中/命中证据更新、事实修正、每 3 个步骤、停滞、执行受阻、完成前或 `/meta` 触发元认知；完成必须来自一次 fresh Decide review，确认根 Goal 已满足并引用证据事实。步数只计数，不设任务上限。
- 技术命中保持 `unrated`；只有证据关联、影响字段、PoC 和 Decide 审查符合规则后才允许 `impact_verified` 与评级。
- 证据归档、SHA-256 校验、引用完整性检查、同一假设合并、无新证据的重复尝试不计进展。
- Claude 风格的暖珊瑚色极简会话：用户 `❯`、无重复标签的 Markdown 回答、可展开的真实思考，以及 `Worked for … · done/error` 耗时尾行；双 Agent 交接只占一行，工具默认显示名称、目标与状态，不刷文件正文或原始 JSON。

## TUI / CLI

| 输入 | 行为 |
| --- | --- |
| 普通文字 | 普通聊天，可调用四工具；即使有已暂停任务，也不会自动作为 Hint |
| `/run 目标` | 新建独立双 Agent 任务并开始执行；旧任务与证据保留，不带入聊天历史 |
| `/start` | 恢复当前任务或启动 `init` 的显式目标，重新规划，不重放中断步骤 |
| `/hint 文字` | 显式写入当前任务黑板；下一个规划边界读取 |
| `/new` | 清空普通聊天上下文，不删除任务或证据 |
| `/model [all\|chat\|decide\|execute]` | 搜索选择 Pi 模型；默认应用全部角色，可分别选择 |
| `/apikey [provider]` | 打开遮蔽输入框，把 Key 保存到 Pi 凭据文件；不接受行内 Key |
| `/login [provider]` | 使用 Pi 已支持的 OAuth／订阅登录流程；不支持登录的供应商使用 `/apikey` |
| `/logout [provider]` | 确认后删除该供应商的 Pi 本地凭据；不撤销远端 Key，环境变量认证仍可能生效 |
| `/meta` | 在安全的运行边界调用 Decide 元认知；空闲时启动 |
| `/pause`、Esc | 取消当前调用并暂停，保留状态；候选打开时 Esc 先关闭候选，设置弹窗中则取消设置 |
| `/stop` | 停止，保留状态和证据 |
| `/board` | 查看简洁 FGS / Finding 视图 |
| `/details`、Ctrl+O | 展开 / 收起工具输入输出、思考、交接原因、费用说明及原始协议；详情有长度限制，不影响原始运行日志 |
| 点击 Thought / Thinking、Ctrl+T | 点击标题展开或收起该段真实思考；Ctrl+T 切换最近一段，不修改模型思考配置 |
| `/help` | 查看命令与快捷键帮助 |
| `/exit`、`/quit` | 退出 TUI；取消当前运行并等待清理，保留状态和证据 |
| `/` | 输入框开头显示命令候选，继续输入按前缀筛选；↑/↓ 选择，Tab / Enter 补全，再按 Enter 执行；不会仅因选中而调用模型或退出 |
| ↑ / ↓、Ctrl+P / Ctrl+N | 无候选时切换上一条 / 下一条已提交输入（当前 TUI 会话最多 100 条），返回最新时恢复未提交草稿 |
| Alt+↑ / Alt+↓ | 在多行输入内移动光标 |
| Alt+Enter / Shift+Enter | 插入换行；Enter 提交 |
| 拖动选择文字 | 松开鼠标后复制到系统剪贴板 |
| Ctrl+C | 输入框有内容（含空格、多行）时清空，不计为退出的第一次；空输入框 2 秒内连续按两次退出。第一次只提示，不暂停任务；期间输入内容会取消退出确认 |
| Ctrl+Shift+C / Ctrl+Insert | 复制选中文字；无选择时复制当前输入框内容 |
| Ctrl+V / Shift+Insert / 右键 | 将系统剪贴板文字粘贴到输入框；支持中文及多行，不会自动提交 |
| 滚轮 / PageUp / PageDown | 滚动会话区；上翻后新输出不会强制拉回底部 |
| End | 回到会话底部，恢复自动跟随新输出 |

界面只保留标题、会话区、输入框和状态栏，不常驻显示功能介绍或底部快捷帮助。需要时手动输入 `/help`。剪贴板只在用户触发复制/粘贴时访问，不传给 Agent；Windows 剪贴板操作在隐藏的 PowerShell 子进程中异步、按顺序完成。终端若拦截 Ctrl+Shift+C/V 或 Shift+Insert，则由终端处理原生复制粘贴；建议使用 Windows Terminal。旧控制台若抢占鼠标选择或右键，仍可使用键盘快捷键及 PageUp/PageDown。

普通聊天继续流式显示自然语言；双 Agent 的原始结果协议默认收起，只有控制器成功提交黑板后的摘要才显示为结果，工具成功不等于目标完成。工具错误仍直接可见；未知定价说明放入详情、每个 TUI 会话只记录一次，状态栏显示“费用未知”，不拿 `$0.000` 当作实际免费。`/` 列表只提供应用已有命令，不新增工具、MCP 或 Skills。候选中的 `/model` 也支持补全角色。

思考只来自 Pi 转发的模型实际 `thinking` 内容，不解析正文中的伪思考标签，不展示签名或提供方已隐藏的内容，也不生成额外“解释思考”请求。`thinking: off` 或模型未返回思考时只显示 `Working…` 和最终回答；本次界面改动不会自动开启思考。`Thought for` 计量客户端观察到的思考流时间，不等同于服务端纯推理耗时；仅在最终消息才收到的思考显示 `Thought`，不虚构秒数。总 `Worked for` 包含本地等待、模型请求和工具执行时间；取消、超时和错误分别保留实际终态，不显示 done。鼠标点击使用应用内部链接回调，不打开浏览器；拖动仍可复制。

默认聊天启动不展示已保存任务的停止/暂停原因；使用 `/start` 或 `/board` 才查看或恢复任务。模型服务的 `Request timed out.` 与本地回复时间限制会显示不同的错误说明；界面改动不会自动重试请求或重放工具副作用。

设置在临时弹窗中完成，Key、登录码和认证 URL 不进入聊天 Feed 或输入历史。Esc 取消设置／登录；取消不能撤销已经保存的凭据。OAuth 链接在弹窗内提供，Ctrl+L 复制完整登录地址到浏览器，应用不自动打开外部窗口。模型或任务运行期间先 `/pause` 并等待取消完成，再改模式、模型或凭据；不并发运行聊天与红队任务。

应用收到 Ctrl+V 后会直接插入剪贴板文本，不将换行解释为 Enter。终端自己的粘贴功能则需要支持并透传 bracketed paste（括号粘贴）协议；缺少该协议的旧控制台/PTY 通道可能把换行转成回车提交。此时应使用应用的 Ctrl+V，或换用支持该协议的终端。自动测试使用模拟剪贴板，不会读取或覆盖用户当前的系统剪贴板。

Ctrl+C 不再用于复制或暂停。复制仍可拖选，或使用 Ctrl+Shift+C / Ctrl+Insert；暂停用 Esc 或 `/pause`。清空输入不会提交内容、修改黑板或中断运行，尚未完成的旧粘贴也不会重新填回被清空的输入框。

底部显示当前 `chat` / `run` 模式、模型和状态。聊天显示独立聊天用量；红队模式的 `r0` 是黑板 revision（版本号）0，每次保存状态、Hint 或执行结果等都会递增，不是 Agent 轮数。`step 0` 表示已结算 0 个 Execute 步骤，没有 `/24` 上限。步骤计数包含已返回并提交结果的无进展/受阻步骤，不等于成功次数、模型调用次数或漏洞数。tokens 为模型用量，美元数为估算费用。

```powershell
npm start -- run --headless
npm start -- status
npm start -- report
npm start -- models
npm start -- models --provider anthropic
npm start -- run --workspace "D:\Work\my-research"
```

`status` / `report` 只读当前选中任务，不调用模型、不启动 Loop。报告输出到标准输出。`--headless` 会立即启动／恢复已配置任务，适合明确要运行的终端任务；没有实际 Goal 的聊天配置不能用它启动研究。非交互环境不会隐式启动 TUI 或模型。

## 模型选择与 Goal 完成

`models.chat`、`models.decide`、`models.execute` 可以配置不同模型；旧配置没有 chat 时回退到 execute，元认知始终复用 decide。模型目录、供应商适配和认证直接使用当前依赖 Pi `0.84.4` 的 `ModelRuntime`，不维护 xloom 模型白名单。`npm start -- models` 列出 Pi 本地内置、缓存及自定义目录，不调用模型；TUI `/model` 也会保留当前配置的内联模型别名。默认模型不代表账户已获调用权限。

复用 Pi 用户目录（默认 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 指定）的 `auth.json`、`models.json` 和模型缓存，支持 Pi 的环境认证、API Key 与 OAuth 登录/刷新。TUI `/apikey` 和 `/login` 直接使用 Pi 的持久登录接口，只修改选中供应商的凭据，不把密钥写进 xloom.json。此文件与 Pi 共用，不是操作系统密钥库。配置不指定 `apiKeyEnv` 时由 Pi 选择认证；显式指定时该变量必须存在。成功设置同供应商凭据后会清除对应角色的显式环境变量覆盖，让新凭据生效。`doctor` 不发起模型推理请求，但 Pi 的凭据刷新或按需动态目录发现可能需要网络，遵守 `PI_OFFLINE`。

OpenCode Go 使用会话路由请求头 `x-opencode-session`。xloom 仅在 `opencode-go` 的官方 HTTPS `/zen/go` 端点合并此请求头，值复用 Pi 当前会话 ID，不修改 Pi 内层。目录与服务端可能存在版本差：例如 `deepseek-flash` 是线上可用别名，可按用户端点配置 `api: anthropic-messages`、`baseUrl: https://opencode.ai/zen/go`；是否可用仍以真实请求与账户权限为准，不把它自动替换成另一个型号。

在 Pi `models.json` 中已配置的模型，仅填 provider / model 即可。也保留以下单角色端点覆盖写法：

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

`api` 由 Pi 的供应商/API 注册机制处理，不再限制为三种协议；自定义模型的细节、headers 和认证优先按 Pi `models.json` 配置。xloom 配置不接受明文 Key。实际支持范围与所依赖的 Pi 版本、账户、模型工具调用能力及端点实现有关；未知 API 仍由 Pi 报错。需要自定义 JavaScript 扩展才能注册的供应商不会自动加载，因为本项目不启用 Pi 扩展系统。

任务正常结束由 LLM 判断根 Goal 是否完成：Decide 读取黑板 → Execute 有界执行 → 持续规划；完成提议必须经过全新 Decide 元认知复核，使用 `updateGoals` 将根 Goal 标记 `satisfied` 并引用证据事实，同时提交最终结论。根 Goal 不能用 `abandoned` 代替完成，必须处理子目标及待执行步骤；发现单个漏洞不自动代表整个 Goal 完成。控制器只校验结构、引用及证据完整性，完成语义仍由 LLM 审查。

`maxNoProgress: 3` 是元认知触发阈值，不再强制暂停；有新执行计划就继续。LLM 无法给出可执行步骤或有效结论时，保留未完成状态并暂停；确实缺少必要输入时为 `NEED_INPUT`，补充后可恢复。没有隐藏的 24 步停机点。

新配置的累计 `maxMinutes`、`maxTokens`、`maxCost` 默认 `null`（不设累计上限）；可由用户显式设正数作为资源暂停条件，不是 Goal 完成条件。不设预算的长任务会持续消耗模型用量，用户可随时 `/pause` 或 `/stop`。每次独立运行仍默认最多 12 个模型回合、180 秒，用于识别失控的单次工具循环或超时，触发时保留故障/中断状态，绝不伪造完成。

兼容旧配置：旧 `limits.maxSteps` 会在加载时忽略，不必调大；旧文件中已有的时间、Token、费用上限仍按显式配置保留。如不需要资源暂停，将这三个字段设为 `null` 或删除并重启；任务证据、步骤计数不会清空。

Token / 费用在模型回合结束后累计，正在进行的调用可能超出软上限；超时由取消信号处理。自定义端点价格可能未知，费用上限不能视为准确账单硬限额。暂停时间不计入运行时间；进程被强制结束时，最后一次调用的 token 统计可能不完整。

## 数据与恢复

```text
workspace/
  xloom.json                      用户配置（默认不进 Git）
  state/blackboard.md              旧工作流的可读黑板投影
  .xloom/
    session.lock                  单工作区应用锁
    current-task.json             TUI 当前选中的任务 ID
    tasks/<task-id>/              每次 /run 的独立任务
      blackboard.sqlite           该任务权威状态与审计
      blackboard.md               该任务可读投影
      evidence/                   该任务归档证据
      runs/                       该任务各次调用产物与私有日志
    controller.lock               防止同时运行两个本地控制器
    blackboard.sqlite             旧工作流的权威状态（不会自动删除）
    evidence/<sha256>.bin          原始证据的归档副本
    runs/<run-id>/
      input.json                  该次独立调用的输入
      events.jsonl                该次调用的运行记录
      output.json                 该次调用的结果
      artifacts/                  Execute 写入的原始证据
```

黑板投影中的 `tested` 使用 Jase 的 `target / finding_status / rating / evidence / next` 字段。已有非 xloom 生成的 `state/blackboard.md` 会被保留并提示，不会覆盖。新 `/run` 只建立新任务目录，不复制旧任务范围、Hint 或聊天；四工具的工作目录仍是用户打开的项目，不会变成任务数据目录。重启默认进入聊天，可用 `/start` 恢复上次选中任务。

证据单文件最多 10 MiB，单次结果最多 50 MiB；黑板保存归档引用、哈希和每份最多 4096 字节的原始片段，大正文留在文件中。角色视图将片段进一步限制到最多 2,000 个字符，并显式标注截断；片段不完整时应安排 Execute 进一步查阅，不应据此确认影响。

Decide / 元认知保留全部 Goal、待执行 Step、未关闭 Finding 和 Hint，另带少量历史尾部；Execute 保留分配的 Step、祖先 Goal、相关 Finding 及证据依赖。Fact 修正链双向保留，历史 Step 只需追溯来源时以简短来源条目提供。投影明确列出省略数量、缺失引用和片段截断情况；省略不代表未测试或可以重复执行。黑板原始状态和证据不会因投影而删除。这是依赖优先的工作视图，不是硬性 Token 上限：大量活动分支和 Hint 仍可能撑大上下文。

正常暂停会取消 Pi 调用及 PowerShell 子进程树；硬杀进程、断电或远端已经产生的效果不能回滚。重新打开时会保留失败/中断信息，由新 Decide 判断下一步，不自动再次执行原步骤。

失败 Step 的公开视图可带有 `recovery`，仅指向旧调用的 `artifacts` 目录，并标记为未验证。即使工具写入后模型报错、结果尚未入库，Decide 也可安排新 Step 检查残留文件；它们不会自动成为 Fact / Evidence，必须先检查并按正常证据流程提交。这个引用不包含旧聊天或运行日志。

升级旧黑板时，若旧任务尚未完成却提前关闭了根 Goal，会恢复根 Goal 为 active；旧任务标记 completed 但根 Goal 没有 satisfied 的，会改为 paused 并提示重新复核。原结论记录进审计，证据、事实、线索和计数保留；迁移不会自动调用模型或重放步骤。

`.xloom` 及报告可能含研究目标的敏感证据。默认不加入 Git、不自动上传、不全量脱敏目标证据；应由使用者管理本地文件和报告的访问权限。模型服务凭据会在运行日志/显示文本中尽量过滤，但这不是密钥保险库。

## 明确的边界

这是上下文隔离，不是操作系统沙箱。聊天、Decide 和 Execute 的原生文件和 PowerShell 工具拥有当前用户权限；没有权限 Hook、审批系统或额外隔离层。程序不向另一角色注入聊天历史，提示词也禁止读取其他 run 的聊天/日志和凭据，但不声称能用提示词阻止越权读文件。Decide 可直接用工具核验；需要纳入权威 Fact / Evidence 的新观察仍交给 Execute 按既有证据契约提交，避免绕过证据链。

引用、文件哈希、JSON 校验只能保证结构和证据完整性，**不能独立证明请求确实发生或漏洞成立**。真实性、可复现性、实际影响和缺失输入的判断仍依赖模型对原始证据的审查及用户复核。`NEED_INPUT` 不能用一般停滞代替；预算/错误/空计划只进入操作暂停或错误状态。

本版没有完整浏览器、网络代理、扫描器插件、MCP、Skills、额外工具注册、第三 Agent、知识库、自动长程记忆、向量检索或多任务并发。角色投影只组织当前任务的结构化状态，不加载 Jase 知识包，不做模型摘要压缩，也不承诺无限长 Loop。审计事件是追加日志，不是可从事件完整重建数据库的事件溯源系统。

`demo` 和单元测试中的合成证据仅验证软件闭环，不能作为真实漏洞研究结果。未提供模型 Key 时也可以运行全部离线测试；这不等于完成真实模型/真实目标验收。

## 扩展位置

详见 [架构说明](docs/architecture.md)。MVP 扩展边界是 `ContextProjector`（角色视图）、`LoopPolicy`（选步及执行后复核）、`AgentRunner`（执行后端）、结果契约、黑板 Store 和 `LoopEvent`（含角色交接）。通过构造参数和 TypeScript 接口扩展，不增加运行时插件系统。Pi 内层模型/工具 Loop 保留，本次只调整外层；单次调用限额、格式处理和内层继续执行行为不变。

设计参考 Cairn / Cairn_Y 的黑板协作与 FGS；Jase 体现在外层的边界建模、改变变量、影响闭环与完成复核，独立实现，不复用 Cairn 的 AGPL 源码。Pi 依赖使用 MIT 许可证；保留各依赖原有许可。
