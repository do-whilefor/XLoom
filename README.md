# XLoom · M6

XLoom 0.7.0 加入问题聚合、AttackPath、确认失效传播与自动报告：一个 TUI、独立连续的 Probe / Proof、共享 Blackboard、串行调度，支持整个调查的恢复和按角色压缩上下文，并加入 Chrome / Kali 的固定六工具。沿用 **Pi v0.85.1**（`d981de1229ef899957bbe968bc8dcda02a21f477`），增加 **GLM / Kimi / DeepSeek / Anthropic / OpenAI** 配置及 **Chat Completions / Messages / Responses** 三种协议。各家真实验收状态见 [第六阶段结果](docs/phase-6-result.md)。


## 首次安装

从本地交付包安装：

```bash
npm install --global --prefix "$HOME/.local" ./xloom-0.7.0.tgz
xloom
```

首次缺少配置时会生成 `~/.xloom/config.json` 模板并停止；填入自己的模型 Key 后重新启动。在同一 TUI 输入一个 Goal，程序自动选择 Probe 探索和 Proof 独立验证。无需分别指挥两个角色。已有本地模型配置继续使用，模型与思考只通过配置修改。

## 当前结果与自动报告

同一边界的新观察优先补入已有候选。重复项保留独立来源，通过 `duplicateOf` 折叠；新入口不自动继承原验证范围。只有当前有效、非重复、经过独立 Proof 的 `impact_verified` 才计入已确认问题。

AttackPath 表达少量状态连接。相关、支持或反驳解释均不等于可达连接；只有 `enables` 被当前版本的有效 Proof 检查覆盖后才显示已验证。部分连接成立保留缺口，不能当完整路径，也不会让内部候选自动升级。事实纠正和路径变化会同步更新候选、连接及成功条件。

每次知识变化和周期结束后自动生成会话内 `results/report.md`，包含范围、确认/未确认事项、路径、聚合、任务、证据相对链接和已记录用量。`/status` 显示当前结果与报告位置；无需新命令。报告不是新事实，恢复会从事件重建。写入失败时显示旧 revision 已过期，成功提交的黑板仍然有效。

详细条件见 [结果与报告](docs/results.md)。历史验收范围见 [七阶段总审计](docs/acceptance.md)、[提示词与 token 优化](docs/token-optimization.md)、[第七阶段结果](docs/phase-7-result.md) 和 [Chrome/Kali 联合验收](docs/chrome-kali-acceptance.md)。其中 Kali 版本查询只属于当时授权及被测版本。

最新复核与修复见 [2026-09-09 B0–B5 继续开发结果](docs/cairny-optimization/B0-B5-continuation-result.md) 和 [当前逐项矩阵](docs/cairny-optimization/B0-B5-continuation-current-matrix.md)。[前轮复核结果](docs/cairny-optimization/B0-B5-review-result.md)、[前轮矩阵](docs/cairny-optimization/B0-B5-review-current-matrix.md)、[B5 结果](docs/cairny-optimization/B5-result.md) 和 [交付复核说明](docs/cairny-optimization/B5-delivery.md) 保留各自版本结论。沿用 Pi 0.85.1；本轮不连接 Kali。其他供应商、后端及历史必需缺项分别保留状态，构建或局部测试通过不代表全部验收通过。npm 包包含运行程序和说明；原始本地证据、测试夹具和评测答案保留在仓库测试目录，不在 npm 包内。

## 运行与继续

需要 Linux、Node.js 22.19+（22.x）、npm 10 和本机 Bash。每次普通启动新建调查，工具使用启动目录；工作文件不会回滚。

```bash
xloom                    # 始终新建
xloom -c                 # 当前目录最近一次实际工作，跳过空白启动
xloom -r                 # 选择整个调查：当前目录 / 全部，支持文字与粘贴筛选
xloom -r <完整会话UUID>    # 恢复指定调查
xloom --help
xloom --version
```

恢复会读取用户输入、有效黑板、两角色 Pi 历史和压缩分界，显示“等待输入”。输入“继续”后才按任务自动派发；已满足的目标直接显示已有结果。恢复本身不请求模型、不执行历史工具、不重新提交失败的历史协议。跨目录恢复采用会话原 cwd；目录不存在会报错。

选择器用方向键和 Enter，Tab 切换当前目录 / 全部，输入文字或粘贴筛选，Esc 取消。启动时取消选择器直接退出，不产生新会话。`-c` 与 `-r` 互斥，只接受完整 ID；恢复失败不回退到新建。

## 输入与五个命令

