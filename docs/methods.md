# 内置方法库

Xloom 将 Webounty 的 13 张方法卡压缩为安装包中的只读参考资源，供既有
Decide → Execute → Decide / 元认知流程使用。普通聊天不加载这些资源。

## 选择与加载

- Decide / 元认知收到 `methods.catalog` 中的 ID 和一句话适用说明，可以在
  新 Step 中输出可选 `methodIds`。允许 0–3 个不同的已知 ID；省略或空数组
  保持原有行为。模型按当前证据缺口选择，代码不做关键词匹配或默认套用。
- Execute 只接收 assignedStep 选中方法的执行与判断要点，包括反证、未知
  条件和重开依据，不加载全目录或无关方法。
- Decide / 元认知自动收到当前投影中已执行 Step 的精简复核内容，优先最近
  的 Step，再考虑较早的因果来源。单次最多 3 张；超出部分列为 `deferredIds`。
  模型可用现有 `read` 读取 `methods.directory/<id>.json` 获取详细内容。
- 方法指导与黑板分开。方法选择不创建 Fact / Evidence，不验证漏洞、不升级
  Finding，也不满足任务完成条件。变更方法名不绕过相同实验的去重。

示例是规划 JSON 中的一个 Step，省略了其他可选字段：

```json
{
  "goalId": "G0",
  "from": [],
  "description": "比较当前对象在两个已验证身份下的业务结果",
  "successSignal": "有效正常对照与被测身份的业务结果均有原始记录",
  "evidencePlan": "保留请求、响应、身份条件及必要业务回读",
  "priority": 50,
  "methodIds": ["baseline-authz"]
}
```

`methodIds` 随 Step 存在同一个 SQLite 黑板中，也显示在 `blackboard.md`。
旧任务无需迁移；原本没有选择方法的 Step 不会自动补选。历史未知 ID 会作为
`unavailableIds` 显式报告，不能构成任意文件路径；新规划中的未知 ID 会被拒绝。
已知方法资源缺失、损坏或目录版本不匹配会报错，不静默替换方法。

## 方法范围

| ID | 用途 |
| --- | --- |
| baseline-authz | 身份、对象归属和正常业务对照 |
| flow-chain | 多阶段流程、产物与最终消费端关联 |
| static-dynamic-retest | 静态与运行时关联、条件变化后的复测 |
| observer-validity | 观察器有效性、正负对照和噪声 |
| controller-reach | 过滤、路由、校验和处理器到达判断 |
| capability-consumer | 凭据签发能力与消费端之间的缺口 |
| protocol-binding | 挑战、身份、来源域及协议消费绑定 |
| patch-differential | 修复前后与部署条件的差异 |
| authorization-context | 有效权限范围与操作语义 |
| evidence-linkage | 执行因果关联、指纹和替代解释 |
| asset-attribution | 资产候选、归属、解析与版本适用性 |
| impact-assessment | 已观察影响和组合前提，沿用现有评级契约 |
| hypothesis-lifecycle | 有条件的否定、修正和重开 |

## 体积与交付

角色 system prompt 和原有输出协议未增长。新增内容放在结构化 `methods`
字段中，仍计入完整请求的上下文成本：测试约束空白规划目录在当前路径下不超过
1,900 字符，带 3 张复核卡不超过 3,300 字符，Execute 的 3 张方法内容不超过
3,800 字符。路径长度会影响前两项；这不是整个请求的 token 上限，也不是供应商
分词计费数字。通过现有 `read` 主动读取更多内容会继续消耗上下文。

资源位于安装目录 `resources/methods/`，通过模块路径定位，支持从任意工作目录
启动；不依赖原 `webounty/` 目录。npm 包包含 `dist/`、`resources/` 和许可文件。
来源路径、原卡哈希及上游引用保留在 `provenance.json`，许可见 `NOTICE.md` 和
`LICENSE.txt`。归属元数据不进入常驻提示词。每次 run 的 `input.json` 保留实际
注入内容，便于审查当时所用版本。

方法库之外已接入任务内词法 RAG 和本地整理／审计，见 [本地检索与审计](retrieval.md)。
仍未接入 Webounty 的会话引擎、CVSS 计算器、独立能力图、额外 Agent、执行工具
或 hook。测试验证选择、传递、存储及流程契约；未测量真实漏洞
发现率或模型自主选择方法的质量。
