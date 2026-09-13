/** UI wording only. Original diagnostics remain available in expanded details. */
export function protocolFailure(message: string): string | undefined {
  if (!message.startsWith("Final response protocol validation failed") && !/^steps\.\d+(?:\.\w+)?: .*Unrecognized key/.test(message)) return;
  const reason = message.replace(/^Final response protocol validation failed(?: after one repair)?:\s*/, "");
  const groups = new Map<string, string[]>();
  for (const issue of reason.split(/;\s*(?=[a-zA-Z]+(?:\.\d+)?[.:])/)) {
    const match = /^(steps\.\d+(?:\.\w+)*):\s*(.*)$/.exec(issue);
    const field = match?.[1], detail = match?.[2] ?? issue;
    const label = field ? field.replace(/^steps\.(\d+)/, (_, index: string) => `新步骤 ${Number(index) + 1}`) : "结果";
    const unknown = /^Unrecognized key\(s\) in object:\s*(.*)$/.exec(detail);
    const explanation = unknown ? `包含不支持的字段：${unknown[1]}`
      : detail.startsWith("Cannot discard an existing, duplicated or referenced Step ID") ? "id 已存在、重复或被引用，无法安全自动处理；需区分新建步骤与已有步骤更新。"
      : detail.startsWith("New Steps omit id") ? "新步骤的 id 由系统生成；修改已有步骤请使用 updateSteps。"
      : detail.startsWith("Conflicting nested and top-level values") ? "combination 内外存在冲突值，需要明确保留的条件。"
      : detail;
    const fields = groups.get(explanation) ?? [];
    fields.push(label); groups.set(explanation, fields);
  }
  const lines = [...groups].map(([reason, fields]) => `- ${fields.join("、")}：${reason}`);
  return ["模型结果未通过格式校验，本次结果未提交。", "", ...lines, "", "已提交的阶段结果和证据保留。使用 /start 可重新规划。"].join("\n");
}

export function progressNotice(text: string): string | undefined {
  if (text.startsWith("Final response has an invalid protocol shape or reference;")) return "正在修正模型结果格式（仅一次，不调用工具）。";
  if (text.startsWith("Decision format normalized without another model request:")) return "规划格式已自动整理，保留全部条件；未追加模型请求。";
  return undefined;
}