首条输入是 Goal，可用独立行 `起点：`、`范围：`、`成功条件：` 表达要求。后续文本是 Hint，各角色分别在安全边界接收。`修改目标：新目标` 会更新当前 Goal，同时保留原文和变更历史。“继续”不改写 Goal，也不作为新知识触发空收尾循环。

角色工具限制可写成独立行 `Probe 仅 chrome/read` 和 `Proof 仅 kali/read`，或 `工具范围：Probe=chrome,read; Proof=kali,read`。每次调用前检查最新用户限制；后续用户列表替换对应角色，`[]` 明确禁止全部，非法列表暂停等待修正。状态与恢复保留限制和消息来源。此语法只约束六工具的选择，不能替代具体目标授权或通用 shell 沙箱。

| 命令 | 行为 |
| --- | --- |
| `/help` | 帮助与快捷键 |
| `/resume` | 暂停、取消并完成当前工作收尾，再选择调查；取消或失败留在原会话暂停 |
| `/compact [保留重点]` | 压缩接受命令时的当前或最近活动角色；没有角色选择菜单 |
| `/status` | 根会话、cwd、模型、Goal、任务、结果、各角色历史与用量 |
| `/exit` | 取消、保存并退出 |

Enter 提交，Shift+Enter 换行（取决于终端协议）；Esc 暂停整个调查；Ctrl+O 折叠工具；Ctrl+T 折叠提供商公开的可见思考；Ctrl+C 清空输入，一秒内再按一次退出。折叠只改变显示，不节省已经消耗的 token。

## 上下文与 Compact

每次模型请求只投影一份最新 Capsule，包含当前 Goal/Scope、Intent、相关有效对象、纠正/反驳、相关 Delta、证据路径和未知执行结果。已存在但现在才相关的旧 Fact 不会被游标遗漏；Proof 不接收 Probe 的私有聊天历史。Hint 在原生用户消息中出现一次，Capsule 只保留引用。

实际请求估算覆盖系统提示词、工具 schema、有效历史、Capsule/Hint、协议余量和输出余量。估算不是精确 tokenizer 计数；窗口占用和累计用量分别显示。长工具输出保存原始文件，模型按需使用 `read` 分段读取。

达到输入容量时，程序使用同版本 Pi 的边界选择、摘要生成和 SessionManager 压缩记录，只压缩当前角色。手动压缩最多排一个请求；模型流和整个工具批次收尾后、下一请求前执行。最终合法结果先提交，再执行已排队的压缩。

压缩保持原角色 Session ID、原始 transcript、另一角色历史、黑板和 Evidence。新上下文只在摘要正常完成且压缩记录保存成功后激活。失败、取消或必要输入仍超量会暂停；没有自动重试或无限摘要。空闲/暂停时手动 Compact 成功后仍等待输入。Esc、退出和恢复切换优先于压缩。摘要不产生调查 Run、Fact 或 Evidence，其实际用量计入累计消耗。

## 配置

模型配置在进程启动时读取 `~/.xloom/config.json`；`/resume` 使用同一份启动配置，不读取目标会话的历史设置来覆盖它。只校验 `model` 指向的一项。五家默认协议分别为 GLM/Kimi/DeepSeek 的 Chat Completions、Anthropic Messages、OpenAI Responses；已有 GLM Messages 兼容配置继续可用。provider 选择默认行为，api 选择协议，id 原样发给服务端；不会自动探测或替换。

```json
{
  "model": "glm-main",
  "models": {
    "glm-main": {
      "provider": "glm",
      "api": "anthropic-messages",
      "id": "glm-5.3-flash",
      "apiKey": "<填写你的 API Key>",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "thinking": "high",
      "contextWindow": 1000000,
      "maxOutputTokens": 16384
    }
  },
  "limits": { "maxRunsPerCycle": 40, "maxToolCallsPerRun": 50 }
}
```

配置缺失时生成权限 0600 的模板并停止。未选中的模型可保留模板占位，只有切换为活动项时才需要填写有效 Key 和必需容量；不会因为另外四家的占位而影响当前 GLM 启动。GLM 示例的 `thinking` 支持 low/high/max；省略时不发送思考控制，保留模型默认行为。其他模型按精确能力表验证：支持关闭的模型可选 off，不会把不支持档位静默改成另一档。未知 ID 必须填写已知 `contextWindow` 与 `maxOutputTokens`，并省略尚未映射的思考设置；不自动宣称支持图像。已知模型可缩小输出限制，超出已知能力时明确报错。详见 [能力与思考映射](docs/models.md) 和 [五家配置模板](config.example.json)。达到预算暂停，用户显式继续才开启新周期。退出后修改配置再启动，可用 `-c` 继续原调查；当前进程与 `/resume` 不热加载。三种协议使用 Pi 的转换生成下一请求，原历史来源和 Evidence 不改写；跨协议真实验证范围与限制见阶段结果。没有 TUI 模型切换、CLI/环境变量模型覆盖、备用模型或透明重试；密钥不写入会话元数据、软件日志和安装包。

