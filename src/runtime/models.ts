import type { ActiveConfig, LlmApi, Provider, Thinking } from '../config.js';

export const providerDefaults: Readonly<Record<Provider, { readonly api: LlmApi; readonly baseUrl: string }>> = Object.freeze({
  glm: Object.freeze({ api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }),
  kimi: Object.freeze({ api: 'openai-completions', baseUrl: 'https://api.moonshot.ai/v1' }),
  deepseek: Object.freeze({ api: 'openai-completions', baseUrl: 'https://api.deepseek.com' }),
  anthropic: Object.freeze({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }),
  openai: Object.freeze({ api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }),
});

export interface ModelCapabilities {
  readonly provider: Provider;
  readonly api: LlmApi;
  readonly id: string;
  readonly known: boolean;
  /** A missing capacity requires an explicit user-supplied value, never a guessed window. */
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly input: readonly ('text' | 'image')[];
  readonly reasoning: boolean;
  readonly tools: 'documented' | 'unverified';
  readonly outputTokenField: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  readonly reasoningSummary: boolean;
  readonly thinking: {
    readonly allowed: readonly Thinking[];
    readonly mode: 'effort' | 'glm-messages' | 'adaptive' | 'budget' | 'responses' | 'unknown';
    readonly defaultBehavior: string;
  };
  readonly continuationFields: readonly string[];
  readonly sources: readonly string[];
  readonly reviewedOn: string;
  readonly validation: 'prior-live' | 'not-live-validated';
}

type Entry = Omit<ModelCapabilities, 'known' | 'defaultMaxOutputTokens' | 'outputTokenField' | 'reasoningSummary' | 'reviewedOn' | 'validation'>
  & Partial<Pick<ModelCapabilities, 'defaultMaxOutputTokens' | 'reasoningSummary' | 'validation'>>;

function entry(value: Entry): ModelCapabilities {
  return Object.freeze({ ...value, known: true, defaultMaxOutputTokens: value.defaultMaxOutputTokens ?? 16384,
    outputTokenField: value.api === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
    reasoningSummary: value.reasoningSummary ?? false, reviewedOn: '2026-09-07',
    validation: value.validation ?? 'not-live-validated', input: Object.freeze([...value.input]),
    thinking: Object.freeze({ ...value.thinking, allowed: Object.freeze([...value.thinking.allowed]) }),
    continuationFields: Object.freeze([...value.continuationFields]), sources: Object.freeze([...value.sources]) });
}

