import type { ActiveConfig } from '../config.js';
import type { AgentMessage } from '../vendor/pi/agent/types.js';
import type { Context, Message, Model } from '../vendor/pi/ai/types.js';
import { transformMessages } from '../vendor/pi/ai/providers/transform-messages.js';
import { convertToLlm } from '../vendor/pi/coding-agent/core/messages.js';
import { estimateTokens } from '../vendor/pi/coding-agent/core/compaction/compaction.js';
import { isCapsule } from '../case/capsule.js';

// Identity-based classification: user text mentioning Capsule or summaries
// must retain its original role and must never be removed or reclassified.
const projectionKinds = new WeakMap<object, 'capsule' | 'summary'>();

export function projectMessages(messages: AgentMessage[]): Message[] {
  const latest = messages.findLast(isCapsule);
  return messages.flatMap((m): Message[] => {
    if (isCapsule(m)) {
      if (m !== latest) return [];
      const projected: Message = { role: 'user', content: m.content, timestamp: m.timestamp };
      projectionKinds.set(projected, 'capsule'); return [projected];
    }
    const converted = convertToLlm([m]);
    if (m.role === 'compactionSummary' || m.role === 'branchSummary') for (const message of converted) projectionKinds.set(message, 'summary');
    return converted;
  });
}
/** Build only the next request's view. Never rewrite the persisted native history. */
export function projectForModel(messages: AgentMessage[], model: Model<any>): Message[] {
  const projected = projectMessages(messages);
  if (!model.input.includes('image')) {
    const image = projected.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
    if (image) {
      const location = image.role === 'toolResult' ? `工具 ${image.toolName} (${image.toolCallId})` : '用户输入';
      throw new Error(`当前模型 ${model.provider}/${model.id} 不支持图像，${location} 含图像资料；原文件与会话已保留，不能将其作为已读取的图片继续。`);
    }
  }
  // Pi may copy user messages and content arrays for text-only models while
  // keeping their text blocks. Carry our diagnostics across those copies by
  // object identity, never by searching user-visible strings.
  const markedBlocks = new WeakMap<object, 'capsule' | 'summary'>();
  for (const message of projected) {
    const kind = projectionKinds.get(message);
    if (kind && Array.isArray(message.content)) for (const block of message.content) markedBlocks.set(block, kind);
  }
  const transformed = transformMessages(projected, model);
  for (const message of transformed) if (message.role === 'user' && Array.isArray(message.content)) {
    const kind = message.content.map(block => markedBlocks.get(block)).find(value => value !== undefined);
    if (kind) projectionKinds.set(message, kind);
  }
  return transformed;
}
export interface RequestBudget {
  estimated: true; system: number; tools: number; history: number; protocol: number;
  input: number; outputReserve: number; window: number; availableInput: number; fits: boolean;
  /** Subtotals of history, never added to input again. */
  historyParts: { user: number; assistant: number; toolResult: number; summary: number; capsule: number };
  payloadBytes: { system: number; tools: number; user: number; assistant: number; toolResult: number; summary: number; capsule: number };
  /** Difference from ceil(serialized payload bytes / 3), including native/image allowance and message framing. */
  estimationAllowance: number;
}
export function requestBudget(context: Context, config: Pick<ActiveConfig, 'contextWindow' | 'maxOutputTokens'>, output = config.maxOutputTokens): RequestBudget {
  // This is a conservative payload estimate, not a measurement of opaque reasoning tokens.
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? ''));
  const schemas = context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const system = Math.ceil(bytes(context.systemPrompt) / 3), tools = Math.ceil(bytes(schemas) / 3);
  const historyParts = { user: 0, assistant: 0, toolResult: 0, summary: 0, capsule: 0 };
  const payloadBytes = { system: bytes(context.systemPrompt), tools: bytes(schemas), ...historyParts };
  const history = context.messages.reduce((n, m) => {
    // Anthropic sends content and protocol fields, not local tool details or
    // prior billing metadata. Pi truncation details may duplicate all the text.
    const payload = { ...m } as Record<string, unknown>;
    delete payload.details; delete payload.usage; delete payload.timestamp;
    // Native output items mirror Pi blocks; local response IDs and attribution
    // never enter the request. Image bytes use Pi's image allowance rather than
    // counting base64 as ordinary text tokens.
    for (const field of ['providerData', 'xloomResponseId', 'usageAvailable', 'usageComplete', 'thinking']) delete payload[field];
    if (Array.isArray(m.content)) payload.content = m.content.map((block) => block.type === 'image' ? { type: 'image', mimeType: block.mimeType } : block);
    const reportedOutput = m.role === 'assistant' ? m.usage?.output ?? 0 : 0;
    const count = Math.max(estimateTokens(m), Math.ceil(bytes(payload) / 3), reportedOutput) + 8;
    const category = projectionKinds.get(m) ?? m.role;
    historyParts[category] += count; payloadBytes[category] += bytes(payload);
    return n + count;
  }, 0);
  const protocol = 1024, input = system + tools + history + protocol;
  const estimationAllowance = system + tools + history - Math.ceil(Object.values(payloadBytes).reduce((n, value) => n + value, 0) / 3);
  return { estimated: true, system, tools, history, historyParts, payloadBytes, estimationAllowance, protocol, input, outputReserve: output,
    window: config.contextWindow, availableInput: config.contextWindow - output, fits: input + output <= config.contextWindow };
}
