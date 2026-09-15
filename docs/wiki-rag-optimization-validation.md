# Wiki 与 RAG 优化验证

验证日期：2026-09-15。环境：Windows、Node.js 24.18.0。

本轮完成持久缓存与恢复、增量计算、模型辅助语义召回／重排，以及 Wiki 与 RAG
来源一致性。沿用现有 read 和 Pi 模型调用机制。生产实现对应提交：
`aff94d1`、`7f76d3f`、`f22a717`、`576891a`。

## 实现与恢复边界

| 方向 | 实现 | 验证重点 |
| --- | --- | --- |
| 持久化与失效 | 任务缓存 v2、WAL、事务写入；内容签名与缓存文件指纹失效；v1 自动升级 | 重启复用、外部修改、损坏／异任务缓存绕过、写竞争和回滚 |
| 减少重复计算 | 复用冻结检索索引和未变化 Wiki 页的渲染结果；原件扫描完成后短事务写词项 | 原地快照变化失效、完整索引一致、热读取不占写锁、生成文件被手改后修复 |
| 语义召回和重排 | 按完整 Wiki 判断及来源生成中英文检索问题；扩展各查询组并评分完整候选来源包 | 保留否定、身份、版本、多前提及精确 ID；非法响应和模型失败明确降级 |
| Wiki／RAG 一致性 | SQLite 为权威来源；building／ready 投影状态绑定修订及 manifest；派生项按来源签名失效 | 中断后重建、过期投影拒读、清理失败保留旧 manifest、来源变化放弃旧排名 |
| 跨轮资料变化 | removed／inactive 回执保存在正式 SQLite | 移除只提示一次，重新出现再次提示；不把通知当复核或缺口解决 |

索引内存缓存最多 4 个任务、估算序列化大小合计 32 MiB，单索引最多 16 MiB；
页面缓存最多 4 个任务、序列化正文合计 32 MiB。实际堆内存会大于序列化大小。
查询改写／评分缓存最多 512 项；逐块语义提示只重算新增或变化项。
原件正文和完整性结论不存入这些缓存，原件读取仍核验完整哈希。

Wiki 发布使用单文件临时写入、刷新和替换，并非整个目录的一次原子切换。
普通 Wiki 文件 read 拒绝未完成或过期投影；任务下次打开／更新尝试恢复，原生查询
继续读取 SQLite。只清理旧 manifest 登记、路径合法且内容哈希仍匹配的过期生成页。
故障注入测试验证了清理失败后仍保留重试依据。

## 自动化验收

- `npm run check`：类型检查、构建通过，**71 个测试文件、1741 个测试全部通过**；
  最终测试运行约 261 秒。
- 对新增／修改的验证脚本和相关新增测试另做严格 TypeScript 检查，因为项目
  `tsconfig.json` 的编译范围只包含 `src`。
- 离线固定合成集：development／acceptance 各 10 个查询，两组 Recall@5 均为 1；
  无匹配查询、来源与条件保留、原文定位及黑板不变检查全部通过。最终报告的生产
  代码修订为 `576891a`。

测试稳定性修正保留了业务断言：27 步生命周期案例独立允许 30 秒，以覆盖新增的
投影刷新；两个并行失败 read 的事件按 ID 比较，避免要求不受保证的完成顺序。
工具失败数量、写入次数及执行不重放断言保持不变。

离线集合很小且固定，Recall@5 = 1 仅说明这些查询的预期相关记录进入前五，
不能解释为真实任务准确率 100%。

## 检索性能

基线：`6401baca83ed3e560afd180b369ca9fbbbe68ce4`。每组 30 次热查询；时间单位为毫秒。

| 索引记录数 | 查询 P50：基线 → 本轮 | 查询 P95：基线 → 本轮 | 冷索引：基线 → 本轮 |
| --- | --- | --- | --- |
| 3,051 | 84.58 → 9.13 | 117.76 → 17.65 | 340.49 → 352.27 |
| 9,151 | 246.81 → 25.71 | 349.36 → 43.58 | 827.75 → 794.60 |

热词法查询中位数分别提速约 9.26 倍和 9.60 倍。完整索引一致性、精确查询命中和
否定条件保留均通过。该测量仅覆盖合成元数据检索，不包含模型延迟、原件哈希或
整轮回答时间。冷索引每组只有一个样本，不据此宣称稳定提速。

原始样本保存在本地 `.xloom/checks/rag-20260915/performance-1000.json` 和
`performance-3000.json`。

## 项目配置模型回放

通过 `loadConfig(projectConfigPath(process.cwd()))` 加载当前项目实际配置，实际调用
`opencode-go / deepseek-flash`。研究角色配置为 `thinking=max`；结构化检索辅助调用
使用同一模型和独立 `low` 推理强度，由 Pi 映射，单次 120 秒看门狗。
主研究请求继续使用项目配置。这是延迟处理，不是按费用选择其他模型。

回放先解析现有认证，再隔离临时任务目录与 `XLOOM_HOME`。材料均为合成本地归档，
未修改现有研究任务。输入只提供问题、来源及接口操作要求，没有提供期望答案／命中标签。

