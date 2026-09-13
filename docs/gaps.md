# 缺口 → 资料关联 → 复核 → 选步

缺口是原有 Step 的 `gaps` 注记，随原 Step 一起保存在任务目录的
`blackboard.sqlite`。没有独立的问题数据库，也不会重置旧 Step 的执行状态。

1. Execute 记录缺什么、为什么受阻、什么资料能改变判断、需要的类型和条件。
   同一 Step 内的 `gap-*` ID 固定含义；需求变化使用新 ID。
2. 新 Capability 按显式类型或 aliases 关联。来源变化、不可用、身份/环境冲突
   和未知条件会保留在候选中。没有类型的文档线索通过 `gapLinks` 显式关联
   Fact/Evidence/Capability/Chain；Wiki 应引用底层来源。
3. 新资料或来源修订使旧缺口重新进入 `gaps` 复核上下文。调度器可触发
   `gap_review`；blocked、technical_hit、fact_revision 等更强触发仍优先，
   这些调用也收到同一缺口上下文。活跃 Goal 的待复核缺口优先于历史项。
4. Decide 设置有界新 Step 的 `revisits` 和 priority，或记录 defer/resolve
   及理由。resolve 必须引用未被替代且有可校验原件的 Facts；事实是否足以
   满足需求仍由 Decide 判断。类型匹配不会代替这个判断。

Revisit 的新 Facts 自动关联原缺口；步骤结束，即使没有新进展，也重新请求
复核。resolve 不改变原 Step、Finding 等级或 Goal。已复核且资料不变的项
保持安静，来源变化会再次提示复核。系统不会自动重放旧请求。

所有研究角色收到缺口上下文；Execute 优先看到所分配 revisit 的缺口。
完整条目按 12,000 字符预算投影，放不下的条目列出 Step/gap ID，不能当作不存在。
相关旧 consumer 优先进入能力组合发现，其余发现仍有搜索预算和省略说明。
完整内容在黑板、原 Step Wiki 页面，以及本地只读命令中：

```powershell
node dist/wiki/local.js gaps --task '<绝对任务目录>' --workspace '<绝对项目目录>'
```

旧任务不会被自动猜测或迁移成结构化缺口。已有 `combination.missing`、blocked
结果和 Finding.next 仍可供 Decide 阅读；后续有界 Execute 可以把所复核问题
记录在其当前 Step 上。字段例子见 `resources/knowledge/authoring.md`。

测试使用合成数据验证持久化、事务回滚、资料关联、状态/条件限制、调度及真实
Pi 工具循环中的交接。它们不代表已测量真实模型识别缺口或选择最佳步骤的能力。
