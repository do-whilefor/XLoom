import type { AssistantMessage } from '../types.js';

// XLoom: partial-json belongs to display only. Tool execution requires a complete JSON object.
export function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) throw new Error('Tool call ended without complete JSON arguments');
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool call arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function validateCompletedTools(message: AssistantMessage): void {
  const calls = message.content.filter(block => block.type === 'toolCall');
  if (message.stopReason === 'length') return;
  if (calls.length && message.stopReason !== 'toolUse') throw new Error('Tool calls require a normal tool-use terminal state');
  if (!calls.length && message.stopReason === 'toolUse') throw new Error('Tool-use terminal state contains no calls');
  const ids = new Set<string>();
  for (const call of calls) {
    const callId = message.api === 'openai-responses' ? call.id.split('|')[0] : call.id;
    if (!callId || !call.name || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error('Incomplete tool call');
    }
    if (ids.has(callId)) throw new Error('Duplicate tool call ID in response');
    ids.add(callId);
  }
}