| 最终回放 | 实际模型请求数 | 输入／输出 token | 结果 |
| --- | --- | --- | --- |
| `live-semantic-3.json` | 13 | 42,939／27,045 | 三类问题、更正失效、缓存复用和答案边界检查通过 |
| `live-wiki-1.json` | 5 | 74,004／4,936 | 必要解释写入及更正后的元数据维护通过，来源基线保留 |
| `live-grouped-4.json` | 4 | 87,714／5,320 | 多前提查询、两个原件接口精读、版本披露和复查规划通过，工具错误为零 |

使用量来自实际返回值，输入计入服务商报告的缓存 token。报告中的 `cost=0` 可能表示
SDK 未知价格，不能据此认定调用免费。语义回放的 13 次请求包含检索辅助和答案验证；
热缓存读取没有追加模型调用。

### 语义检索延迟

| 查询 | 首次语义检索 | 持久缓存复用 |
| --- | --- | --- |
| 已有受理编号是否代表跨账户取回成功 | 63.82 秒 | 85.15 毫秒 |
| 观察能否沿用到其他身份和版本 | 18.50 秒 | 61.09 毫秒 |
| 资料中不存在的客服电话 | 10.79 秒 | 94.48 毫秒 |

首个查询包含首次 Wiki 语义提示生成，后两个查询复用这些提示；各行为一次观测，
不是分位数。暖读前清除进程内检索快照，核对派生结果从持久缓存复用；进程重启另由
自动化测试覆盖。上述时间是检索入口耗时，不含后续答案生成。

更正回放验证新来源使相关提示与排名失效，交付 `v2` 更正及 `source_changed`，
未变化项仍能复用，Wiki 审计一致。模型答案保留“跨账户下载未验证”的边界。

### 失败记录与修正

本地保留全部报告，未只保留成功结果：

- `live-semantic-1.json`：漏召回受理流程解释；验证布尔字段存在歧义，且数组元素类型
  说明不足。加入逐判断持久中英检索提示，并明确验证字段含义和类型。
- `live-semantic-2.json`：检查通过，但继承高推理强度时一次重排耗时约 428.5 秒，
  首次检索约 457.6 秒。因此辅助调用改为 `low` 并增加单次看门狗；最终第 3 次通过。
- `live-grouped-1.json`：重复缺口复核项导致一次提交拒绝，后续规划缺少 `revisits`。
  回放明确既有提交协议要求。
- `live-grouped-2.json`：规划正确，但模型使用普通文件 read，跳过原生原件精读接口。
  回放明确必须实际调用两个 `xloom://original` 路径，以验收完整性校验接口。
- `live-grouped-3.json`：供应商返回 `Anthropic stream ended without a stop reason`，
  本次失败被保留；未改变运行时来隐藏该错误。第 4 次通过全部断言。

这些是经操作要求引导的固定合成回放，期间针对失败改进了实现及验证说明，因此
不属于独立留出集。早期报告的 scope 曾写 `held-out`，应以上述实际过程为准，脚本
已纠正表述。多前提回放证明接口与约束可完成，不证明模型在无指引时每次都能自主
选对读取路径。语义答案使用完整 Wiki／来源包，也不等于模型精读了所有原件全文。

## 复现命令

在项目根目录执行，确保输出目录存在：

```powershell
New-Item -ItemType Directory -Force .xloom/checks/rag-rerun
npm run check
npx tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck scripts/validate-semantic-retrieval.ts scripts/benchmark-observation-retrieval.ts scripts/validate-grouped-retrieval.ts tests/wiki-semantic.test.ts tests/runtime-retrieval-model.test.ts tests/wiki-recovery.test.ts
node --import tsx scripts/evaluate-wiki-retrieval.ts --output .xloom/checks/rag-rerun/offline-quality.json
node --import tsx scripts/benchmark-observation-retrieval.ts --baseline 6401bac --size 1000 --samples 30 --output .xloom/checks/rag-rerun/performance-1000.json
node --import tsx scripts/benchmark-observation-retrieval.ts --baseline 6401bac --size 3000 --samples 30 --output .xloom/checks/rag-rerun/performance-3000.json
node --import tsx scripts/validate-semantic-retrieval.ts --live --output .xloom/checks/rag-rerun/live-semantic.json
node --import tsx scripts/validate-wiki-structure.ts --live --output .xloom/checks/rag-rerun/live-wiki.json
node --import tsx scripts/validate-grouped-retrieval.ts --live --output .xloom/checks/rag-rerun/live-grouped.json
```

`--live` 会实际调用当时项目配置模型。原始报告位于本地
`.xloom/checks/rag-20260915/`，不随 Git 提交；本文件保留验收结果，脚本保留复现方法。

运行时可从 `rag.search.semanticReadPath` 或问题卡片的 `semanticReadPath` 进入语义检索，
也可在已有 search/question URI 上添加 `strategy=semantic`。默认查询保持本地词法路径。
当前语义召回使用模型派生检索问题和查询扩展，不保证覆盖全部等义表述；首次索引或
陌生查询仍会等待模型，超时、非法响应和来源变化均应以返回诊断为准。
