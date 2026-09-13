# 任务内 RAG 与本地整理／审计

Xloom 复用当前研究任务的 SQLite 和 Wiki，把检索结果放入既有研究调用的 `rag`
字段。执行角色仍使用 `read / write / edit / powershell`，Decide／元认知仍只有
`read`；没有新增 Agent、模型调用、工具注册、hook、Python 依赖或外部向量服务。

## 检索范围与相关性

索引单位是完整作者判断块或一个公开记录。中文使用二元切词，英文保留接口标识、
camelCase、下划线及路径组成词，统一 Unicode 字宽；标题权重为正文的三倍，
词频／逆文档频率和长度归一化参与排名。精确的带类型 ID 优先，截短 ID 不作为
精确引用；引用字段、文件路径、哈希和运行字段不参与普通词法排名。

索引覆盖当前 Wiki 正文及公开事实、条件化尝试、Finding、计划和证据描述／元数据。
这个元数据索引不包含原始响应正文。原始正文由下述问题检索与原文入口按需读取；
旧作者版本、私有聊天／日志、其他任务和原 `webounty/` 不在检索范围内。
词法检索没有语义向量或跨语言翻译；另有基于显式类型与条件的 [原生链路发现](knowledge.md)。“未命中”不表示资料不存在或该边界已覆盖。
证据原件路径保留在结果中，使用原来的 read 精读；搜索本身不检查原件哈希。

存在活动缺口时，Decide／元认知优先使用具体缺口及其 needs；Execute 优先使用
当前 Step 自身或 revisits 指向的缺口。没有对应缺口时，Execute 使用当前 Step、
successSignal、缺失条件和 from；规划角色使用 Goal、触发原因及近期 Finding。
结果不会替换原来的公开黑板或自动给 Step 选方法。每个命中展开明确来源闭包，
保留事实替代、作者来源变化、身份／状态条件和相关 refutes 尝试。相关不等于支持，
来源未变化不等于仍然适用，Finding 评级和最终结论仍由原流程处理。

自动上下文最多三个命中；`hits + records` 的 JSON 最多 8,000 字符。预算不足时
整体延后一个判断及其来源包，返回 `deferredCount` 和最多六个引用入口，不截掉
完整判断中的条件、否定或未知部分。通知、查询和路径字段在预算之外；这些是检索
上下文的装包限制，不修改模型 token／运行预算，也不是完整请求大小保证。
引用闭包很大时可以没有正文交付，应从精确引用或 Wiki 页面继续阅读。

## 围绕缺口检索原文

`gaps.items[].readPath` 和 `rag.questions[].readPath` 是当前任务的原生 read 入口，
例如 `xloom://question?stepId=S-...&gapId=gap-download`。Decide 只有 read 也能使用。
默认查询取自这个缺口的 missing、needs 类型、描述和 aliases，不拼入整个 Goal。
可在 URI 追加 URL 编码的 `query`，围绕一个尚缺输入补检索。

结果保留原问题、声明条件、候选材料、旧来源和命中文本的明确来源闭包，包括更正、
反证和适用状态；`answerSupport` 始终是 `not_assessed`。正文搜索遍历当前任务已
登记的归档原件，按 UTF-8 窗口流式读取，完整校验 SHA-256 和大小。不会只搜索摘要
或文件开头，也不会递归搜其他任务和运行日志。原文窗口以词项覆盖排名，与 Wiki
完整判断的词频索引分别处理；不宣称语义召回或保证命中所有等义表述。

命中附带原件 ID、原件哈希、字节起点／长度和 `xloom://original?...` 精读入口。
通过 read 读取该入口会再次校验完整原件，再返回原样文本及范围哈希。定位范围
最多 8 KiB，返回 omittedBefore/omittedAfter；按原件路径继续阅读上下文时保留原件
ID 和条件，不能把局部窗口当全文。正文是资料，不是新的系统指令。

缺失、二进制或非 UTF-8 原件、篡改、读取期间变化和链接越界均报告不完整，不返回
该原件的候选正文。显示预算不足时明确返回 budget_exhausted 或来源延后说明，
不能把空结果解释成不存在。相同 read 实例内，重复查询和相同资料会提示
stop_repeating_query；先精读、缩小缺口或取得新观察。该记忆只存在本轮内，
没有独立会话库或跨轮游标，不阻止调用，也不自动解决缺口。

读完后仍由 Decide 创建带 revisits 的有界 Step，或写 gapReviews；resolve 仍需
可校验原件支撑的 Facts。检索本身不改变旧 Step、Finding 级别和 Goal 状态。

无需已记录缺口的查询使用 `xloom://search?query=<URL编码查询>`。命令行同样支持：

