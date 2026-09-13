# Finding 证据视图

本阶段借鉴 Webounty 的问题级来源检查与紧凑检索视图，将导航直接接入现有
`ContextProjector`。没有运行 Webounty 的 Python 引擎，也没有引入另一套知识库、
Agent、工具或 hook。普通聊天不加载该视图。

研究提示中的 `blackboard.findingContext` 只围绕当前角色已经选中的 Finding
生成；没有 Finding 时整个字段省略。已有 `findings[].factIds/evidenceIds/pocEvidenceId`
仍表示正式关联。新增内容只帮助定位与复核，不替换这些关联。

## 字段与边界

| 字段 | 来源及含义 |
| --- | --- |
| items[].findingId | 当前视图对应的 Finding |
| related | 共享已关联 Fact / Evidence 的其他 Finding、来源 Step 的其他产物，以及明确引用已关联 Fact 的 Step 产物 |
| related[].via | 建立候选关系的一条明确引用；不是语义匹配或证明 |
| candidateFactIds / candidateEvidenceIds | 尚未关联到当前 Finding 的候选材料 |
| revisions | 沿 `Fact.supersedes` 双向追踪的替代关系，保留历史与当前记录 |
| conditions | 来源或引用 Step 的组合范围、环境版本、未验证前提和声明的反证 Fact |
| attempts | hypothesis 与 Finding key 精确相同，或证据与已关联证据相交的尝试入口；两者都需要核对适用条件 |
| issues | 缺失的 Fact / Evidence / Step 记录，或当前 PoC 未关联到 Finding |
| unrecorded | 没有记录 PoC 字段、结构化尝试或组合条件；不代表现实中没有证据、对照或前提 |
| omitted | 可选导航被省略的数量，不能解释成全部材料已检查 |

共享 Finding 只展开一层，不继续沿其邻居递归扩散；标题、目标描述、方法 ID
相同不会自动产生关系。来源 Step 和引用 Step 的其他产物也仅是候选，尤其不能
假设一个大 Step 内所有观察都支持同一条 Finding。

`revisions` 不自动判定反证；`declaredCounterEvidence` 是 Step 声明的反证入口，
不是独立验证结果。某次尝试即使记录为 refutes，也只适用于它自己的身份、范围、
状态和对照。视图不对自然语言 `Finding.next` 做缺口抽取，不推断尚未记录的条件。

## 原件、体积与补查

优先复用 `blackboard.facts/factIndex/evidence/attempts`。`findingContext` 下同名
索引只补充当前角色尚未获得的记录，并在多个 Finding 之间按 ID 去重。补充证据
只有 ID、绝对路径、已登记的 SHA-256 和大小，不展开原文；现有 `read` 可读取原件。
投影不读取文件或重新校验哈希，原件可能在登记后损坏或丢失，不能把定位视图当成
文件完整性验证或漏洞证明。

每条 Finding 最多展示 4 组候选关系，每组各展示 6 个候选 Fact / Evidence；
最多展示 4 组组合条件和 4 条相关尝试。相关 Finding 优先展示较后登记的记录，
随后是引用 Step、来源 Step。超出数量显式报告；必要的事实替代关系不按这个数量
截断。条件原文不裁成半句，故这些数量限制不是整个请求的硬字符或 token 上限。

现有 `blackboard.md` 增加 `Evidence navigation index`，按 JSONL 保存全部
Finding 关联、Fact 来源与替代关系、Step 输入与组合条件。它与已有的 Facts、
Conditional attempts、Evidence 部分共同提供补查入口，仍是 SQLite 的可重建投影。
不增加第二份权威状态，也不向 Agent 提供其他 run 的聊天记录。

每次 fresh Decide / Execute / 元认知调用都从当前黑板重建视图，没有跨 Agent
的“已读”游标。新增补充内容计入上下文；角色系统提示词和输出协议保持不变。

候选材料只有经过现有 Execute 提交与 Store 校验、关联到原 Finding key 后，
才能成为该 Finding 的正式证据。读取候选、生成视图或发现替代关系本身，不改变
Finding 状态、PoC、事实、用量进度或 Goal 完成状态。

测试覆盖引用关系、角色隔离、替代环、不同条件下的尝试、省略提示、原件定位、
SQLite 重开，以及真实 Pi read 工具读取候选的流程。它们不证明真实模型的引用
错误率、检索质量或 token 消耗一定下降。
