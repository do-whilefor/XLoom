# Wiki/RAG 检索质量评测

第一批使用事先固定的 20 个合成查询，分为报表下载 development 和附件读取
acceptance 两组，每组 10 个查询。覆盖精确 ID、页面别名、中文、来源更正、
多前提竞争、长原件后部的否定条件及无匹配。期望引用在 fixture 内明确标注，
不由待测排序器生成。两个分组分别报告，不把合成结果当成真实任务准确率。

```powershell
node --import tsx scripts/evaluate-wiki-retrieval.ts --output .xloom/checks/rag-quality/baseline.json
node --import tsx scripts/evaluate-wiki-retrieval.ts --baseline .xloom/checks/rag-quality/baseline.json --output .xloom/checks/rag-quality/current.json
```

前五项召回率只计算有预期命中的查询；无匹配查询单独检查。Wiki 另核对来源更正、
必要原件引用和条件文本；原件命中用原生 original 入口读回，并与归档字节逐一比较。
报告保留每个查询的实际前五项、预期引用、交付字符数和包含冷／热缓存影响的耗时。
字符总数不是模型 token 或成本，耗时不是稳定性能基准。原件模式按窗口限额返回，
指标按证据 ID 去重，不能将多个同文件窗口解释为不同证据。

当前尚无独立标注的真实任务集，也没有模型答案评分；不报告真实漏洞发现率。
后续模型回放单独验证工具选择、精读、条件理解和写入协议。不得用测试期望或
答案标签作为模型提示。新增真实案例应先脱敏，并保持研究任务和私有聊天隔离。

## 首批前后对照

运行基线为 `9368252` 的检索实现；固定 fixture 在 `ac67f28` 提交，之后才改排序。
原始报告保存在本机 `.xloom/checks/rag-quality-20260914/`，不随安装包发布。
两组各有 8 个带预期命中的查询，另有 2 个无匹配查询。基线两组均召回 6/8；
多前提分组后的两组均召回 8/8。补回的是每组的 Wiki 与原件多输入案例。
这是小规模固定合成集的回归结果，不能推广为真实任务 100% 召回。

新增分组回归还检查部分词命中与完整表达词项覆盖的区别、重复表达去重、精确
ID 优先、未知同义词不推断、预算整包延后、原件损坏、全角标识、子串干扰和
真实字节定位。question、自动研究上下文和同角色重复查询提示共用同一实现。
source conditions / original integrity 的既有严格检查继续生效。

## 配置模型回放

```powershell
node --import tsx scripts/validate-grouped-retrieval.ts --live --output .xloom/checks/rag-quality/live-grouped.json
node --import tsx scripts/validate-wiki-structure.ts --live --output .xloom/checks/rag-quality/live-wiki.json
```

首个回放使用配置的 Decide 模型、原生 read、实际 SQLite 和本地合成归档。模型
收到研究目标和读取要求，不收到验收标签；检查其是否实际读取不同版本的授权／
对象原件，披露版本差异，并保留未决缺口。报告包含使用量、工具读取路径和逐项
结果；无金额、token 或请求次数限制，300 秒看门狗用于发现卡住的运行。
第二个回放沿用 Wiki 作者／更正后元数据维护场景，检查来源与复核基线保留。
这些有明确操作要求的接口回放不构成无引导模型理解准确率评测。

本机配置模型 `opencode-go/deepseek-flash` 的实际报告：

| 报告 | 请求数 | 结果 |
| --- | ---: | --- |
| live-grouped-1.json | 3 | 未通过：模型识别版本差异并规划 revisit，但来源包不完整时没有补读完整包，改用普通文件读；未满足原生完整性校验的验收条件。 |
| live-grouped-2.json | 6 | 通过：明确区分预算延后并沿 nextReadPath 补读；使用原生 original 读取授权 v1、长原件末尾对象 v2，披露版本差异，保留缺口并规划 revisit；工具错误为 0。 |
| live-wiki-1.json | 8 | 两阶段通过：写入必要解释与检索元数据、更正后只修改元数据；来源基线、待复核状态和研究记录保持正确；工具错误为 0。 |

第一轮失败后补充了运行时来源包不完整状态和预算补读入口，并明确回放测试的是
带校验的原生读取；没有放宽断言或将普通文件读取算成原生校验。模型检查的是
归档中的关键片段及适用条件，不声称读完长文件每一个填充字节。

最终离线报告的交付字符数：development 65,914 → 70,191；acceptance 67,690 →
71,895。补回相关材料并增加命中解释后体积约增加 6%，本批不声称节省 token。

3,051 条合成元数据的两次独立性能测量中，热查询中位数分别为 78.18 → 90.85 ms、
68.86 → 60.97 ms；每次各取 5 个热样本。两次方向不一致，保留全部报告，不宣称
稳定提速或稳定退化。两版均通过全量索引一致、命中及否定条件保留检查，热索引
新增分词字节均为 0。该实验不覆盖多输入扩展、模型延迟或原件哈希成本；专门的
规模化性能优化仍属于后续批次。

最终 `npm run check` 通过：62 个测试文件、1,572 项测试，包含类型检查和构建。
新增评测／模型脚本与相关测试另通过 NodeNext 严格 TypeScript 检查。
