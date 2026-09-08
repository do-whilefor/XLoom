HTTP 完整单点及完整路径都需要既有 httpAssertion 和以下 observations：
- policy：无凭据、无 body GET conditionsPath，200 且同 object/owner、policy=owner-only。角色/后端审计头不是凭据。
- actorIdentity / ownerIdentity / invalidIdentity：同 identityPath 的无 body GET、相同非凭据头；前两项使用实际不同凭据200，identity分别匹配actor/owner；错误/无凭据对照401/403。不能把请求头或任意 actor 回显自证身份。
- allowed / denied / test：所有者允许200、匿名拒绝401/403、测试身份的实际资源结果。三者同资源路径、同方法、完全相同实际 body 和非凭据头。若 test 使用新 capability，对照也用同一 body，不能以 {} 或错误参数制造拒绝；按实际应用语义安排顺序，前提已失效时保持未知。
- 确认时 test 为200且 object/owner/valuePointer 的非空私有字符串与所有者基线相同，实际值不是请求体/头回显；存在 state 时与策略前提相容。对照匹配且实际结果反驳既有正向断言时才可 rejected，HTTP401/403本身不是传输失败。

上述值全是本次 Proof 原生 xloom-http Evidence ID。observations 中每个 Evidence（包括所有者 allowed 基线）都须由 verification.factIds 所列 Fact 的 evidenceIds 覆盖，这些 Fact 也须全部列入当前 Hypothesis.factIds；仅保存 Fact 或在文字中提及不建立引用。一个观察符合多个用途可复用，不按请求数量判断齐全。local 合同使用 bash 原生请求；kali 合同使用 Kali 原生请求且同一真实 SSH host/port/username。环境和 localhost 不可混拼，SSH账号不认证 Web身份。程序核对完整原文并产生 match/mismatch/unavailable；不支持的合同、失败/截断材料保持未确认。缺哪个适用观察才针对性补齐，足够后直接最终提交。

完整单点提交形状如下，仅在独立观察已支持既有正向断言且 gaps/alternatives 已解决时适用。H1/F1/E1…E7 替换为真实 ID，F1 代表仍有效的必要旧事实完整集合；proof-observed 是本批 ref。observations 只填 Evidence ID，说明文字放 controls/backendResult/impact；路径再按 proof-path 扩展同一 verification，不能另加顶层 verification。

```xloom-update
{
  "summary":"独立对照支持当前候选的单点影响",
  "facts":[{"ref":"proof-observed","statement":"本次身份、策略和资源对照及适用边界","evidenceIds":["E1","E2","E3","E4","E5","E6","E7"]}],
  "hypotheses":[{"id":"H1","status":"impact_verified","factIds":["F1","proof-observed"],"alternatives":[],"gaps":[],"verification":{"verdict":"supported","factIds":["proof-observed"],"controls":"实际身份和所有者/匿名资源对照","backendResult":"实际请求和私有值如何对应既有合同","impact":"观察支持的具体安全影响","limitations":"实际适用范围","observations":{"policy":"E1","actorIdentity":"E2","ownerIdentity":"E3","invalidIdentity":"E4","allowed":"E5","denied":"E6","test":"E7"}}}],
  "intentState":"done",
  "next_move":"stop",
  "reason":"本次单点验证已完成"
}
```
