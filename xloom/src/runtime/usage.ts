import type { AssistantMessage } from '../vendor/pi/ai/types.js';

export type UsageField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens' | 'reasoning';
export interface UsageTotals {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  reasoning?: number; available: UsageField[]; complete: boolean; requests: number; cost?: number;
}
export type RecordedResponse = AssistantMessage & {
  xloomResponseId?: string; thinking?: string; usageAvailable?: boolean; usageComplete?: boolean;
};

export function responseUsage(message: RecordedResponse): UsageTotals {
  const usage = message.usage as AssistantMessage['usage'] & { available?: UsageField[]; costAvailable?: boolean };
  const known = message.usageAvailable ?? (!!message.responseId || usage.totalTokens > 0 || usage.input > 0 || usage.output > 0);
  const available: UsageField[] = known ? usage.available ?? ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', ...(usage.reasoning === undefined ? [] : ['reasoning' as const])] : [];
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    ...Object.fromEntries(available.map((key) => [key, usage[key] ?? 0])), available,
    complete: known && (message.usageComplete ?? !['aborted', 'error', 'pending'].includes(message.stopReason)), requests: 1,
    ...(known && usage.costAvailable ? { cost: usage.cost.total } : {}) };
}

export function combineUsageTotals(items: Array<UsageTotals | undefined>): UsageTotals | undefined {
  const values = items.filter((item): item is UsageTotals => !!item);
  if (!values.length) return;
  const available = [...new Set(values.flatMap((item) => item.available))];
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    ...Object.fromEntries(available.map((key) => [key, values.reduce((sum, item) => sum + (item[key] ?? 0), 0)])),
    available, complete: values.every((item) => item.complete), requests: values.reduce((sum, item) => sum + item.requests, 0),
    ...(values.every((item) => item.cost !== undefined) ? { cost: values.reduce((sum, item) => sum + item.cost!, 0) } : {}) };
}
