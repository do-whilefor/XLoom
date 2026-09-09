<h1 align="center">XLoom</h1>

<p align="center">面向授权安全研究的极简双 Agent 调查 CLI：Probe 广泛探索，Proof 独立验证，以共享 Blackboard、AttackPath 与真实证据驱动漏洞结论。</p>

<p align="center">
  <a href="#使用边界"><img src="https://img.shields.io/badge/Scope-Authorized%20Security%20Research-blue" alt="Scope: Authorized Security Research"></a>
  <a href="#核心架构"><img src="https://img.shields.io/badge/Agents-Probe%20%7C%20Proof-6f42c1" alt="Agents: Probe and Proof"></a>
  <a href="#pi-与上下文"><img src="https://img.shields.io/badge/Runtime-Pi%20v0.85.1-success" alt="Runtime: Pi v0.85.1"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6" alt="TypeScript 5.9">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License: MIT"></a>
</p>

`XLoom` 是一个面向授权红队、安全研究、漏洞挖掘和 AI 辅助安全调查的命令行 Agent。

它不追求更多 Agent、复杂工作流或一次性加载大量安全知识，而是固定使用两个长期角色：

- **Probe**：探索未知状态、扩大攻击面、形成可验证线索。
- **Proof**：独立复核关键假设，完成动态验证、对照实验与影响确认。

两个角色共享同一份 **Blackboard**，但不共享彼此的私有聊天历史。调查状态、事实、证据、任务、验证结果和 AttackPath 通过持久化事件保存，可恢复、可追溯，也可以在事实变化后自动使旧结论失效。

---

## 核心原则

> **广泛探索，严格验证。没有完整证据，不确认漏洞。**

XLoom 的基本判断规则：

- 扫描结果、静态代码命中、异常响应和模型推测只能生成线索。
- 技术命中不等于真实安全影响。
- Probe 负责探索，关键安全结论优先交给独立 Proof 验证。
- 只有当前有效、非重复、完成 Proof 验证的 `impact_verified` 才计入已确认问题。
- Fact 被纠正后，依赖它的 Finding、Proof 和 AttackPath 可以自动失效。
- Blackboard 保存任务需要的状态与证据，不保存完整思维过程。
- 所有测试仅限明确授权、自有系统、靶场或可控实验环境。

---

## 为什么是 XLoom

传统单 Agent 安全测试很容易出现几个问题：

- 探索和确认混在一起，模型容易把“可能存在”写成“已经确认”。
- 长任务依赖聊天上下文，压缩或恢复后容易遗漏状态。
- 工具输出很多，但缺少统一的证据关系和结论约束。
- 固定 Checklist 容易过早收敛，而真正有价值的漏洞路径往往是未知的。

XLoom 将问题简化为：

```text
探索未知状态
    ↓
形成 Hypothesis
    ↓
保存 Evidence
    ↓
独立 Proof
    ↓
确认 / 反驳 / 保留未知
    ↓
更新 Blackboard
    ↓
连接 AttackPath
    ↓
生成 Report
```

重点不是“让更多 Agent 同时工作”，而是让探索、验证、状态和证据形成一个稳定闭环。

---

## 核心架构

```text
                         ┌──────────────────┐
                         │   User Goal      │
                         │ Scope / Success  │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Case / Scheduler │
                         │  串行调度与预算   │
                         └───────┬──────────┘
                                 │
                  ┌──────────────┴──────────────┐
                  │                             │
                  ▼                             ▼
        ┌──────────────────┐          ┌──────────────────┐
        │      Probe       │          │      Proof       │
        │ Explore / Probe  │          │ Verify / Control │
        └────────┬─────────┘          └────────┬─────────┘
                 │                             │
                 └──────────────┬──────────────┘
                                ▼
                     ┌──────────────────────┐
                     │      Blackboard      │
                     │ Fact / Hypothesis    │
                     │ Evidence / Task      │
                     │ Finding / AttackPath │
                     └──────────┬───────────┘
                                │
                                ▼
                     ┌──────────────────────┐
                     │  results/report.md   │
                     └──────────────────────┘
```

两个角色固定拥有六个外部能力入口：

```text
read
write
edit
bash
chrome
kali
```

一次只执行一个 Run。XLoom 不引入第三 Agent、并行 Agent 群、向量数据库或复杂 Capability Registry。

---

## 主要能力

### 1. Probe / Proof 双 Agent

Probe 和 Proof 是两个独立、连续的 Agent Session。

**Probe** 更偏向：

- 暴露面探索
- 代码与页面分析
- 状态空间扩展
- 生成 Hypothesis
- 寻找新的入口、对象、关系和异常状态

**Proof** 更偏向：

- 独立复核
- 动态验证
- 正向 / 负向对照
- 影响确认
- 证据完整性检查
- 反驳错误假设

用户只需要给 XLoom 一个 Goal，不需要分别指挥两个角色。

### 2. Blackboard / Case Engine

Blackboard 是整个调查的共享事实层和状态源。

它维护：

