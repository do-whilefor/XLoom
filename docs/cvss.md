# CVSS 原生接入

Xloom 直接导入 `resources/cvss/cvss31-calculator.cjs`。它是
`webounty/scripts/cvss31-calculator.js` 的同内容分发副本，使用 `.cjs` 扩展名
适配 Xloom 的 ESM 环境，保留原 MIT 许可证和归属说明。

支持 **CVSS 3.1 Base**，包含 Scope Changed 与 Roundup 修正。版本 3.0/4.0、
Temporal/Environmental 指标、缺失或重复指标都会报错。

Execute 在 Finding 的 `cvss` 中提交向量及 AV/AC/PR/UI/S/C/I/A 逐项理由：
每项引用该 Finding 已关联的 Facts，或显式声明 assumption。Controller 在
进程内计算分数和 severity，连同原件依据在原 SQLite 事务中提交。模型提交
baseScore 等计算字段会被拒绝。评分没有单独的状态数据库。

Decide 通过 `cvssReviews` 独立审阅或调整向量与理由，Controller 再次计算并
校验原件。评分复核不会改变 Finding 的 lead/technical_hit/impact_verified
状态、P1/P2/P3、Step 优先级或 Goal。有未验证指标时，已复核的评分仍显示
conditional_metrics。Finding 更新或来源修订会提示再次审阅。

完整评分和理由可在报告、Finding Wiki 页、Agent 上下文中查看；`/board`
显示分数、向量与适用性提示。支持独立本地计算：

```powershell
node resources/cvss/cvss31-calculator.cjs --json 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'
```

示例结果为 7.5 HIGH，仅演示给定向量的算术。省略 `--json` 可查看中间计算。
Agent 的 `scoring` 上下文提供绝对脚本路径，沿用现有 PowerShell 工具即可运行；
Decide 仍保持只读工具集，由 Controller 计算提交的评分。

本轮接入状态：CVSS 计算器已直接复用；会话、Finding、Wiki/RAG、能力链和
缺口流程使用 Xloom 原生模块。Webounty 原 Python 会话/发现脚本没有直接调用。
后续已接入[观察对照与复核](observation-comparison.md)；没有运行示例中的目标请求。本轮只为单个 Finding
评分，不相加或平均能力链成员的分数。

原代码的固定 FIRST 示例、舍入和非法输入用例已迁入 Vitest；另有事务、
重启恢复、证据关联、独立评分复核和真实 Pi 工具循环的离线集成验证。测试
验证公式和软件协议，不替代对真实漏洞影响及指标理由的专业判断。

字段示例见 `resources/cvss/authoring.md`。
