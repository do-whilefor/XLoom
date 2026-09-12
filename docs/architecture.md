# MVP 架构与后续接口

## 聊天与任务入口

`AppController` 负责应用级模式、模型设置和当前任务指针。普通文字只交给独立 `ChatSession`，使用 Pi Agent 的持续消息历史与四工具，自然语言回复，不使用红队 JSON 契约。`/new`、切换模型或凭据会清空聊天；聊天历史只保存在当前进程内。

`/run 目标` 创建 `.xloom/tasks/<id>` 下的新黑板，由原 `LoopController` 运行；不带入聊天、旧 Hint 或旧任务范围。`/start` 恢复当前选中任务。新任务不删除旧数据，工具 cwd 始终是用户项目目录。应用锁防止同一工作区并发开启聊天/任务应用；单个 App 中也不并发运行聊天、红队 Loop 与凭据变更。旧根黑板仍可恢复。

SettingsService 只复用 Pi ModelRuntime 的本地目录、持久 API Key 和 OAuth/订阅登录。TUI 使用搜索式选择器和临时认证弹窗，Key、登录码与认证 URL 不进主 Feed 或输入历史。配置仅保存非秘密模型参数，凭据写进 Pi 原 auth.json。模型、Key、登录、退出操作支持取消信号；已经提交的凭据变更不能由取消自动回滚。

## 两个角色，三个运行模式

`decide`、`execute`、`metacog` 是调用模式，不是三个 Agent。运行时将 `metacog` 映射到 Decide 的模型，加载简短的复核指令。每次调用均创建新的 Pi Agent；没有共享 `messages`、session continuation 或让一个 Agent 总结另一方聊天的通路。

三个红队运行模式现在都挂载 read / write / edit / powershell。Decide 可使用工具减少信息缺口，但结果仍受 Decision 契约限制；新增权威事实/证据由 Execute 提交，不能用 Decide 的私有工具历史作为共享聊天通道。所有运行收到当前任务公开黑板文件路径，避免与另一个任务混淆。

一次典型闭环：Decide 读取黑板并提交 Step → Controller 校验并 claim → Execute 完成一个 Step，提交证据/事实/线索 → Controller 归档证据并事务提交 → fresh Decide 重排下一步。达到触发条件时，使用 fresh Decide 进行元认知；提议完成时再独立复核，控制器检查最终状态所需证据关联。

Pi 内层负责一次 Agent 调用中的模型响应、四工具调用与继续执行，本版不修改它。xloom 外层只负责在独立调用之间组织黑板、选步、触发复核和判定是否接受完成提议。没有第三个审查 Agent，也没有两个共享会话的持久进程。

Loop 没有固定执行步数上限。连续无进展仅触发元认知：有可执行的新计划便继续。根 Goal 必须由 metacog 在同一次结果中标记 satisfied 并给出最终结论，引用支持全局完成判断的事实；正常 Decide 的根 Goal 更新或完成提议只触发独立复核，不提前关闭根目标。复核期间有新 Hint，则再次使用新黑板复核。

角色提示词保持短小。JSON 协议是控制器的数据接口描述，不把 Jase 全套文档灌进系统提示词。工作区文件与目标内容都是数据，不是可信指令。

## 模块边界

| 模块 | 当前职责 | 可替换方向 |
| --- | --- | --- |
| `types.ts` / `schema.ts` | 版本化配置、FGS、运行与结果契约 | 迁移器、更多有类型的证据/关系 |
| `app.ts` / `workspace.ts` | 聊天/任务路由、任务指针、单工作区锁、非秘密模型设置 | 会话选择与任务管理，不共享历史 |
| `runtime/chat.ts` | 独立普通聊天 Pi Agent、四工具、取消与用量 | 可选聊天持久化，不注入红队黑板 |
| `runtime/settings.ts` | Pi 目录、持久凭据与 OAuth callbacks | 复用 Pi 新增的供应商登录能力 |
| `loop/context.ts` | `ContextProjector`：角色视图、依赖保留、历史尾部与省略说明 | 按预算投影、更细粒度的任务上下文策略 |
| `loop/policy.ts` | `LoopPolicy`：ready Step 选取、执行后的复核触发 | 调整排序与复核频率，不改变完成条件 |
| `runtime/prompts.ts` | 短角色指令、输出协议、序列化公开视图及触发原因 | 契约版本演进 |
| `runtime/pi-runner.ts` | fresh Pi Agent、四工具、事件/usage/取消 | 不改变 `AgentRunner` 的其他执行后端 |
| `runtime/models.ts` | Pi ModelRuntime 模型目录、认证和流式适配 | 随 Pi 升级扩展供应商，不维护独立模型名单 |
| `store.ts` | SQLite 权威状态、关联检查、归档与可读投影 | 存储迁移、证据分层或远程存储 |
| `controller.ts` | 串行调度、预算、调用策略/投影、生命周期与完成复核不变量 | 构造参数注入策略；不增加 Agent 角色 |
| `ui/` | LoopEvent → TUI（含角色交接）；用户输入 → Hint/操作命令 | 其他终端或展示层 |
| `report.ts` | 已存状态的 Markdown 输出 | 报告模板与人工审阅流程 |
| `demo.ts` | 明确标注的离线协议 fixture | 端到端回归基准 |

