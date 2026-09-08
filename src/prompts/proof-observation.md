当前 verify 的候选没有 httpAssertion 和关联 AttackPath，按普通独立观察收尾。即使用 HTTP 取得公开共享/回显材料，也不能套用 proof-http 的影响确认示例：hypotheses 补丁中整个 verification 属性省略。verification:{}、null 或缺字段对象都非法；不为凑合同新建 httpAssertion，不把普通结论升级为 impact_verified/rejected。实际差异与边界保存为新 Fact，候选保持 lead/technical_hit；独立观察已完成可将当前 Intent 标 done。

只执行 currentIntent 所需的观察、前提和对照。用户 Scope 内的另一独立 Goal 条件不自动成为本次 verify；尚未观察的其他条件保留 unknown，不顺手读取、批量代办或声称全目标完成。当前核对后，先判断哪个未完成条件阻断用户主目标，再比较合法后继。既有 open 任务实际补齐这个关键缺口或取得其必要前提时，才推荐其 ID；关键缺口已可观察但尚无对应任务时，本批创建具体 open explore 并推荐其 ref，由 Probe 执行。队列里仍有普通 verify 不构成推迟新 explore 的理由；选择普通复核须在 reason 说明它为何是主目标关键缺口的必要前提。确需另一候选独立复核时创建绑定该候选的 verify。不要因为工具可用就在当前 Proof 跨任务完成它们。

以下是三个互斥的完整形状，每次仅选符合当前事实的一个。H1/F1/E1/I3 都是需替换的占位编号：从 Capsule、索引或本轮实际工具结果逐字取真实 ID；H1 必须是 currentIntent 的目标候选，E1 必须来自本 Run 对当前任务的实际观察，F1 表示全部仍有效的必要旧 Fact，proof-observed 是同批 ref。条件编号及其状态必须来自用户真实条件；示例内容不是实验答案，不添加不存在的条件。再次列出此前已满足的条件时，保留支持该条件的真实 Fact ID；不能用本次另一文件的 Fact/ref 替换旧依据。

当前普通目标已由本轮观察完整覆盖、没有其他未完条件或合法后继时：

```xloom-update
{
  "summary":"本轮普通独立核对已完成，结论限实际观察",
  "facts":[{"ref":"proof-observed","statement":"实际观察、对照差异及适用边界","evidenceIds":["E1"]}],
  "hypotheses":[{"id":"H1","status":"lead","factIds":["F1","proof-observed"],"gaps":[]}],
  "intentState":"done","next_move":"stop","reason":"该普通任务已有实际观察支持",
  "goalAssessment":{"criteria":[{"criterion":1,"status":"satisfied","basisIds":["proof-observed"],"reason":"实际观察覆盖用户的普通核对条件"}]}
}
```

当前局部核对完成，用户主目标仍缺关键观察，且 I3 能实际补齐该缺口或其必要前提时：

```xloom-update
{
  "summary":"当前局部核对完成，另一条件尚待后继观察",
  "facts":[{"ref":"proof-observed","statement":"仅当前 verify 的实际观察和边界","evidenceIds":["E1"]}],
  "hypotheses":[{"id":"H1","status":"lead","factIds":["F1","proof-observed"],"gaps":[]}],
  "intentState":"done","next_move":"continue","nextIntentId":"I3","reason":"I3 对应尚缺的关键观察，由程序派发后执行",
  "goalAssessment":{"criteria":[
    {"criterion":1,"status":"satisfied","basisIds":["proof-observed"],"reason":"仅该普通条件有本轮观察支持"},
    {"criterion":2,"status":"unknown","basisIds":[],"reason":"另一独立条件尚未观察，交给后继"}
  ]}
}
```

当前局部核对完成，主目标关键缺口已具备观察前提、尚无对应任务，其他普通复核也不是其必要前提时。此例假定真实条件1是缺失观察、条件2是当前核对；编号、目标位置、工具和前提须按实际 Goal/Scope 替换：

```xloom-update
{
  "summary":"当前普通独立核对完成，新增主目标所缺的实际观察任务",
  "facts":[{"ref":"proof-observed","statement":"仅当前 verify 的实际观察和适用边界","evidenceIds":["E1"]}],
  "hypotheses":[{"id":"H1","status":"lead","factIds":["F1","proof-observed"],"gaps":[]}],
  "intents":[{"ref":"observe-main-gap","kind":"explore","objective":"用 Scope 允许的工具读取 Goal 指定但尚未观察的目标，记录缺失条件所需的实际值和范围","basisIds":[],"prerequisites":["目标在当前 Scope 内且允许工具可读取"],"state":"open"}],
  "intentState":"done","next_move":"widen","nextIntentId":"observe-main-gap","reason":"主目标关键缺口已有观察前提但无对应任务；其他普通复核不能补齐该缺口，先由 Probe 执行本批新 explore",
  "goalAssessment":{"criteria":[
    {"criterion":1,"status":"unknown","basisIds":[],"reason":"新建任务仅是计划，实际观察仍待 Probe 完成"},
    {"criterion":2,"status":"satisfied","basisIds":["proof-observed"],"reason":"仅当前独立核对由本 Run 的实际观察覆盖"}
  ]}
}
```

只清空实际已经解决的候选 gaps；仍缺账号、状态或适用对照时保留真实 gaps，当前任务 blocked。普通 Fact 不能满足安全影响条件；这种条件保持 unknown 等待有适用合同的独立确认。没有有价值的合法后继就 stop 并保留缺口，不为使用示例而造任务。以上三个示例均没有 verification 属性；输出前在本次回复内检查省略、闭合和引用，不调用工具整理，不在非法提交后自动重试。
