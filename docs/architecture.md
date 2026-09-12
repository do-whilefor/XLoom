# MVP 架构与后续接口

## 两个角色，三个运行模式

`decide`、`execute`、`metacog` 是调用模式，不是三个 Agent。运行时将 `metacog` 映射到 Decide 的模型，加载简短的复核指令。每次调用均创建新的 Pi Agent；没有共享 `messages`、session continuation 或让一个 Agent 总结另一方聊天的通路。

一次典型闭环：Decide 读取黑板并提交 Step → Controller 校验并 claim → Execute 完成一个 Step，提交证据/事实/线索 → Controller 归档证据并事务提交 → fresh Decide 重排下一步。达到触发条件时，使用 fresh Decide 进行元认知；提议完成时再独立复核，控制器检查最终状态所需证据关联。

角色提示词保持短小。JSON 协议是控制器的数据接口描述，不把 Jase 全套文档灌进系统提示词。工作区文件与目标内容都是数据，不是可信指令。

## 模块边界

| 模块 | 当前职责 | 可替换方向 |
| --- | --- | --- |
| `types.ts` / `schema.ts` | 版本化配置、FGS、运行与结果契约 | 迁移器、更多有类型的证据/关系 |
| `runtime/prompts.ts` | 黑板投影及短角色指令 | 基于目标的上下文切片、压缩策略 |
| `runtime/pi-runner.ts` | fresh Pi Agent、四工具、事件/usage/取消 | 不改变 `AgentRunner` 的其他执行后端 |
| `store.ts` | SQLite 权威状态、关联检查、归档与可读投影 | 存储迁移、证据分层或远程存储 |
| `controller.ts` | 串行调度、预算、元认知触发、生命周期 | 调度策略、更多触发器；不增加 Agent 角色 |
| `ui/` | LoopEvent → TUI；用户输入 → Hint/操作命令 | 其他终端或展示层 |
| `report.ts` | 已存状态的 Markdown 输出 | 报告模板与人工审阅流程 |
| `demo.ts` | 明确标注的离线协议 fixture | 端到端回归基准 |

当前不引入通用插件/Hook 框架；这些文件和 TypeScript 接口就是 MVP 的扩展接缝。

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

`VULN_FOUND` 要求至少一个已验证影响的 P1/P2/P3 Finding 和 PoC；它不是“所有攻击面测试完毕”的声明，其他线索会留在黑板/报告中。

`NOT_REPRODUCED` 要求至少完成一次 Execute，并对所有记录的假设有证据支持的关闭与重开条件；`LOW_ROI` 要求经过影响验证后只剩 info/已关闭项。一般空结果不能进入这两个结论。

`NEED_INPUT` 保留 lead / technical_hit 和 unrated，缺失条件写进 `next`；状态为 paused，可在补充 Hint 后恢复。系统无法仅靠非空字符串自动验证“确实缺少账号/对象”，这一语义由元认知承担。

预算耗尽、调用失败、取消和没有可执行计划是操作状态，不强行映射到研究结论。

## 验证层次

Schema / Store 测试覆盖字段与图一致性；Controller 测试用合成 Runner 验证调度、取消、预算和恢复；Runtime 测试覆盖真实 Pi API、工具数量、独立上下文、凭据过滤及 Windows 进程树终止；UI 测试使用可控终端检查布局与生命周期；CLI 演示不访问真实目标。

下一阶段应优先补真实模型契约成功率、针对自有测试环境的动态端到端验收、长黑板投影策略和真实终端人工体验。只有这一步完成，才适合评价红队任务成功率，而不只评价软件能否走通 Loop。
