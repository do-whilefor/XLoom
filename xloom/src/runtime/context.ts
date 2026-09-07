import type { ActiveConfig } from '../config.js';
import type { AgentMessage } from '../vendor/pi/agent/types.js';
import type { Context, Message, Model } from '../vendor/pi/ai/types.js';
import { transformMessages } from '../vendor/pi/ai/providers/transform-messages.js';
import { convertToLlm } from '../vendor/pi/coding-agent/core/messages.js';
import { estimateTokens } from '../vendor/pi/coding-agent/core/compaction/compaction.js';
import { isCapsule } from '../case/capsule.js';

export function projectMessages(messages: AgentMessage[]): Message[] {
  const latest = messages.findLast(isCapsule);
  return messages.flatMap((m): Message[] => isCapsule(m) ? m === latest ? [{ role: 'user', content: m.content, timestamp: m.timestamp }] : [] : convertToLlm([m]));
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
  return transformMessages(projected, model);
}
export interface RequestBudget {
  estimated: true; system: number; tools: number; history: number; protocol: number;
  input: number; outputReserve: number; window: number; availableInput: number; fits: boolean;
}
export function requestBudget(context: Context, config: Pick<ActiveConfig, 'contextWindow' | 'maxOutputTokens'>, output = config.maxOutputTokens): RequestBudget {
  // This is a conservative payload estimate, not a measurement of opaque reasoning tokens.
  const size = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value ?? '')) / 3);
  const system = size(context.systemPrompt), tools = size(context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })));
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
    return n + Math.max(estimateTokens(m), size(payload), reportedOutput) + 8;
  }, 0);
  const protocol = 1024, input = system + tools + history + protocol;
  return { estimated: true, system, tools, history, protocol, input, outputReserve: output,
    window: config.contextWindow, availableInput: config.contextWindow - output, fits: input + output <= config.contextWindow };
}
