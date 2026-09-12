import type { Model, Api } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelConfig } from "../types.js";

export interface ResolvedModel {
  model: Model<Api>;
  streamFn: StreamFn;
  secrets?: string[];
  costKnown?: boolean;
}
export type ModelResolver = (config: ModelConfig, signal: AbortSignal) => Promise<ResolvedModel>;

export const resolveModel: ModelResolver = async (config, signal) => {
  signal.throwIfAborted();
  const models = builtinModels();
  const registered = models.getModel(config.provider, config.model);
  const explicitKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !explicitKey) throw new Error(`Missing model credential environment variable: ${config.apiKeyEnv}`);

  if (!config.baseUrl && !config.api) {
    if (!registered) throw new Error(`Unknown Pi model ${config.provider}/${config.model}; configure api and baseUrl for a custom model.`);
    const auth = await models.getAuth(registered, { apiKey: explicitKey, signal });
    if (!auth) throw new Error(`No environment credentials configured for ${config.provider}.`);
    const model = { ...registered, contextWindow: config.contextWindow ?? registered.contextWindow, maxTokens: config.maxTokens ?? registered.maxTokens };
    return {
      model,
      streamFn: (selected, context, options) => models.streamSimple(selected, context, { ...options, apiKey: explicitKey, maxTokens: model.maxTokens }),
      secrets: [auth.auth.apiKey, ...Object.values(auth.auth.headers ?? {})].filter((value): value is string => typeof value === "string" && value.length > 0),
      costKnown: true,
    };
  }

  const api = config.api ?? registered?.api;
  const baseUrl = config.baseUrl ?? registered?.baseUrl;
  if (!api || !baseUrl) throw new Error("Custom models require api and baseUrl.");
  const url = new URL(baseUrl);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search) {
    throw new Error("Model baseUrl must be an HTTP(S) URL without credentials or query parameters.");
  }
  const auth = explicitKey ? undefined : registered ? await models.getAuth(registered, { signal }) : undefined;
  const key = explicitKey ?? auth?.auth.apiKey;
  if (!key) throw new Error("Custom models require apiKeyEnv (for a keyless local server, set it to a non-empty placeholder).");
  const model: Model<Api> = {
    ...(registered ?? {}), id: config.model, name: config.model, provider: config.provider, api, baseUrl,
    reasoning: registered?.reasoning ?? (config.thinking !== undefined && config.thinking !== "off"), input: ["text"],
    contextWindow: config.contextWindow ?? registered?.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? registered?.maxTokens ?? 8192,
    cost: registered?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let streamFn: StreamFn;
  switch (api) {
    case "openai-completions": {
      const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
      streamFn = (selected, context, options) => streamSimple(selected as Model<"openai-completions">, context, { ...options, apiKey: key, maxTokens: model.maxTokens });
      break;
    }
    case "openai-responses": {
      const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-responses");
      streamFn = (selected, context, options) => streamSimple(selected as Model<"openai-responses">, context, { ...options, apiKey: key, maxTokens: model.maxTokens });
      break;
    }
    case "anthropic-messages": {
      const { streamSimple } = await import("@earendil-works/pi-ai/api/anthropic-messages");
      streamFn = (selected, context, options) => streamSimple(selected as Model<"anthropic-messages">, context, { ...options, apiKey: key, maxTokens: model.maxTokens });
      break;
    }
    default: throw new Error(`Custom API not supported in this MVP: ${api}`);
  }
  return { model, streamFn, secrets: [key], costKnown: registered !== undefined && config.baseUrl === undefined };
};
