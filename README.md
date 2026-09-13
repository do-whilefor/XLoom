<h1 align="center">Xloom</h1>

<p align="center">基于 Pi Agent 内核的 Windows 双 Agent 安全研究 Loop</p>

<p align="center">
  <a href="#使用边界"><img src="https://img.shields.io/badge/Scope-Authorized%20Security%20Research-blue" alt="Scope: Authorized Security Research"></a>
  <a href="#核心设计"><img src="https://img.shields.io/badge/Agent-Decide%20%7C%20Execute-6f42c1" alt="Agent: Decide and Execute"></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Runtime-Node%2024%20%7C%20PowerShell%207-success" alt="Runtime: Node 24 and PowerShell 7"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License: MIT"></a>
</p>

Xloom 是一个本地运行、面向授权安全研究的双 Agent 研究 Loop。

默认以普通聊天打开，模型可以使用四个工具。输入 `/run 目标` 切换到双 Agent 红队任务：两个角色不共享聊天历史，只通过结构化黑板协作。Decide 负责计划、读取证据与审查，仅有 `read`；Execute 使用 `read / write / edit / powershell` 深入调查当前步骤，并可先提交关键观察再继续或交回规划。元认知是 Decide 的一次全新上下文调用，不是第三个 Agent。

它不做批量扫描，也不预设漏洞数量，而是模拟真实研究过程：

> 探索 → 假设 → 技术命中 → 证据 → 危害验证 → 结论

---

## 核心原则

> 广泛探索，严格验证。没有完整证据，不确认漏洞。

- 以服务端认证、授权、对象归属、租户隔离、状态流转和业务规则为主要安全边界。
- 静态特征、扫描结果、错误信息、历史案例只能生成线索，不能替代动态验证。
- 技术命中保持 `unrated`；只有证据关联、影响字段与 PoC 通过审查后，才允许 `impact_verified` 与评级。
- 使用文件保存状态和证据，而不是让模型凭上下文记忆重复测试、遗漏测试或凭空重建结论。

## 核心设计

### 两个角色，三种运行模式

`decide`、`execute`、`metacog` 是调用模式，不是三个 Agent。每个新 run 创建新的 Pi Agent，消息数组从空开始；不同 run / 角色之间不共享 `messages`。

- **Decide / 元认知**：仅挂载 `read`，负责规划、读取证据、验证交接条件与审查。元认知映射到 Decide 的模型，在同一套黑板上的全新上下文复核。
- **Execute**：使用四个工具完成调查与状态变更，新增的权威事实 / 证据由 Execute 提交。

一次典型闭环：

```text
Decide 读取黑板并提交 Step
  → Controller 校验并 claim
  → Execute 调查，必要时阶段性提交证据 / 事实 / 条件尝试
  → Controller 归档证据并事务提交
  → Execute 继续或交回 fresh Decide
  → 触发条件满足时元认知复核
  → 完成提议由独立复核确认
```

### FGS 黑板

Agent 不共享完整聊天历史，而共享结构化状态。Controller 验证提案后统一提交，Agent 不直接写权威黑板。

```text
Fact / Goal / Step  +  Finding / Evidence / Hint
```

- 按角色投影黑板：提供全部 Fact 的简短索引，按依赖补齐 `Fact → 来源 Step → 前置 Facts` 因果链与修正链。
- 旧事实被修正后，依赖它的待办先回到规划复核。
- Execute 通过 `write` 向 `artifacts/checkpoint.json` 提交阶段结果，事实、证据和累计用量原子入库。
- 中断步骤标记失败，不盲目重放；后续失败保留已提交成果。

### 证据与状态

- SQLite WAL 持久化、追加审计事件、步骤 claim、单控制器锁、暂停 / 停止 / 恢复。
- 证据归档与 SHA-256 校验、引用完整性检查、组合前提和带条件的尝试记录。
- 重复记录不计进展；时间戳变化的原始证据仍保留。
- 完成必须来自一次 fresh Decide review，确认根 Goal 已满足并引用证据事实。步数只计数，不设任务上限。

## 快速开始

需要 Windows、Node.js 24+、PowerShell 7（`pwsh.exe` 在 PATH 中）。推荐 Windows Terminal。模型服务凭据由用户提供。

```powershell
Set-Location 'D:\path\to\xloom'
npm ci --ignore-scripts
npm run check

# 不连接模型、不访问外部目标的合成闭环演示
npm start -- demo --headless

# 打开普通聊天 TUI；首次自动生成不含凭据的 xloom.json
npm start -- run
```

在 TUI 中使用 `/model` 选择模型、`/apikey` 设置 Key，也可复用 Pi 已保存的认证。普通文字为聊天；`/run 目标` 启动双 Agent；`/hint 文字` 补充任务信息；`/help` 查看全部命令。