- Goal / Scope / Success Condition
- Intent / Task
- Fact
- Hypothesis
- Evidence
- Finding
- AttackPath
- 修正、反驳与失效关系
- Agent Run 与调查进度

Agent 的聊天记录不是调查事实本身；关键结论必须通过结构化更新提交到 Blackboard。

### 3. Evidence 驱动的漏洞确认

XLoom 区分：

```text
lead
  ↓
technical_hit
  ↓
impact_verified
```

工具命中、HTTP 200、扫描器告警或模型文字说明都不能直接升级为已确认漏洞。

Proof 确认通常要求：

- 本次真实观察
- 当前有效 Evidence
- 明确测试范围
- 必要的对照实验
- 真实影响解释
- 可复现的对象、状态或结果

### 4. AttackPath

XLoom 可以把少量已验证状态连接组织成 AttackPath。

只有被有效 Proof 覆盖的 `enables` 关系才可以作为已验证连接。相关性、推测、支持说明或部分链路不会被自动当成完整攻击路径。

当基础 Fact 被纠正时，相关路径和确认结果会同步重新计算。

### 5. 自动报告

每次知识发生变化或一个周期结束后，XLoom 会自动更新：

```text
results/report.md
```

报告包含：

- Scope
- 已确认问题
- 未确认事项
- AttackPath
- 聚合与重复项
- 当前任务
- Evidence 相对路径
- 已记录的模型用量

报告是 Blackboard 的投影视图，不是新的事实来源；丢失后可以从事件重新构建。

---

## Pi 与上下文

XLoom 基于 **Pi v0.85.1** 的 Agent Runtime 能力构建，并保留其核心的 Session、Streaming、Tool Loop、Compact 等基础能力。

在此基础上，XLoom 增加：

- Probe / Proof 双角色
- Case Engine
- Blackboard
- Scheduler
- Evidence
- AttackPath
- Capsule
- 自动报告
- Chrome / Kali 工具接入
- 面向安全调查的结论约束

每次模型请求不会重新塞入完整 Blackboard，而是生成一份当前角色真正需要的 **Capsule**，主要包含：

```text
Goal / Scope
Intent
相关有效对象
相关 Fact / Hypothesis
纠正与反驳
相关 Delta
Evidence 路径
未知执行结果
```

Proof 不接收 Probe 的私有聊天历史。

当上下文接近容量时，XLoom 使用 Pi 的 Compact 机制只压缩当前角色，另一角色历史、Blackboard 和 Evidence 不会一起被摘要掉。

---

## Chrome / Kali

### Chrome

Chrome 作为一个高权限、按需连接的工具入口。

XLoom 使用固定版本的 Chrome DevTools MCP，通过：

```text
--autoConnect
```

连接当前桌面用户已经运行的 Chrome，复用现有 Profile、登录状态和 Cookie，不额外创建隔离 Profile。

运行前：

1. 使用 Chrome Stable 144+。
2. 打开：

```text
chrome://inspect/#remote-debugging
```

3. 开启远程调试，并允许 Chrome 自身的连接授权。
4. 启动 XLoom。

`chrome` 对模型暴露为一个工具入口，由模型按需选择页面、网络、DOM、截图、执行脚本等操作。

### Kali

Kali 通过 SSH 独立连接，不与本机 Bash 混用。

在 `~/.xloom/config.json` 中加入：

```json
{
  "kali": {
    "host": "192.168.1.100",
    "port": 22,
    "username": "kali",
    "password": "<SSH 密码>"
  }
}
```

每次 `kali` 调用执行独立的非交互远程命令。

模型不需要提前加载 Kali 中所有工具列表；需要某个能力时可以直接检查，例如：

```bash
command -v nmap
command -v nuclei
command -v sqlmap
```

Chrome 与 Kali 都采用 **lazy connect**：启动 XLoom、查看状态、恢复会话或 Compact 时不会主动连接，第一次真正调用时才初始化。

---

## 支持的模型

当前支持以下 Provider：

- GLM
- Kimi
- DeepSeek
- Anthropic
- OpenAI

支持的模型协议：

- Chat Completions
- Anthropic Messages
- OpenAI Responses

模型配置统一位于：

```text
~/.xloom/config.json
```

示例：

```json
{
  "model": "glm-main",
  "models": {
    "glm-main": {
      "provider": "glm",
      "api": "anthropic-messages",
      "id": "glm-5.3-flash",
      "apiKey": "<YOUR_API_KEY>",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "thinking": "high",
      "contextWindow": 1000000,
      "maxOutputTokens": 16384
    }
  },
  "limits": {
    "maxRunsPerCycle": 40,
    "maxToolCallsPerRun": 50
  }
}
```

XLoom 不提供 TUI 模型菜单、透明 fallback 或自动替换模型。模型、协议和思考档位由配置明确指定。

---

## 快速开始

### 环境要求

- Linux
- Node.js `22.19+`，且为 `22.x`
- npm 10+
- Bash

### 安装

