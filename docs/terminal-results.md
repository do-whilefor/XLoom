# 阶段结果与协议诊断

Checkpoint 保存成功后，Controller 按 run ID + checkpoint ID 发布一次阶段结果。
相同 checkpoint 的重试不重复发布。Execute 主动交回 Decide 时，界面仅显示
简短交接提示，完整摘要仍保存在原 Step/result 和执行日志中。结算摘要与刚发布
的 checkpoint 完全相同时，界面显示结算提示。不同 checkpoint、不同运行和
最终答复不会因为文字相同而被全局去重。

模型新建 Step 的规范格式不包含 id；id 由 Controller 分配。已有 Step 的更新
使用 updateSteps。条件字段 requires/missing/scope/stateVersion/
expectedCapability/counterEvidence 必须放在 combination 内。

模型入口可以整理两类明确的格式偏差，再执行完整的严格校验：

- 将放在 Step 顶层的上述条件原样移入 combination；内外冲突时拒绝自动选择。
- 移除无引用、无重名、未占用的 S-* 临时标签；已有、重复、被引用的 ID 拒绝
  自动丢弃。不自动改写引用，也不根据名字猜测要更新哪个 Step。

其他未知字段、缺失条件、非法引用仍被拒绝。需要模型修复时，最多一次无工具
请求，明确说明字段层级及 ID 规则，要求保留前提和反证。原始回复保留在日志中。

终端将协议修复进度显示为简短中文；重复的字段错误合并列出，并保留原始诊断
在展开详情中。错误正文会换行，避免恢复指引被单行截断。长摘要中的 `<name>`
等参数占位符不会再阻止分段，内联代码和引号内容保持完整。排版只作用于界面，
不更改 Agent 上下文和证据。