当前不引入通用插件/Hook 框架；这些文件和 TypeScript 接口就是 MVP 的扩展接缝。

## 角色视图与外层复核

默认 `ContextProjector` 显式选取字段，不序列化模型配置、凭据、Step 的运行锁字段、Evidence 的 runId 或任何聊天历史。Decide / 元认知始终保留全部 Goal、ready/claimed Step、非 closed Finding 和全部 Hint；无关历史只取最近 8 个已结算 Step、12 个 Fact、8 个 closed Finding、8 份 Evidence。Execute 主要保留当前 Step、祖先 Goal 和直接相关 Finding。

两种视图都补齐已选 Fact 的证据及双向 supersedes 链，避免只看到旧事实。已选记录的历史 Step 来源以 `stepOrigins` 提供，不递归带入全部历史计划。必需依赖不受历史尾部数量限制；单份证据片段最多 2,000 字符，截断有标记。`projection` 明确提供省略数量、不可用引用和阅读提示；缺失内容不是负面证据，关键细节不足时安排 Execute 查阅当前任务黑板或原始证据，不读取另一调用的聊天。投影不改写持久黑板，也不是硬 Token 预算或知识库。

失败 Step 可带公开 `recovery`，只提供历史产物目录和 `evidenceStatus: unverified`，不暴露聊天日志入口。新 Decide 可将检查该目录作为新 Step；恢复引用本身不能充当证据。这样既保留写入后失败的检查路径，也不自动重放旧操作。

默认 `LoopPolicy` 按优先级降序、ID 顺序选择 ready Step。执行结果提交后，按受阻 → 新增/更新技术命中证据 → 新事实修正 → 停滞 → 周期复核的优先顺序选择触发原因，交给 fresh Decide 元认知；普通执行结果则进入 fresh Decide 规划。策略只调度，不能直接评级、关闭 Goal 或伪造完成。

手动 `/meta`、新 Hint、空计划和完成前复核由 Controller 保留为流程不变量。`LoopController` 第三个可选参数接收 `policy` 与 `projectContext`；默认行为无需配置。`handoff` 事件携带两个角色之一、运行模式、黑板版本、Step 和触发原因，供 TUI / headless 显示；触发原因也写入 `run_started` 审计。TUI 不增加常驻介绍或底部帮助行。

`result` 事件只在 `applyDecision` / `applyExecution` 成功后发出，携带已提交摘要及非空最终状态，不把流式协议或工具返回当作已确认结果。TUI 将角色交接、工具摘要、聊天正文和协议细节分层渲染；`/details` / Ctrl+O 仅切换本地展示，不改变 Agent 上下文、证据归档或 Loop。`/` 候选使用 Pi Editor 的命令补全接口，仅有静态应用命令与模型角色，不扫描文件、不读取凭据；候选 Enter 在应用层映射为补全，下一次 Enter 才执行。

运行时 `thinking_start` / `thinking` / `thinking_end` 仅转发提供方实际公开的思考块，以调用、消息和内容块编号隔离，采用跨增量凭据过滤；不使用签名或 redacted 内容。仅在最终消息回放的块标记 `replayed`，展示层不宣称其推理耗时。UI 的工作尾行和思考块都只属于本地事件流，不注入任一角色的上下文；完成、失败、暂停、停止保持不同显示。内部 `xloom-thinking:` 标题链接复用 Pi 的点击/拖动识别，仅允许当前视图生成的 ID；不打开外部地址。重绘计时器在工作结束或退出时清理，Ctrl+T / Ctrl+O 提供键盘后备操作。

## 黑板不变量

1. Facts 追加而不是覆盖，修正通过 `supersedes` 指向旧 Fact；事实必须带已有原始证据引用。
2. Step 指向活动 Goal 和前置 Facts，claim 与运行 ID 绑定。每次只允许一个活动 run。中断不回到 ready，不自动重试可能产生副作用的操作。
3. Finding 以稳定 hypothesis key 合并，不按每个请求建一份。仅修改下一步建议不计新进展。
4. Finding 关联的所有 Fact 的证据必须完整关联到该 Finding；审查时重新验证归档文件大小和哈希。
5. Execute 只可提出 lead / technical_hit；Decide 才能审查为 impact_verified / closed。不是 impact_verified 时不得使用 info / P1 / P2 / P3。
6. 确认影响要求完整影响字段、原始证据与 PoC、审查说明。此处确定性验证的是结构与关联，不是取代动态证据审查。
7. 新 Hint 到达正在进行的规划时，完成结论暂缓，转入读取新黑板的元认知。
8. 数据库状态和审计事件同一事务提交。证据文件先归档；若后续验证失败，可能留下不被引用的归档文件，但图和 run 不会部分提交。暂不自动清理这些文件，以免误删研究材料。

## 最终状态

