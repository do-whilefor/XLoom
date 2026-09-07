import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function redactor(...secrets: string[]): (text: string) => string {
  return (text) => secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join('[REDACTED]'), text);
}
/** Mask string values before JSON encoding so credentials cannot damage keys or escaping. */
export function redactStructured<T>(value: T, redact: (text: string) => string, programFields = false): T {
  const protocol: Record<string, readonly string[]> = {
    backend: ['local', 'chrome', 'kali'], tool: ['read', 'write', 'edit', 'bash', 'chrome', 'kali'],
    status: ['observed', 'error', 'interrupted', 'running'], outcome: ['completed', 'unknown', 'not_started'],
  };
  const walk = (item: unknown, key = ''): unknown => {
    if (typeof item === 'string') return programFields && protocol[key]?.includes(item) ? item : redact(item);
    if (Array.isArray(item)) return item.map(child => walk(child));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([field, child]) => [field, walk(child, field)]));
    return item;
  };
  return walk(value) as T;
}
export function createLogger(home: string, sessionId: string, redact: (text: string) => string) {
  const dir = join(home, 'logs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return (event: string, error?: string, origin?: { agent: string; agentSessionId: string; runId?: string; toolCallId?: string; tool?: string }) => {
    const line = { timestamp: new Date().toISOString(), sessionId, event, ...origin, ...(error ? { error: redact(error) } : {}) };
    appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 });
  };
}