```powershell
npm start -- run --headless      # 立即启动 / 恢复已配置任务
npm start -- status              # 只读当前任务状态，不调用模型
npm start -- report              # 输出 Markdown 报告
npm start -- models              # 列出 Pi 本地模型目录
```

构建后也可使用 `node dist/cli.js`，或 `npm link` 后使用 `xloom`。

## 项目结构

```text
xloom/
├── src/
│   ├── app.ts / cli.ts            # 应用路由、TUI / CLI 入口
│   ├── controller.ts              # 串行调度、预算、生命周期、完成复核
│   ├── store.ts                   # SQLite 权威状态、归档与可读投影
│   ├── schema.ts / types.ts       # 版本化配置与结果契约
│   ├── loop/                      # ContextProjector / LoopPolicy / 尝试去重
│   ├── runtime/                   # Pi 运行适配、四工具、模型、续接、阶段提交
│   └── ui/                        # LoopEvent → TUI
├── docs/
│   ├── architecture.md            # MVP 架构与扩展接口
│   └── guide.md                   # 完整使用说明与行为边界
├── tests/                         # vitest 单元与集成测试
├── xloom.example.json             # 配置样例
└── LICENSE
```

运行数据写入工作区 `.xloom/`：每个 `/run` 对应一个独立任务目录，包含该任务的 `blackboard.sqlite`、可读投影、归档证据与运行产物。`.xloom`、`xloom.json` 默认不进 Git。

## 模型与配置

模型目录、供应商适配和认证直接使用依赖 Pi 的 `ModelRuntime`，不维护独立的模型白名单。`models.chat`、`models.decide`、`models.execute` 可配置不同模型；元认知始终复用 decide。

```json
{
  "provider": "my-endpoint",
  "model": "your-model-id",
  "api": "openai-completions",
  "baseUrl": "https://your-endpoint.example/v1",
  "apiKeyEnv": "XLOOM_MODEL_KEY",
  "thinking": "off"
}
```

配置不接受明文 Key。复用 Pi 用户目录（默认 `~/.pi/agent`）的 `auth.json`、`models.json` 和模型缓存，支持环境认证、API Key 与 OAuth 登录 / 刷新。默认不设置运行时间、回合数或 token 硬上限，用户可随时 `/pause` 或 `/stop`。

## 明确的边界

这是上下文隔离，不是操作系统沙箱。普通聊天和 Execute 的原生文件及 PowerShell 工具拥有当前用户权限，Decide / 元认知仅挂载 `read`。提示词禁止读取其他 run 的聊天 / 日志和凭据，但不声称能用提示词阻止越权读文件。

引用、文件哈希与 JSON 校验只能保证结构和证据完整性，**不能独立证明请求确实发生或漏洞成立**。真实性、可复现性、实际影响和缺失条件的判断仍依赖模型对原始证据的审查及用户复核。

本版没有完整浏览器、网络代理、扫描器插件、MCP、Skills、额外工具注册、第三 Agent、跨任务长程记忆或多任务并发。`demo` 与单元测试中的合成证据仅验证软件闭环，不能作为真实漏洞研究结果。

## 使用边界

本仓库仅用于以下场景：

- 明确授权的漏洞赏金和 SRC 测试范围。
- 用户自有系统、测试环境、实验室或本地搭建的开源项目。
- CTF、靶场、安全课程和防御性研究。
- 经授权的代码审计、接口测试和漏洞复现。

禁止用于：

- 未经授权扫描、探测、入侵或利用第三方系统。
- DoS、DDoS、持续压测、资源耗尽或影响业务可用性的行为。
- 删除、破坏或不可逆修改真实业务数据。
- 建立 WebShell、后门、计划任务、反向 Shell 或其他持久化访问。
- 横向移动、攻击无关资产、窃取凭证、钓鱼、撞库或社会工程。
- 违反适用法律、平台规则或目标方明确限制的行为。

## 免责声明

本项目仅用于合法授权的安全研究、教育和测试环境。

使用者必须自行确认其拥有充分授权，并对目标范围、测试方法、工具配置、数据处理、证据保存和后续影响承担全部责任。作者不对任何未经授权的使用、错误配置、数据丢失、业务中断、法律责任或其他直接或间接损失承担责任。

本项目不保证能够发现漏洞，也不保证发现数量、严重程度或 AI 输出的正确性与完整性。任何结论都应由具备资质的测试人员进行独立验证。

## License

本项目采用 [MIT License](LICENSE)。设计参考 Cairn / Cairn_Y 的黑板协作与 FGS，以及 Jase 的边界建模与影响闭环方法，均为独立实现。Pi 及第三方依赖保留各自原有许可。
