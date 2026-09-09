AttackPath 只用于必要的前置状态连接，独立问题无需路径。用户要求连续路径时，实际发出链路请求还不够：Probe 将各步观察分别保存为 Fact，在同一最终 Update 的 attackPaths 建立候选路径，并创建指向同一候选的中性 verify；不能只在 claim/summary 描述路线后省略路径。
新建 {ref, summary, nodeIds, edges, gaps, verifiesHypothesisId}，更新 {id, 修改字段}。nodeIds 为至少两个不重复的 Fact/Hypothesis ID/ref，按首个实际产物 → 后继产物 → 终点排列；不能把整条路线的待验证 Hypothesis 当已成立起点，接口条件说明也不等于已到终点。未观察终点可用待验证 Hypothesis 节点并保留缺口。
新建路径的上述七个字段全部必填；断链、终点失败和未确认路径也必须填写 verifiesHypothesisId，不能因没有成功确认而省略验证目标。没有实际连接依据时保留空 edges 和明确 gaps；例如下列完整候选对象（F1/H1 替换为实际观察 Fact 与路线候选）：
```json
{"ref":"candidate-route","summary":"实际起点与尚待核对的终点","nodeIds":["F1","H1"],"edges":[],"gaps":["尚无支持连接的实际传递"],"verifiesHypothesisId":"H1"}
```
测试路线从用户指定身份起步；所有者允许对照不能替代该身份的能力路线。impact_verified 只表示已证实存在的安全影响，不用于“请求被拒绝”“未发现漏洞”或一般事实核对完成。
verifiesHypothesisId 指向描述路线及终点影响的候选；关键节点 Fact 和每份连接 Evidence 对应的 Fact 均须列入该候选 factIds，支持纠正传播。路径验证（含前缀）的 verify.verifiesHypothesisId 必须与路径目标逐字相同，不能指向另一个单节点候选。
身份/策略检查是前提，若未产出实际用于下一请求的值，不将该检查到 mint 画成 enables。能力路径从取得首份实际产物的 Fact 起步，经过真实传递到终点。
边格式 {ref, from, to, relation, condition, evidenceIds}；既有边用 id 替代 ref，更新 edges 提供完整当前集合。每条边的 from/to 都必须是当前 nodeIds 中不同的节点；缩短或替换 nodeIds 时同步删除越界边或更新端点，related_to 等背景边也不能指向已移出的节点。relation 仅 supports/contradicts/related_to/enables，前三者不是可达连接；enables 须具体说明前一步如何提供下一步身份、对象、能力或状态。节点各自成功、不同身份截图或相关性不证明连续。一个 Proof Run 可检查多边，分支用多条小路径，缺口不要求自动逐边调用。
revision、边 confirmed、verification.runId、pathCheck.pathRevision 由程序生成，模型不得填写。路径内容变化使旧覆盖失效，原样展示不产生新版本。gaps 保留阻塞断言的关键缺口，limitations 只保留已验证范围，不能借此隐藏未完成条件。
