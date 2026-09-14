# 原生观察比较与复核

## 对照与最小适配

对照来源是仓库旁的 `webounty/scripts/compare_observations.py`、
`webounty/tests/test_comparison.py` 和 `webounty/references/observation-comparison.md`。
Webounty 比较器只生成两个封存观察的只读差异，不自动判断矛盾，也不调度复核。
Xloom 复用了该差异语义，并在自己的数据模型与既有外层循环中补上复核适配。

| Webounty 概念 | Xloom 对应 | 适配边界 |
|---|---|---|
| 封存观察正文、关联原件 | Evidence 归档 | 从已登记 Evidence ID 读取完整 JSON；不解释外部路径或 `content` 包装 |
| 观察声明、实验条件 | Attempt | 原有六项条件及 outcome/observation；不增加 Observation 表 |
| 事实、更正 | Fact / supersedes | 保留原事实及更正链；从已有来源关系传播待复核信息 |
| 漏洞判断 | Finding | 不由差异自动升级、关闭或评分；旧复核受影响时登记 `observationReview` |
| Wiki 判断及来源 | WikiBlock.sources / basis | 保留作者原文、当前来源、更正与冲突候选；与归档证据分开 |
| 比较器调用 | 原有 read 的 `xloom://compare` | TypeScript + Node；没有 Webounty 会话引擎、Python、新 Agent 或 hook |

核心实现位于 `src/observations/compare.ts`（纯差异）、`read.ts`（归档适配）与
`changes.ts`（公开记录变化及复核适配）。运行接口见
[观察使用说明](../resources/observations.md)。Decide、元认知与 Execute 共用现有 read。

## 差异与复核语义

比较输出分别列出身份、条件、请求、响应状态、正文摘要、显式业务字段和其他变化。
缺失与 null、布尔与数字、字符串与容器严格区分；对象按键排序比较，数组按位置比较，
变化定位采用 JSON Pointer。整段正文不复制；明确选择的字符串叶字段不截断。
正文哈希表示保存的 UTF-8 字符串或规范化 JSON，不是网络原始报文的哈希。

与 Python 的区别明确保留：原生 JSON 不区分 `1` 与 `1.0`，规范化数字采用
ECMAScript 表示；不保证跨语言规范化哈希逐字节相等。不安全整数及非有限数拒绝比较，
避免大对象 ID 因舍入变成“相同”；此类原件仍可直接读取。比较归档沿用 10 MiB 上限，
字段选择最多 64 项。哈希、大小、归档路径或 UTF-8 校验失败时返回 unavailable，
不对不可信内容产生差异。未知 ID、非法路径选择和非对象 JSON 是输入错误。

新增 Attempt、观察文字变化、既有 Evidence 关联/内容地址变化、来源删除和事实更正
都可识别。`supports` 与 `refutes` 只有在 hypothesis、scope、identity、stateVersion、
baseline、changedVariable 对齐时才形成 `observation_conflict` 候选；不同条件不推断
矛盾。未结构化的自然语言事实不做语义矛盾猜测。文件时间戳、描述标签或引用顺序
不算新实验。相同条件/结果但文字不同的 Attempt 分别保留；重复 outcome 不增加进展。
文字相同的重复 Attempt 可增加 Evidence 来源，触发来源复核。

新增结构化观察及来源变化触发 `observation_change`，复用 Decide 的新鲜元认知上下文。
已有 blocked、technical_hit、fact_revision 优先级继续生效；它们同样进入元认知。
旧格式新增 Fact 仍走正常 Execute → Decide 复核。checkpoint 的变化在最后返回时
一起比较，yield 不绕过观察复核；中断已提交内容保留，恢复时先进入 fresh Decide。
不自动重放旧 Step、不把比较结果当 Evidence，不自动认定漏洞、反证有效或修复。

已复核 Finding 的直接或因果来源受影响时，`observationReview` 在同一 Store 事务中
持久化。原状态/评级显示为历史声明，新候选不自动附为 Finding 证据。报告、黑板及
Wiki 展示待复核；旧的 closed Finding 只要仍待复核，就不会被规划上下文的历史尾部限制隐藏。
最终完成禁止沿用此旧复核。现有 `reviews` 在校验全部关联归档后
清除该标记。读取/检索/重写 Wiki/导航回执不清除它。同条件相反 Attempt 仍是历史
观察，Wiki 保留其冲突提示；Finding 的最终解释由 Decide 负责。

快照比较不扫描磁盘：磁盘篡改在原件读取、比较、审计和 Store 校验时发现。
`ready` 只说明两份选中原件通过本次校验，`recorded` 也不等于业务结论正确。

## Wiki 与 RAG

Fact、Attempt、Finding 来源包保留更正、冲突候选和来源闭包。Wiki 即使重新提交文字，
也不能抹去底层未消除的冲突；但新版 Fact 的历史来源含旧 Fact，不会仅因这条历史
记录被替代而永久阻止重新提交新版解释。

一次同步读取共享记录表、反向来源索引与公开记录投影，完成立即销毁。不会仅凭
对象身份或 revision 长期复用；同一 BoardSnapshot 原地修改后仍重新检查当前内容。
SQLite 元数据缓存一次批量读取，继续只缓存分词计数，正文和条件始终取当前黑板。
完整查询词命中排在单词局部命中之前，显式 ID 始终优先；仍保留部分匹配及遗漏计数。
预算不足时整体推迟来源包，不能只交付结论而丢弃反证、条件或原件定位。

比较接口的详细约定放在按需读取说明中。没有给角色 system prompt 增添比较手册；
原生 read 的说明增加比较入口，同时压缩重复检索说明。

## 验证与性能

```powershell
npm run check
npx tsx scripts/benchmark-observation-retrieval.ts --baseline c1260d5 --size 1000
```

Windows 并行启动大量测试子进程时可能碰到既有的 15 秒超时；可使用
`npm run typecheck`、`npm test -- --maxWorkers=1`、`npm run build` 做同一套完整验证，
减少进程启动争用，不更改断言或单项超时。

单元测试覆盖 Webounty 差异语义、非法输入、原件损坏及任务隔离；集成测试覆盖
Store 事务、不同观察保留、重复进展抑制、重启、完成门控、checkpoint/yield 调度、
Wiki 冲突传播、来源预算和缓存失效。检索回归另覆盖完整词匹配、中文与标识符、
原否定条件、明确来源和缺失资料，完整套件继续检验 Pi/runtime/CLI/UI。

2026-09-14，本机 Windows / Node v24.18.0，1,000 组事实、步骤和原件元数据，
50 个 Wiki 块，共 3,051 条检索记录。基线为 `c1260d5109c6cded868176c04467faef36265fdf`。
每项热测 5 次取中位数，冷测一次：

| 检查 | 基线 | 当前 | 比值 |
|---|---:|---:|---:|
| 冷索引 | 449.81 ms | 301.53 ms | 1.49× |
| 热索引 | 179.93 ms | 66.98 ms | 2.69× |
| 热查询与完整来源包 | 179.09 ms | 69.44 ms | 2.58× |

两版均通过当前索引与全量重建相等、目标记录命中、否定条件保留检查；热索引新增
分词字节为 0。该实验只测合成元数据检索，不包含模型延迟、原件哈希时间或真实
任务答案准确率。基准不设脆弱的毫秒门限，机器负载会影响数值。脚本导出指定 Git
提交到临时目录进行对照，不切换工作树，不复制用户未提交资料。