## Chrome / Kali 接入

安装时准备固定依赖：Chrome DevTools MCP 1.8.0、MCP SDK 1.30.0、ssh2 1.17.0。运行时首次实际工具调用才连接；启动、help/status、恢复、Compact 不主动连接。`/status` 只显示已知状态。

Chrome 需要与 XLoom 同主机、同桌面用户，使用 Chrome 144+ stable。先在现有 Chrome 的 `chrome://inspect/#remote-debugging` 开启远程调试，并允许浏览器自身的连接授权。XLoom 经 stdio MCP 的 `--autoConnect` 使用当前 Profile，不另开 Profile。`chrome` 只有 `command` 参数，固定操作为 help/pages/select/open/snapshot/click/fill/network/request/eval/screenshot；详细示例见 [接入说明](docs/backends.md)。

在已有 `~/.xloom/config.json` 中合并可选 `kali` 段（保留模型配置）：

```json
{"kali":{"host":"192.168.1.100","port":22,"username":"kali","password":"<SSH 密码>"}}
```

示例地址和密码须替换。Kali 只做密码认证，每调用独立非交互 exec；cwd 为远程目录，本机四工具的执行位置不变。配置在启动时读取，修改后退出重启，可用 `xloom -c` 继续。密码不用于 sudo/网站登录，也不读取 SSH key/agent 兜底。

原始输出按调用保存；网络检索和截图不能单独冒充新的 Proof 实验。超时、断线或取消保留部分资料并暂停整个周期，结果可能未知。切换/退出关闭自有连接，用户 Chrome 和远程文件保留；恢复不会重放动作或复活旧句柄。

历史后端验收归档：[Chrome 补充验收](docs/chrome-followup-result.md)、[Kali 验收](docs/live-kali-acceptance.md) 和 [联合验收](docs/chrome-kali-acceptance.md) 记录各自当时版本与授权范围，不能直接作为当前 B5 的通过结论。本轮不连接 Kali，当前结果见 [B5 结果](docs/cairny-optimization/B5-result.md)。源码目录可运行 `npm run test:chrome` 单独检查浏览器，`npm run test:chrome:live` 验证模型自动驱动 Chrome 的双角色调查。`npm run test:kali` 会访问已配置的真实 SSH；`npm run test:joint` 会使用当前模型、Chrome 与 Kali 上的短命合成服务，须有对应调查范围授权后再执行。临时服务仅含合成数据，结束时关闭，不安装远端程序。

历史 Chrome 单端模型验收曾因非法 Update 未通过，详见原记录；本轮增加了单点确认示例和同批单条补丁约束。联合调查会单独核对真实后端、工具范围、独立验证、报告及恢复，不以接口连通代替完整闭环。模型仍可能违反协议；失败记录保留，不自动修复或重放。

## 保存与恢复边界

```text
~/.xloom/
  config.json
  logs/
  sessions/<根会话UUID>/
    session.json
    timeline.jsonl
    agents/probe.jsonl
    agents/proof.jsonl     # 首次 verify 才创建
    blackboard/events.jsonl
    results/report.md     # 当前结果，丢失可从事件重建
    blackboard/view.md
    artifacts/<run-id>/<request-scoped-call-ref>/
      execution.json
      raw-output.txt 或 raw-read.bin
      partial.jsonl
      result.json
      result.txt
```

用户原文以稳定 ID 立即写入根时间线；Pi 在完整工具结果组之后接收输入时保存原生 user 消息及原始输入 ID，避免中途 Hint 拆开恢复后的工具配对。新输入到达后，未执行的旧工具调用会记录为未执行，先交模型审视新要求。输入保存并获得持久有效响应后才推进各角色游标；输出上限、中断和请求失败不确认游标。故障时允许保守重送背景，不能保证服务端在所有崩溃时点恰好消费一次；这不授权重放工具。

黑板事件是调查状态的唯一权威。`agent_committed` 中事实、验证、任务收尾和 Run 完成原子生效；视图落后可重建。未收尾 Run 恢复时只追加一次中断说明，并让原任务等待新 Run；已保存 Evidence 不自动升级成 Fact 或确认。没有 Proof 引用的会话恢复后继续保持懒创建。