const glmSources = ['https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3', 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'];
const claudeSources = ['https://platform.claude.com/docs/en/about-claude/models/overview', 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking'];
export const modelCapabilities: readonly ModelCapabilities[] = Object.freeze([
  ...(['glm-5.3', 'glm-5.3-flash'] as const).flatMap((id) => (['openai-completions', 'anthropic-messages'] as const).map((api) => entry({
    provider: 'glm', api, id, contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxOutputTokens: 128_000,
    // Messages image input has a real synthetic-color validation; Chat vision remains conservative.
    input: id === 'glm-5.3-flash' && api === 'anthropic-messages' ? ['text', 'image'] : ['text'], reasoning: true, tools: 'documented',
    thinking: { allowed: ['low', 'high', 'max'], mode: api === 'anthropic-messages' ? 'glm-messages' : 'effort', defaultBehavior: 'always-on; provider default max' },
    continuationFields: api === 'anthropic-messages' ? ['content', 'signature'] : ['reasoning_content', 'tool_calls'],
    sources: glmSources, validation: id === 'glm-5.3-flash' && api === 'anthropic-messages' ? 'prior-live' : 'not-live-validated',
  }))),
  entry({ provider: 'kimi', api: 'openai-completions', id: 'kimi-k3',
    // Fixed Pi generator confirms 131072 output; no verified context capacity was available.
    maxOutputTokens: 131072, input: ['text'], reasoning: true, tools: 'documented',
    thinking: { allowed: ['low', 'high', 'max'], mode: 'effort', defaultBehavior: 'always-on; provider default' },
    continuationFields: ['reasoning_content', 'tool_calls'],
    sources: ['https://platform.kimi.ai/docs/guide/kimi-k3-quickstart', 'https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/scripts/generate-models.ts'],
  }),
  ...(['deepseek-v4-flash', 'deepseek-v4-pro'] as const).map((id) => entry({ provider: 'deepseek', api: 'openai-completions', id,
    contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxOutputTokens: 384_000, input: ['text'], reasoning: true, tools: 'documented',
    thinking: { allowed: ['off', 'low', 'high', 'max'], mode: 'effort', defaultBehavior: 'thinking enabled; provider default effort' },
    continuationFields: ['reasoning_content', 'tool_calls'],
    sources: ['https://api-docs.deepseek.com/quick_start/pricing', 'https://api-docs.deepseek.com/guides/thinking_mode/'],
  })),
  ...(['claude-sonnet-4-6', 'claude-opus-4-6'] as const).map((id) => entry({ provider: 'anthropic', api: 'anthropic-messages', id,
    contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxOutputTokens: id === 'claude-opus-4-6' ? 128_000 : 64_000,
    input: ['text', 'image'], reasoning: true, tools: 'documented',
    thinking: { allowed: id === 'claude-opus-4-6' ? ['off', 'low', 'medium', 'high', 'max'] : ['off', 'low', 'medium', 'high'], mode: 'adaptive', defaultBehavior: 'provider default; no thinking control sent' },
    continuationFields: ['content', 'signature', 'redacted_thinking.data'], sources: claudeSources,
  })),
  entry({ provider: 'anthropic', api: 'anthropic-messages', id: 'claude-sonnet-4-20250514',
    contextWindow: 200_000, maxContextWindow: 200_000, maxOutputTokens: 64_000, defaultMaxOutputTokens: 32768,
    input: ['text', 'image'], reasoning: true, tools: 'documented',
    thinking: { allowed: ['off', 'minimal', 'low', 'medium', 'high'], mode: 'budget', defaultBehavior: 'provider default; no thinking control sent' },
    continuationFields: ['content', 'signature', 'redacted_thinking.data'], sources: [...claudeSources, 'https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/simple-options.ts'],
  }),
  entry({ provider: 'openai', api: 'openai-responses', id: 'gpt-5.4',
    contextWindow: 272_000, maxContextWindow: 1_050_000, maxOutputTokens: 128_000,
    input: ['text', 'image'], reasoning: true, tools: 'documented', reasoningSummary: true,
    thinking: { allowed: ['off', 'low', 'medium', 'high', 'xhigh'], mode: 'responses', defaultBehavior: 'none (provider default)' },
    continuationFields: ['output', 'reasoning.encrypted_content', 'function_call.call_id', 'message.phase', 'status'],
    sources: ['https://developers.openai.com/api/docs/models/gpt-5.4', 'https://developers.openai.com/api/docs/guides/reasoning'],
  }),
]);

export function getModelCapabilities(provider: Provider, api: LlmApi, id: string): ModelCapabilities | undefined {
  return modelCapabilities.find((item) => item.provider === provider && item.api === api && item.id === id);
}
export function effectiveCapabilities(config: Pick<ActiveConfig, 'provider' | 'api' | 'id'>): ModelCapabilities {
  return getModelCapabilities(config.provider, config.api, config.id) ?? Object.freeze({
    provider: config.provider, api: config.api, id: config.id, known: false, input: Object.freeze(['text'] as const),
    reasoning: false, tools: 'unverified', outputTokenField: config.api === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
    reasoningSummary: false, thinking: Object.freeze({ allowed: Object.freeze([]), mode: 'unknown', defaultBehavior: 'provider default; capabilities unverified' }),
    continuationFields: Object.freeze([]), sources: Object.freeze([]), reviewedOn: '2026-09-07', validation: 'not-live-validated',
  });
}

/** The exact Pi v0.85.1 budget values; unsupported tiers must never be clamped. */
export const thinkingBudgets = Object.freeze({ minimal: 1024, low: 2048, medium: 8192, high: 16384 });
export function resolveThinking(config: Pick<ActiveConfig, 'provider' | 'api' | 'id' | 'thinking' | 'maxOutputTokens'>): Record<string, unknown> {
  const level = config.thinking;
  if (level === undefined) return {};
  const capability = effectiveCapabilities(config);
  if (!capability.thinking.allowed.includes(level)) throw new Error(`thinking ${level} 不适用于 ${config.provider}/${config.id}/${config.api}`);
  switch (capability.thinking.mode) {
    case 'glm-messages': return { thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: level } };
    case 'effort':
      if (level === 'off') return { thinking: { type: 'disabled' } };
      // K3's native effort format is OpenAI-compatible; do not invent a thinking switch.
      return config.provider === 'kimi' ? { reasoning_effort: level } : { thinking: { type: 'enabled' }, reasoning_effort: level };
    case 'adaptive': return level === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'adaptive' }, output_config: { effort: level } };
    case 'budget': {
      if (level === 'off') return { thinking: { type: 'disabled' } };
      const budget = thinkingBudgets[level as keyof typeof thinkingBudgets];
      if (config.maxOutputTokens < budget + 1024) throw new Error(`maxOutputTokens 与 thinking=${level} 冲突：固定思考预算 ${budget} 另需至少 1024 token 答复空间`);
      return { thinking: { type: 'enabled', budget_tokens: budget } };
    }
    case 'responses': return { reasoning: { effort: level === 'off' ? 'none' : level } };
    default: return {};
  }
}
export const thinkingPayload = resolveThinking;

export function protocolBaseUrl(provider: Provider, api: LlmApi): string | undefined {
  if (providerDefaults[provider].api === api) return providerDefaults[provider].baseUrl;
  if (provider === 'glm' && api === 'anthropic-messages') return 'https://open.bigmodel.cn/api/anthropic';
  return undefined;
}
