import type { AgentMessage } from '../vendor/pi/agent/types.js';
import type { SessionEntry } from '../vendor/pi/coding-agent/core/session-manager.js';
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction, type CompactionSettings } from '../vendor/pi/coding-agent/core/compaction/compaction.js';
import { isCapsule } from '../case/capsule.js';

export { compact, shouldCompact } from '../vendor/pi/coding-agent/core/compaction/compaction.js';
export function prepareRoleCompaction(entries: SessionEntry[], availableInput: number, overrides?: Partial<CompactionSettings>) {
  const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: Math.min(20000, Math.max(256, Math.floor(availableInput / 4))), ...overrides };
  const preparation = prepareCompaction(entries, settings);
  if (!preparation) return;
  preparation.messagesToSummarize = preparation.messagesToSummarize.filter((m) => !isCapsule(m));
  preparation.turnPrefixMessages = preparation.turnPrefixMessages.filter((m) => !isCapsule(m));
  if (!preparation.messagesToSummarize.length && !preparation.turnPrefixMessages.length) return;
  return preparation;
}
export function assertToolBoundary(messages: AgentMessage[]) {
  let pending = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (pending.size) throw new Error('工具批次结果尚未完整保存，不能移动压缩分界');
      if (!['error', 'aborted', 'length'].includes(m.stopReason)) pending = new Set(m.content.filter((b) => b.type === 'toolCall').map((b) => b.id));
    } else if (m.role === 'toolResult') pending.delete(m.toolCallId);
    else if (m.role === 'user' && pending.size) throw new Error('工具批次尚未配对，不能压缩');
  }
  if (pending.size) throw new Error('工具批次尚未配对，不能压缩');
}
export const retention = '保留当前目标/Scope/成功条件、用户约束、Intent 与有效对象/Evidence ID、完成与中断动作、未知结果、反驳/纠正及未决条件。最新 Blackboard 优先于旧摘要；摘要不是新证据。保留后端/身份/路径及未知结果，页面与请求 ID 仅当前连接有效；旧请求/截图/输出复读不是新实验。只总结继续工作所需结论和依据，不输出隐藏思维链。';
