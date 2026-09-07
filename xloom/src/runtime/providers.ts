import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ActiveConfig } from '../config.js';
import { redactor } from '../log.js';
import type { StreamFn } from '../vendor/pi/agent/types.js';
import { streamAnthropic } from '../vendor/pi/ai/providers/anthropic.js';
import { stream as streamCompletions } from '../vendor/pi/ai/providers/openai-completions.js';
import { stream as streamResponses } from '../vendor/pi/ai/providers/openai-responses.js';
import { AssistantMessageEventStream } from '../vendor/pi/ai/utils/event-stream.js';
import type { AssistantMessage, Model } from '../vendor/pi/ai/types.js';
import { requestBudget } from './context.js';
import { effectiveCapabilities, resolveThinking } from './models.js';

export function resolveModel(config: ActiveConfig): Model<any> {
  const capability = effectiveCapabilities(config);
  return { id: config.id, name: config.id, api: config.api, provider: config.provider,
    baseUrl: config.baseUrl, reasoning: capability.reasoning, input: [...capability.input],
    contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens,
    compat: config.api === 'openai-completions' ? {
      supportsDeveloperRole: false, supportsStrictMode: false, supportsFinishReason: true,
      maxTokensField: capability.outputTokenField as "max_tokens" | "max_completion_tokens",
      requiresReasoningContentOnAssistantMessages: ['kimi', 'deepseek'].includes(config.provider),
    } : config.api === 'anthropic-messages' ? { allowEmptySignature: config.provider === 'glm' } : {},
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
export function failedMessage(model: Model<any>, error: string, aborted = false): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: aborted ? 'aborted' : 'error', errorMessage: error, timestamp: Date.now(),
    usageAvailable: false, usageComplete: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costAvailable: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function failedStream(message: AssistantMessage) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message });
  stream.end();
  return stream;
}
/** Compatibility export for prior-stage callers; all mappings now come from explicit model capabilities. */
export const glmThinkingParams = resolveThinking;

export function createProvider(config: ActiveConfig): StreamFn {
  const capability = effectiveCapabilities(config);
  const thinking = resolveThinking(config);
  const client = config.api === 'anthropic-messages'
    ? new Anthropic({ ...(config.provider === 'anthropic' ? { apiKey: config.apiKey, authToken: null }
      : { apiKey: null, authToken: config.apiKey }), baseURL: config.baseUrl, maxRetries: 0, timeout: 120_000 })
    : new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 0, timeout: 120_000 });
  const redact = redactor(config.apiKey);
  return (model, context, options) => {
    const fail = (reason: string) => failedStream(failedMessage(model, reason));
    if (options?.signal?.aborted) return failedStream(failedMessage(model, 'Request was aborted', true));
    if (model.id !== config.id || model.api !== config.api || model.provider !== config.provider || model.baseUrl !== config.baseUrl) {
      return fail('请求模型与启动时的共同模型配置不一致');
    }
    const maxTokens = options?.maxTokens ?? config.maxOutputTokens;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > config.maxOutputTokens) {
      return fail('请求输出上限与启动配置冲突');
    }
    if (!model.input.includes('image') && context.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image'))) {
      return fail(`当前模型 ${model.id} 不支持图像输入；资料已保留。`);
    }
    if (!requestBudget(context, config, maxTokens).fits) {
      return fail('当前必要输入触及上下文上限；已暂停并保留会话。');
    }
    const nativeThinking = { ...thinking };
    if (config.api === 'openai-responses' && capability.reasoningSummary) {
      nativeThinking.reasoning = { ...(nativeThinking.reasoning as object | undefined), summary: 'auto' };
    }
    const common = { signal: options?.signal, maxTokens, cacheRetention: 'none' as const,
      onPayload: (payload: unknown) => ({ ...(payload as object), ...nativeThinking }) };
    const source = config.api === 'anthropic-messages'
      ? streamAnthropic(model as Model<'anthropic-messages'>, context, { ...common, client: client as Anthropic })
      : config.api === 'openai-completions'
        ? streamCompletions(model as Model<'openai-completions'>, context, { ...common, client: client as OpenAI })
        : streamResponses(model as Model<'openai-responses'>, context, { ...common, client: client as OpenAI });
    const output = new AssistantMessageEventStream();
    void (async () => {
      let lastMessage: AssistantMessage | undefined;
      try {
        for await (const event of source) {
          const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial;
          lastMessage = message;
          message.thinking = config.thinking ?? 'default';
          message.usage.costAvailable = false;
          if (message.errorMessage) message.errorMessage = redact(message.errorMessage);
          output.push(event);
        }
      } catch (error) {
        const message = { ...(lastMessage ?? failedMessage(model, '')), stopReason: options?.signal?.aborted ? 'aborted' as const : 'error' as const,
          usageComplete: false, errorMessage: redact(error instanceof Error ? error.message : String(error)) };
        output.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message });
      } finally { output.end(); }
    })();
    return output;
  };
}
