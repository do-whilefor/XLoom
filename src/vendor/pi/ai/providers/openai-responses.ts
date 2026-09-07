// Adapted from fixed Pi v0.85.1 api/openai-responses.ts; only API-key, stateless function tools.
import OpenAI from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.js';
import type { AssistantMessage, StreamFunction, StreamOptions } from '../types.js';
import { AssistantMessageEventStream } from '../utils/event-stream.js';
import { headersToRecord } from '../utils/headers.js';
import { validateCompletedTools } from '../utils/stream-integrity.js';
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from './openai-responses-shared.js';

export interface OpenAIResponsesOptions extends StreamOptions { client?: OpenAI; }
export const stream: StreamFunction<'openai-responses', OpenAIResponsesOptions> = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usageAvailable: false, usageComplete: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'pending', timestamp: Date.now(),
    };
    try {
      const client = options?.client ?? new OpenAI({ apiKey: options?.apiKey ?? '', baseURL: model.baseUrl,
        maxRetries: 0, timeout: 120_000 });
      let params: ResponseCreateParamsStreaming = {
        model: model.id, input: convertResponsesMessages(model, context, new Set(['openai'])),
        stream: true, store: false, max_output_tokens: options?.maxTokens ?? model.maxTokens,
        ...(model.reasoning ? { include: ['reasoning.encrypted_content'] } : {}),
        ...(context.tools?.length ? { tools: convertResponsesTools(context.tools, { strict: false }) } : {}),
      };
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) params = { ...(nextParams as typeof params), stream: true, store: false };
      const { data: openaiStream, response } = await client.responses.create(params, {
        signal: options?.signal, maxRetries: 0,
        ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      }).withResponse();
      await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
      stream.push({ type: 'start', partial: output });
      await processResponsesStream(openaiStream, output, stream, model);
      if (options?.signal?.aborted) throw new Error('Request was aborted');
      if (output.stopReason === 'pending' || output.stopReason === 'error' || output.stopReason === 'aborted') {
        throw new Error(output.errorMessage || 'Response did not complete');
      }
      validateCompletedTools(output);
      output.usageComplete = output.usageAvailable === true;
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { partialJson?: string }).partialJson;
        delete (block as { customInput?: unknown }).customInput;
      }
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};