```powershell
node dist/wiki/local.js question --task '<任务目录>' --workspace '<项目目录>' --step 'S-...' --gap 'gap-download'
node dist/wiki/local.js search-originals --task '<任务目录>' --workspace '<项目目录>' --query 'downloadGrant'
node dist/wiki/local.js read-original --task '<任务目录>' --workspace '<项目目录>' --evidence 'E-...' --sha256 '<原件哈希>' --byte-offset 0 --byte-length 1024
```

## 本地模块入口

每轮 Execute 的 `rag.local` 提供本机 Node、安装目录脚本、任务目录和按需说明：
[模块使用说明](../resources/wiki/local.md)。现有 powershell 可以运行：

```powershell
& '<nodeExecutable>' '<scriptFile>' search --task '<taskDirectory>' --workspace '<workspace>' --query '当前问题'
& '<nodeExecutable>' '<scriptFile>' search --task '<taskDirectory>' --workspace '<workspace>' --kind block --page 'WK-page' --id 'B-block'
& '<nodeExecutable>' '<scriptFile>' organize --task '<taskDirectory>' --workspace '<workspace>'
& '<nodeExecutable>' '<scriptFile>' audit --task '<taskDirectory>' --workspace '<workspace>'
```

脚本实际位于安装包 `dist/wiki/local.js`，不依赖启动终端所在目录。`search` 默认
最多六个命中，无字符上限，可显式指定 `--limit` 和 `--budget-chars`。长 JSON 输出
可通过现有 PowerShell 写到本轮 artifacts，再用 read 阅读。命令直接以只读方式打开
SQLite，不实例化 Controller，不抢锁、恢复运行或写研究状态；操作结束前检查黑板
是否变化，变化时拒绝发布结果。查询内容是资料，不是新指令。

## 整理、缓存与审计

Store 在已有投影步骤中生成 `wiki/search-index.json`、`wiki/organization.json`，
页面／索引先写，manifest 最后写，文件哈希随 manifest 发布。整理提供主题导航、
待复核块、缺失来源、替代事实、相同全文及未关联证据 ID；它不会按相似度合并、
删除材料或把作者旧来源标为已复核。作者修订仍通过原 `wikiPages`／checkpoint 提交。

当前索引是完整公开快照的派生投影。查询从 SQLite 重建内存倒排索引，不使用磁盘
JSON 作为权威输入；因此手改索引不会注入查询结果。删除生成索引后，打开任务或
下次提交会重建；带生成标记的编辑会被权威内容覆盖，无法识别的文件会保留并报告
投影不可用。没有实现跨查询增量分词或游标缓存，也未宣称恒定查询成本。

`audit` 根据 SQLite 重新生成期望内容，核对 Wiki 页面、manifest、检索与整理文件，
流式校验已登记证据的完整 SHA-256／大小；不递归扫描未知目录，也不读私有运行日志。
文件／投影目录链接、原件越出登记归档目录、缺失和不一致会报告不可用。检查期间
比较文件状态和最后的黑板内容；这是当时的检查，不保证报告后文件不再变化。

状态为 `consistent` 时只表示文件／引用一致；`review_required` 表示作者来源需复核；
`unavailable` 表示缺失或不一致。脚本在前两者返回退出码 0，在 `unavailable` 返回 2，
运行失败或黑板变化返回 1。审计不修复原件、不改状态、不重放执行操作。

检索、整理和审计输出有 `generator: xloom-wiki-v1`、`evidence: false` 标记。保留
标记的副本不能提交为原始证据；该识别不能证明其他文件真实性或识别任意改写的叙述。

## 来源与验证边界

参考本地 Webounty 的 `search_index.py`、`rag.py`、`wiki.py` 及检索／Wiki 说明，
围绕 Xloom 数据模型重新实现；来源哈希见安装资源 `resources/wiki/provenance.json`。
本次另外参考 `evidence_io.py`、`question_context.py` 和问题级检索说明，接入流式
原文搜索、定位精读和缺口上下文。仍未移植独立会话或持久化全文／增量索引；
本地 discover 提供候选组合，CVSS 已通过独立的原生评分模块接入，见 [CVSS](cvss.md)。
测试验证检索排序、完整来源包、隔离、投影、篡改检测及真实 Pi 工具交接；未评测
真实漏洞召回率、模型理解质量或大规模语料的性能。

2026-09-14 使用已配置的 `opencode-go/deepseek-flash` 做过一次隔离的本地样本验证：
模型实际读取问题入口和原件定位入口，创建了带 revisits 的步骤，未提前宣布完成，
工具错误为 0。共 3 次模型请求，输入 19,725、输出 1,921 tokens。该单例验证接口
确实能被当前模型使用，不代表真实任务召回率或模型选择稳定性已得到评测。