```bash
git clone https://github.com/do-whilefor/XLoom.git
cd XLoom

npm ci
npm pack
npm install --global --prefix "$HOME/.local" ./xloom-0.7.0.tgz

export PATH="$HOME/.local/bin:$PATH"
xloom
```

第一次运行如果缺少配置，XLoom 会在：

```text
~/.xloom/config.json
```

生成模板并停止。

填写模型 API Key 后重新运行：

```bash
xloom
```

然后直接输入调查 Goal。

---

## 使用方式

### 启动与恢复

```bash
xloom                      # 新建调查
xloom -c                   # 继续当前目录最近一次实际调查
xloom -r                   # 打开调查选择器
xloom -r <session-uuid>    # 恢复指定调查
xloom --help
xloom --version
```

恢复调查不会自动重新请求模型，也不会重放历史工具动作。

### Goal

第一条输入作为 Goal。

可以显式指定：

```text
起点：当前项目
范围：仅测试本地授权环境
成功条件：确认关键安全边界是否存在可利用缺陷
```

后续输入默认作为 Hint。

修改目标：

```text
修改目标：新的目标
```

### 工具范围

可以临时限制两个角色允许选择的工具：

```text
Probe 仅 chrome/read
Proof 仅 kali/read
```

或者：

```text
工具范围：Probe=chrome,read; Proof=kali,read
```

这只是 Agent 工具选择限制，不等价于操作系统级沙箱或授权边界。

### TUI 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看帮助与快捷键 |
| `/resume` | 暂停当前工作并切换调查 |
| `/compact [保留重点]` | 压缩当前或最近活动角色上下文 |
| `/status` | 查看 Goal、任务、结果、模型、Session 与用量 |
| `/exit` | 保存并退出 |

常用快捷键：

```text
Enter         提交
Shift+Enter   换行（取决于终端协议）
Esc           暂停当前调查
Ctrl+O        折叠 / 展开工具输出
Ctrl+T        折叠 / 展开提供商公开的可见思考
Ctrl+C        清空输入；短时间内再次按下退出
```

---

## 保存与恢复

默认数据目录：

```text
~/.xloom/
├── config.json
├── logs/
└── sessions/<root-session-uuid>/
    ├── session.json
    ├── timeline.jsonl
    ├── agents/
    │   ├── probe.jsonl
    │   └── proof.jsonl
    ├── blackboard/
    │   ├── events.jsonl
    │   └── view.md
    ├── results/
    │   └── report.md
    └── artifacts/
        └── <run-id>/
            └── <call-ref>/
```

Blackboard Event 是调查状态的权威来源。

长工具输出与原始执行结果保存到 Artifact，模型需要时再通过 `read` 分段读取，避免把大量原始输出永久塞进上下文。

---

## 项目结构

```text
XLoom/
├── src/
│   ├── backends/      # 模型协议与后端支持
│   ├── case/          # Blackboard、Case Loop、Scheduler、Capsule、AttackPath、Report
│   ├── prompts/       # Probe / Proof 等角色提示
│   ├── runtime/       # Agent、模型、Provider、Compact、Usage
│   ├── session/       # Session 保存与恢复
│   ├── tools/         # read/write/edit/bash/chrome/kali 等工具实现
│   ├── tui/           # 终端交互界面
│   └── vendor/pi/     # Pi Runtime 基线
├── scripts/
├── config.example.json
├── package.json
└── README.md
```

---

## 设计取舍

XLoom 当前刻意不做：

```text
第三 Agent
多 Agent 并行群
复杂 Hook 网络
Tree / Fork / Branch 会话模型
向量数据库
模型菜单
自动 Provider fallback
透明 retry
完整 Kali Capability Registry
一次性加载大型 Security Skills
```

核心思路是：

```text
Pi 负责 Agent Runtime
XLoom 负责安全调查状态、双 Agent 协作与证据闭环
```

尽可能把复杂度放在真正影响调查质量的部分，而不是增加外围框架。

---

## 使用边界

XLoom 仅用于：

- 明确授权的漏洞赏金 / SRC 测试
- 用户自有系统
- 本地开源项目
- CTF / 靶场 / 实验环境
- 经授权的代码审计、浏览器分析和安全验证
- 防御性安全研究

不得用于未经授权的扫描、探测、入侵、持久化、横向移动、凭证窃取、数据破坏、拒绝服务或其他违法及高影响活动。

使用者需要自行确认测试授权、资产范围、账号权限、平台规则和适用法律。

XLoom 不保证发现漏洞，也不保证模型、工具输出或自动生成的安全结论始终正确。高影响结果应由具备相应能力的测试人员再次复核。

---

## Version

当前版本：

```text
XLoom 0.7.0 · M6
Pi v0.85.1
```

---

## License

本项目采用 [MIT License](LICENSE)。

## About

基于 Pi 的极简双 Agent 安全调查 CLI：Probe 广泛探索，Proof 独立验证，通过共享 Blackboard、AttackPath 与证据报告完成可恢复的授权安全研究。
