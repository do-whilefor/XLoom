路径验证将本轮产物、连接和终点提交为一个整体。对应新 Fact→路径 nodeIds/边→同一候选 verification→Goal；不能只提交单点 observations 或把传递写在 continuity。当前 verify、路径 verifiesHypothesisId 和被验证候选必须相同；不改 claim/httpAssertion 自证。

下面是两边完整路径的整批形状，替代 proof-http 的单点示例，不另输出第二个协议块。仅在真实独立观察、对照及全部连接已支持影响时采用；示例不表示结果已成立。替换全部 ID、pointer 和文字：F1 代表仍有效的必要旧事实完整集合；E1～E6 是本轮对照，E7/E8/E9 是实际首产物、后继产物和终点；proof-* 是同批 ref。

```xloom-update
{
  "summary":"独立实验支持当前路径及其限定影响",
  "facts":[
    {"ref":"proof-controls","statement":"本轮策略、身份及适用资源对照","evidenceIds":["E1","E2","E3","E4","E5","E6"]},
    {"ref":"proof-start","statement":"本轮实际取得首个产物","evidenceIds":["E7"]},
    {"ref":"proof-middle","statement":"传入首产物后实际取得后继产物","evidenceIds":["E8"]},
    {"ref":"proof-end","statement":"传入后继产物后的实际终点观察","evidenceIds":["E9"]}
  ],
  "hypotheses":[{"id":"H1","status":"impact_verified","factIds":["F1","proof-controls","proof-start","proof-middle","proof-end"],"alternatives":[],"gaps":[],"verification":{
    "verdict":"supported","factIds":["proof-controls","proof-start","proof-middle","proof-end"],"controls":"实际匹配的身份及所有者/匿名对照","backendResult":"原始请求与响应的对应关系","impact":"当前断言被观察支持的具体影响","limitations":"实际适用边界",
    "observations":{"policy":"E1","actorIdentity":"E2","ownerIdentity":"E3","invalidIdentity":"E4","allowed":"E5","denied":"E6","test":"E9","transfers":[
      {"edgeId":"PE1","from":"E7","to":"E8","outputPointer":"/capability","inputPointer":"/capability"},
      {"edgeId":"PE2","from":"E8","to":"E9","outputPointer":"/capability","inputPointer":"/capability"}
    ]},
    "pathCheck":{"pathId":"P1","edgeIds":["PE1","PE2"],"complete":true,"continuity":"实际产物依次进入下一请求且到达终点"}
  }}],
  "attackPaths":[{"id":"P1","nodeIds":["proof-start","proof-middle","proof-end"],"gaps":[],"edges":[
    {"id":"PE1","from":"proof-start","to":"proof-middle","relation":"enables","condition":"首产物实际进入后继请求","evidenceIds":["E7","E8"]},
    {"id":"PE2","from":"proof-middle","to":"proof-end","relation":"enables","condition":"后继产物实际进入终点请求","evidenceIds":["E8","E9"]}
  ]}],
  "intentState":"done","next_move":"stop","reason":"本次完整路径独立验证结束",
  "goalAssessment":{"criteria":[{"criterion":1,"status":"satisfied","basisIds":["H1"],"reason":"当前有效完整路径支持该成功条件"}]}
}
```

若 Probe 尚未建路径，可用本轮实际 Fact 同批新建：路径的 id 改为 ref:"proof-route"，补 summary 与 verifiesHypothesisId:"H1"；两边 id 改为 ref:"transfer-first"/"transfer-second"，pathCheck.pathId、edgeIds 和 transfer.edgeId 同步用这些原样 ref。不能预测新 P/PE ID。已有路径则按当前 ID 更新，nodeIds 与所有边端点同步替换；只追加 Evidence 不会让旧 Probe Fact 取得本轮来源。

普通 transfer 的 outputPointer 定位 from 原始响应体的非空字符串，inputPointer 定位 to 原始 POST body 的严格同值标量，不能指向整个对象或工具结果。实际凭据、服务端 subject/object、state、时序须相容；相邻边共享同一次中间 Evidence，最后一边到达 test。edgeIds 只列本 Run 实际覆盖的 enables，每边恰有一项 transfer，不累加历史。所有者对照不能替代用户指定身份路线；身份/策略检查未提供下一请求的产物时不是 enables 边。

Goal 示例只适用于用户确有该条件且已经完整支持；沿用真实编号和依据，其他未完成条件保留 unknown。提交前在回复内核对对象闭合及关联，不调用工具整理或补语法。

前缀：status=technical_hit、verdict=supported、complete=false；仅列实际支持边，observations 仅需 policy/actorIdentity/invalidIdentity/transfers。候选和路径仍保留缺口；失败终点另存 Fact，不作为已支持连接，缺前提可 blocked。完整确认才清空实际已解决的 gaps/alternatives，不提升内部节点或重复计数。
反证：rejected、complete=false，仍覆盖完整主链并到达本次 test；前段真实产物和条件相容，只有最终端点可为匹配前提后的401/403。错误/过期能力、主体断链或缺绑定保持 gaps/blocked，不借省略 pathCheck 否定整条路线。
唯一支持的身份转换是显式 Bearer 委派：policy.delegations 含 {from,to,object}，前步响应 delegatesTo 指向新主体；实际 token 用于后步 Authorization: Bearer token。该 transfer 省略 inputPointer、增加 delegation:{identity,invalidIdentity}，引用本轮该token身份200及错误token401/403。程序核对凭据、主体、对象、状态、时序；口头转换或主体字段不足，其他转换保持缺口。