必要文件缺失、JSONL 损坏或尾行截断会报出具体文件并停止恢复，保留原字节，不自动修日志。本机占用记录使用 Linux `/proc` 的进程身份及排他创建；同一会话不能由两个进程写入，可确认死亡的遗留记录可回收，无法确认时拒绝占用。旧 M2 元数据可从原生用户消息和事件补齐目录字段，不用模型摘要伪造黑板。

这是进程中断恢复保证，不宣称断电后所有跨文件写入无丢失，也不实现网络共享文件系统的分布式协调。外部文件或进程可能在退出后改变，恢复后的新动作必须依据当前观察判断。

## 调查能力与边界

两个角色固定拥有 `read / write / edit / bash / chrome / kali` 六工具；verify 优先交给独立 Proof，explore 交给 Probe；一次只有一个 Run，两角色共用周期上限。Proof 确认需要本次真实观察、相关有效证据、适用对照、影响解释和明确范围。`supported` 不自动成为 `impact_verified`，文字声称成功不能代替状态与合法引用。事实被纠正后，依赖的确认会失效，历史记录保留。

`bash` 的独立 `true`、空命令等明确占位操作会在启动 shell 前拒绝，返回“未执行”并保留调用记录、计入预算，不生成观察 Evidence。普通组合命令、重定向和真实命令仍由 Pi 执行。模型以最终 `xloom-update` 文本提交结果，工具调用不是提交动作。此规则不构成任意 shell 或自然语言范围的权限沙箱。

查询版本等普通事实任务可以依据真实输出完成；Goal 中明确排除的“无需验证安全影响”不再触发漏洞确认门槛。同一 Goal 中其余明确要求的安全验证仍需 Proof。

没有第三 Agent、Hook、并行调度、模型菜单、`/new`、tree/fork/branch 或向量库。任意本机 shell 的自然语言语义不能靠固定来源字段完全证明；安全结论仍需实际实验和证据解释。工具输出与模型协议保留原角色、Session、Run、call ID，切换后的迟到事件不进入另一会话。

## 构建、安装与验收

```bash
npm ci
npm run check
npm test
npm run check:pi
npm run build
npm run test:live       # 当前真实模型：聚合、部分/完整路径、两角色 Compact、恢复及报告
npm run test:backends   # 用户现有 Chrome + 配置的真实 SSH；需要先准备环境
npm run test:chrome     # 仅用户现有 Chrome；无模型或 Kali 请求
npm run test:chrome:live # 真实模型 + Chrome 自动 Probe/Proof 与恢复
npm run test:kali       # 真实密码 SSH、执行语义、取消/断线及恢复
npm run test:joint      # 真实模型 + Chrome Probe + Kali Proof 联合调查
npm run test:pty        # 脚本化模型 + 真实 HTTP SSE、本机工具和 PTY
npm pack
npm install --global --prefix "$HOME/.local" ./xloom-0.7.0.tgz
```

应用不依赖 Python；它仅用于开发阶段 PTY 验收。测试与脚本化响应均为开发文件，不加载到产品运行时。前期真实验收脚本保留为 `test:live:phase1/2/3/4`、`test:pty:phase1/2/3`。

- [第七阶段开发 prompt](docs/development-prompt-phase-7.md)
- [1–7 阶段总审计开发 prompt](docs/development-prompt-acceptance-1-7.md)
- [第七阶段实现与验收](docs/phase-7-result.md)
- [七阶段最终验收](docs/acceptance.md)
- [提示词与 token 优化](docs/token-optimization.md)
- [结果与报告](docs/results.md)
- [第六阶段开发 prompt](docs/development-prompt-phase-6.md)
- [第六阶段实现与验收](docs/phase-6-result.md)
- [模型能力与思考映射](docs/models.md)
- [第五阶段开发 prompt](docs/development-prompt-phase-5.md)
- [第五阶段实现与验收](docs/phase-5-result.md)
- [Chrome / Kali 接入](docs/backends.md)
- [第四阶段开发 prompt](docs/development-prompt-phase-4.md)
- [第一至第四阶段审计与复验](docs/acceptance-1-4.md)
- [本轮审计开发 prompt](docs/development-prompt-acceptance-1-4.md)
- [第四阶段实现与验收](docs/phase-4-result.md)
- [Pi 源码来源](docs/pi-source.md)
- [第三阶段历史](docs/phase-3-result.md)
- [第二阶段历史](docs/phase-2-result.md)
- [Pi 迁移历史](docs/pi-migration-result.md)
