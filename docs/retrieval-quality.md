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
