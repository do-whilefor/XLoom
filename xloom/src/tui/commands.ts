import type { ProbeAgent } from '../runtime/agent.js';
import type { CaseLoop } from '../case/loop.js';
import { combineUsageTotals, type UsageField, type UsageTotals } from '../runtime/usage.js';

export function usageText(usage: UsageTotals | undefined): string {
  if (!usage) return '不可用（尚未取得）';
  const field = (key: UsageField) => usage.available.includes(key) ? String(usage[key]) : '不可用';
  return `输入 ${field('input')} / 输出 ${field('output')} / 缓存读取 ${field('cacheRead')} / 缓存写入 ${field('cacheWrite')} / 合计 ${field('totalTokens')} tokens` +
    ` / 推理 ${field('reasoning')}（已包含在输出中，不另加）` +
    ` / 费用 ${usage.cost === undefined ? '不可用' : `$${usage.cost.toFixed(6)}`}` +
    `（提供商已报告累计，含摘要成本${usage.complete ? '' : '；部分请求统计不完整'}）`;
}
export const helpText = `/help    显示帮助
/resume  暂停并选择另一调查
/compact [保留重点]  压缩当前或最近活动角色
/status  查看当前会话、模型和执行状态
/exit    取消当前执行，保存并退出

Enter 提交 · Esc 取消 · Ctrl+O 展开/折叠工具
Ctrl+T 展开/折叠思考 · Ctrl+C 清空输入；连续两次退出
Shift+Enter 换行
运行中提交的输入会在当前工具响应结束后的边界加入。
取消后未处理的输入会保留，下一次显式提交时再处理。
首条输入设定 Goal；后续输入作为同一调查的 Hint。
明确更改目标可输入“修改目标：新目标”，原始目标及变更记录保留。
explore 自动派发 Probe，verify 优先派发独立 Proof；一次运行一个任务。
六工具：read/write/edit/bash 在本机；chrome 使用已有浏览器；kali 经 SSH 远程执行。
Chrome/Kali 按需连接；配置变更须退出重启，取消后的外部结果可能未知。`;
export type Command = 'help' | 'resume' | 'compact' | 'status' | 'exit';
export function parseCommand(text: string): Command | undefined {
  if (!text.startsWith('/')) return;
  if (/^\/compact(?:\s|$)/.test(text)) return 'compact';
  const commands: Record<string, Command> = { '/help': 'help', '/resume': 'resume', '/status': 'status', '/exit': 'exit' };
  const command = commands[text];
  if (!command) throw new Error(`未支持的命令：${text.split(/\s/)[0]}。可用命令：/help /resume /compact /status /exit`);
  return command;
}
export function statusText(agent: ProbeAgent | CaseLoop): string {
  const { metadata } = agent.session;
  const loop = 'board' in agent ? agent : undefined;
  const board = loop?.board;
  const roles = loop?.agents ?? [agent as ProbeAgent];
  const backends = roles[0].backends;
  const states = { unconfigured: '未配置', disconnected: '未连接', connected: '已连接', error: '错误' };
  const backendText = `\nChrome：${states[backends.chrome.state]}${backends.chrome.selected ? ` · 页面 ${backends.chrome.selected.id} ${backends.chrome.selected.title} ${backends.chrome.selected.url}` : ''}${backends.chrome.error ? ` · ${backends.chrome.error}` : ''}\nKali：${states[backends.kali.state]}${backends.kali.target ? ` · ${backends.kali.target.username}@${backends.kali.target.host}:${backends.kali.target.port}` : ''}${backends.kali.error ? ` · ${backends.kali.error}` : ''}`;
  const roleText = (['probe', 'proof'] as const).map((role) => {
    const runtime = roles.find((a) => a.role === role);
    if (!runtime) return `${role === 'probe' ? 'Probe' : 'Proof'}：尚未创建`;
    const usage = runtime.usage;
    const budget = runtime.contextBudget;
    return `${role === 'probe' ? 'Probe' : 'Proof'}：已创建 · ${runtime.sessionId}\n  用量：${usageText(usage)}\n  当前上下文精确占用：不可用${budget ? `；最近请求估算 ${budget.input} / 可用 ${budget.availableInput}，输出余量 ${budget.outputReserve}` : ''}\n  ${runtime.compactStatus || '尚未压缩'}\n  会话文件：${runtime.persistence.getSessionFile()}`;
  }).join('\n');
  const counts = board ? (['explore', 'verify'] as const).map((kind) => `${kind}：开放 ${Object.values(board.intents).filter((i) => i.kind === kind && i.state === 'open').length} / 受阻 ${Object.values(board.intents).filter((i) => i.kind === kind && i.state === 'blocked').length}`).join('\n') : '';
  const caseText = board ? `\nGoal：${board.goal.request || '尚未输入'}\nScope：${board.goal.scope.join('；') || '沿用原始请求'}\n黑板：r${board.revision}\n执行 / 结果：${board.execution} / ${board.outcome}\n当前角色 / 任务：${loop?.currentRole ?? '无'} / ${loop?.currentIntentId ?? '无'}\n原因：${board.reason}\n${counts}\n假设：${Object.values(board.hypotheses).map((h) => `${h.id} ${h.status}${h.verification ? ` (${h.verification.verdict}, ${h.verification.runId})` : ''}`).join('；') || '无'}\n黑板目录：${agent.session.dir}/blackboard\n${loop?.resultText ?? ''}` : '';
  return `会话：${metadata.id}\n标题：${metadata.title || '空会话'}\n目录：${metadata.cwd}\n模型：${metadata.model.provider} / ${metadata.model.id}\n协议：${metadata.model.api ?? agent.model.api}\n思考：${metadata.model.thinking ?? '模型默认'}\n状态：${agent.state}\n最近角色：${metadata.lastActiveRole ?? '无'}\n累计已知用量：${usageText(combineUsageTotals(roles.map((role) => role.usage)))}\n待处理输入：${agent.pendingInputs.length}\n${roleText}${backendText}${caseText}`;
}