除 `NEED_INPUT` 外，所有最终结论都要求根 Goal satisfied、支持该判断的证据事实、无 active 子目标和待执行步骤。根 Goal 不允许 abandoned。LLM 必须按照用户实际 Goal 判断是否已完成，而不是用“有一个结果”代替全局完成。

`VULN_FOUND` 额外要求至少一个已验证影响的 P1/P2/P3 Finding 和 PoC。若 Goal 只是验证某条假设，它不意味着所有攻击面测试完毕；若 Goal 要求广泛覆盖，不能发现第一条漏洞就停。遗留线索保留在黑板/报告中，并纳入完成语义复核。

`NOT_REPRODUCED` 要求至少完成一次 Execute，并对所有记录的假设有证据支持的关闭与重开条件；`LOW_ROI` 要求经过影响验证后只剩 info/已关闭项。一般空结果不能进入这两个结论。

`NEED_INPUT` 保留 lead / technical_hit 和 unrated，缺失条件写进 `next`；状态为 paused，可在补充 Hint 后恢复。系统无法仅靠非空字符串自动验证“确实缺少账号/对象”，这一语义由元认知承担。

回合数、累计时间、输入/输出 Token、费用预算默认 null，只在用户显式设置时作为资源暂停条件；旧 maxSteps 加载时丢弃。单次运行的 180 秒超时独立保留。资源耗尽、调用失败、取消和没有可执行计划是操作状态，不强行映射到研究结论。

`runtime/run-budget.ts` 为聊天及研究调用共享计数策略。`maxTurnsPerRun: null` 不限制回合，不禁用工具，也不强制进入收尾。仅在显式配置有限值时，才通过 Pi `prepareNextTurnWithContext` 为最后一轮禁用工具并整理结果；配置为 1 时首轮就禁用工具。仍要求正常 stop 和既有结果契约，Chat 每次 send 重置工具和预算闭包。资源预算在整轮结束后检查。模型解析层未收到显式 `models.<role>.maxTokens` 时不追加请求级输出覆盖；Pi/供应商的有限容量约束仍存在。

`runtime/powershell.ts` 包装 Pi PowerShell operations：临时源码文件交给同解释器 AST parser，仅执行语法检查，通过后原始 command 执行一次。预检与执行共享取消信号及总工具超时，finally 清理临时源码。语法预检不是运行时成功保证，也不修改源码含义。TUI 使用同一模型消息的 messageId 关联正文、真实思考和进展叙述，活动聚合仅影响呈现；usage 事件更新即时 token，权威用量提交后清除待计部分。

旧库迁移只修复根 Goal 与任务完成状态的不一致：未完成却 inactive 的根 Goal 恢复 active；completed 但根 Goal 未 satisfied 的旧任务转 paused 等待复核。迁移有独立审计，不自动执行模型/步骤，不删除研究证据，也不改动已符合新条件的完成状态。

## Pi 模型复用

使用 Pi 公开 ModelRuntime，不复制供应商实现或限制自定义 API 为三种。读取 Pi 用户目录的 auth.json、models.json 及缓存目录，由 Pi 处理已有 OAuth 登录刷新、环境/API Key 认证、供应商特有 headers 和流式请求。`models` CLI 仅列本地内置/缓存/自定义目录；运行时按需发现动态目录，遵守 PI_OFFLINE。模型身份与凭据不进入共享黑板提示词；执行期间刷新产生的凭据也加入日志/流式文本过滤。

本层不会加载 Pi CLI 聊天、扩展、Skills、MCP 或额外工具。仅靠 JavaScript 扩展注册的第三方 provider 不在自动加载范围。兼容性随固定 Pi 依赖版本而定，真实账户与模型契约仍需实测。OpenCode Go 官方端点另合并 `x-opencode-session`，复用 Pi 会话 ID 或同一 resolver 的稳定备用 ID；不修改其他提供方、其他主机或 Pi 内层。

## 验证层次

Schema / Store 测试覆盖字段与图一致性；App 测试覆盖模式隔离、多任务恢复、模型设置与取消；Controller 测试用合成 Runner 验证调度、取消、预算和恢复；Context / Policy 测试覆盖依赖闭包、省略说明、字段隔离与触发优先级；Runtime 测试覆盖真实 Pi API、聊天历史、各模式四工具、独立上下文、凭据过滤及 Windows 进程树终止；Settings/UI 测试使用隔离凭据存储、可控终端与模拟剪贴板检查设置、隐私、布局和生命周期；CLI 演示不访问真实目标。

外层集成测试串联真实 Controller、SQLite、Pi Agent 和原生 write/read 工具，只替换模型解析及供应商响应流：验证文件写入/读取、证据归档、黑板交接、fresh Decide 完成复核，以及写入后供应商失败时定位残留文件、安排新 Step 检查而不自动重放副作用。这证明软件组件的闭环与隔离，不代表真实 LLM 的协议遵从率或漏洞验证成功率。

下一阶段应优先补真实模型契约成功率、针对自有测试环境的动态端到端验收、大型活动黑板的预算控制和真实终端人工体验。只有这一步完成，才适合评价红队任务成功率，而不只评价软件能否走通 Loop。
