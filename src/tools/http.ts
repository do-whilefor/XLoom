import { createHash } from 'node:crypto';
import { request as httpRequest, validateHeaderName, validateHeaderValue, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PREFIX = 'xloom-http ';
export const HTTP_REQUEST_LIMIT = 256 * 1024;
export const HTTP_RESPONSE_LIMIT = 1024 * 1024;
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface HttpExchange {
  version: 1;
  /** Program execution environment; absent in existing local-only records. */
  transport?: 'local' | 'ssh';
  url: string;
  method: 'GET' | 'POST';
  status: number | null;
  startedAt: string;
  endedAt: string;
  complete: boolean;
  outcome: 'completed' | 'not_started' | 'unknown';
  requestHeaderHashes: Record<string, string>;
  credentialFingerprint: string;
  requestBodySha256: string;
  responseBodySha256: string;
}
export interface HttpObservation {
  text: string;
  exchange: HttpExchange;
  requestBody: Buffer;
  responseBody: Buffer;
}
export class HttpExecutionError extends Error {
  constructor(message: string, readonly partialExchange: HttpExchange, readonly requestBody: Buffer, readonly responseBody: Buffer) {
    super(message);
    this.name = 'HttpExecutionError';
  }
}

/** Explicit operation syntax only: never inspect, rewrite, or execute shell text. */
export function isHttpCommand(command: string): boolean { return command.startsWith(PREFIX); }

/** JSON.parse accepts duplicate keys. This bounded parser rejects them at every depth. */
export function parseStrictJson(input: string | Uint8Array): unknown {
  let source: string;
  try { source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { throw new Error('JSON 必须为有效 UTF-8'); }
  let cursor = 0;
  const fail = (): never => { throw new Error(`严格 JSON 格式非法（位置 ${cursor}）`); };
  const whitespace = () => { while (cursor < source.length && /[\x20\t\r\n]/.test(source[cursor])) cursor++; };
  const string = (): string => {
    if (source[cursor] !== '"') return fail();
    const start = cursor++;
    while (cursor < source.length) {
      const ch = source[cursor++];
      if (ch === '"') {
        let value: string;
        try { value = JSON.parse(source.slice(start, cursor)) as string; } catch { return fail(); }
        // Reject lone UTF-16 surrogates rather than silently replacing them on UTF-8 output.
        for (let i = 0; i < value.length; i++) {
          const code = value.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return fail();
          } else if (code >= 0xdc00 && code <= 0xdfff) return fail();
        }
        return value;
      }
      if (ch === '\\') cursor++;
      else if (ch.charCodeAt(0) < 32) return fail();
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    whitespace();
    if (source[cursor] === '"') return string();
    if (source[cursor] === '{' || source[cursor] === '[') {
      if (depth >= 32) throw new Error('JSON 嵌套不得超过 32 层');
      const object = source[cursor++] === '{', end = object ? '}' : ']';
      const result: Record<string, unknown> | unknown[] = object ? {} : [];
      const keys = new Set<string>();
      whitespace();
      if (source[cursor] === end) { cursor++; return result; }
      for (;;) {
        whitespace();
        if (object) {
          const key = string();
          if (keys.has(key)) throw new Error('JSON 不允许重复键');
          keys.add(key); whitespace();
          if (source[cursor++] !== ':') return fail();
          Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        } else (result as unknown[]).push(value(depth + 1));
        whitespace();
        const separator = source[cursor++];
        if (separator === end) return result;
        if (separator !== ',') return fail();
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(literal, cursor)) { cursor += literal.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(cursor));
    if (!number) return fail();
    cursor += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isFinite(parsed)) return fail();
    return parsed;
  };
  const result = value(0); whitespace();
  if (cursor !== source.length) return fail();
  return result;
}

export interface HttpInput { url: URL; method: 'GET' | 'POST'; headers: Record<string, string>; body: Buffer; timeoutMs: number }
export function parseHttpCommand(command: string): HttpInput {
  if (!isHttpCommand(command)) throw new Error('HTTP 操作必须使用 xloom-http 后接严格 JSON');
  if (Buffer.byteLength(command) > HTTP_REQUEST_LIMIT + 64 * 1024) throw new Error('HTTP 参数超过大小限制');
  const parsed = parseStrictJson(command.slice(PREFIX.length));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('HTTP 参数必须为 JSON 对象');
  const args = parsed as Record<string, unknown>;
  if (Object.keys(args).some(key => !['url', 'method', 'headers', 'body', 'timeoutMs'].includes(key))) throw new Error('HTTP 参数包含未知字段');
  if (typeof args.url !== 'string' || !args.url || args.url.length > 16 * 1024) throw new Error('HTTP url 必须为有效 URL');
  let url: URL;
  try { url = new URL(args.url); } catch { throw new Error('HTTP url 必须为有效 URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
    /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(args.url) || url.hash || args.url.includes('#')) {
    throw new Error('HTTP 仅允许 http/https URL，禁止 URL 认证信息和片段');
  }
  const method = args.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') throw new Error('HTTP method 仅允许 GET 或 POST');
  const timeoutMs = args.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 60_000) throw new Error('HTTP timeoutMs 必须为 1 至 60000 的整数');
  const headers: Record<string, string> = Object.create(null);
  if (args.headers !== undefined) {
    if (!args.headers || typeof args.headers !== 'object' || Array.isArray(args.headers)) throw new Error('HTTP headers 必须为字符串映射');
    const entries = Object.entries(args.headers);
    if (entries.length > 128 || Buffer.byteLength(JSON.stringify(args.headers)) > 32 * 1024) throw new Error('HTTP headers 超过大小限制');
    for (const [name, raw] of entries) {
      const lower = name.toLowerCase();
      if (typeof raw !== 'string' || Object.hasOwn(headers, lower)) throw new Error('HTTP headers 必须为字符串且名称不得重复');
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection'].includes(lower)) {
        throw new Error('HTTP 路由及传输头由程序管理');
      }
      try { validateHeaderName(name); validateHeaderValue(name, raw); }
      catch { throw new Error('HTTP header 名称或值非法'); }
      headers[lower] = raw;
    }
  }
  const body = Object.hasOwn(args, 'body') ? Buffer.from(JSON.stringify(args.body), 'utf8') : Buffer.alloc(0);
  if (body.length > HTTP_REQUEST_LIMIT) throw new Error('HTTP JSON 请求体超过 256 KiB');
  headers.accept ??= 'application/json';
  headers['accept-encoding'] ??= 'identity';
  if (body.length) headers['content-type'] ??= 'application/json';
  return { url, method, headers, body, timeoutMs: timeoutMs as number };
}

export function initialHttpExchange(input: HttpInput, transport: 'local' | 'ssh'): HttpExchange {
  const excluded = new Set(['accept', 'accept-encoding', 'content-type', 'x-xloom-agent', 'x-xloom-backend']);
  const entries = Object.entries(input.headers).filter(([name]) => !excluded.has(name)).sort(([a], [b]) => a.localeCompare(b));
  const sentHeaders = { ...input.headers, 'content-length': String(input.body.length), host: input.url.host, connection: 'close' };
  // Credential equivalence excludes transport/formatting headers. Echo checks
  // still need hashes of every actually supplied/defaulted request header.
  const requestHeaderHashes = Object.fromEntries(Object.entries(sentHeaders).sort(([a], [b]) => a.localeCompare(b)).map(([name, val]) => [name, sha256(val)]));
  return {
    version: 1, transport, url: input.url.href, method: input.method, status: null,
    startedAt: new Date().toISOString(), endedAt: '', complete: false, outcome: 'not_started',
    requestHeaderHashes, credentialFingerprint: sha256(JSON.stringify(entries)),
    requestBodySha256: sha256(input.body), responseBodySha256: sha256(''),
  };
}

/** One native request. HTTP denial is an observation; transport failure never becomes success. */
export async function executeHttp(command: string, signal?: AbortSignal): Promise<HttpObservation> {
  const input = parseHttpCommand(command);
  const exchange = initialHttpExchange(input, 'local');
  const sentHeaders = { ...input.headers, 'content-length': String(input.body.length), host: input.url.host, connection: 'close' };
  return new Promise<HttpObservation>((resolve, reject) => {
    let req: ClientRequest | undefined, response: IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false, submitted = false, length = 0;
    const chunks: Buffer[] = [];
    const finish = (reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const responseBody = Buffer.concat(chunks, length);
      exchange.endedAt = new Date().toISOString(); exchange.responseBodySha256 = sha256(responseBody);
      if (reason) {
        exchange.outcome = submitted ? 'unknown' : 'not_started';
        req?.destroy(); response?.destroy();
        reject(new HttpExecutionError(reason, { ...exchange }, input.body, responseBody));
      } else {
        exchange.complete = true; exchange.outcome = 'completed';
        resolve({ text: JSON.stringify({ exchange, responseBody: responseBody.toString('utf8') }), exchange: { ...exchange }, requestBody: input.body, responseBody });
      }
    };
    const abort = () => finish('HTTP 操作已取消；保留已取得资料，目标结果未知');
    if (signal?.aborted) { finish('HTTP 操作在发送前已取消'); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish('HTTP 操作超时；未自动重试，目标结果未知'), input.timeoutMs);
    try {
      req = (input.url.protocol === 'https:' ? httpsRequest : httpRequest)(input.url, {
        method: input.method, headers: sentHeaders,
        agent: false, maxHeaderSize: 32 * 1024,
      }, incoming => {
        response = incoming;
        if (settled) { incoming.destroy(); return; }
        exchange.status = incoming.statusCode ?? null;
        incoming.on('data', (data: Buffer) => {
          if (settled) return;
          const chunk = Buffer.from(data), available = HTTP_RESPONSE_LIMIT - length;
          if (chunk.length > available) {
            if (available) { chunks.push(chunk.subarray(0, available)); length += available; }
            finish('HTTP 响应超过 1 MiB；已保存前缀，响应不完整且不可确认');
          } else { chunks.push(chunk); length += chunk.length; }
        });
        incoming.on('error', () => finish('HTTP 响应传输失败；保留部分资料，目标结果未知'));
        incoming.on('aborted', () => finish('HTTP 响应提前中断；保留部分资料，目标结果未知'));
        incoming.on('end', () => incoming.complete ? finish() : finish('HTTP 响应不完整；目标结果未知'));
      });
      req.on('error', () => finish('HTTP 请求传输失败；未自动重试，目标结果未知'));
      submitted = true;
      req.end(input.body);
    } catch {
      finish('HTTP 请求未能正常发送；未自动重试');
    }
  });
}
