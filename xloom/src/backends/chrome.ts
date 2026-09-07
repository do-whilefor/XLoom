import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ExternalDetails } from '../case/types.js';
import type { ChromeCommand, ChromeOperation } from '../tools/chrome.js';
import { ToolArtifacts, ArtifactStream } from '../tools/artifacts.js';
import { mkdirSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { abortable, BackendError } from './common.js';

export const CHROME_VERSION = '1.8.0';
export const CHROME_ARGS = ['--autoConnect', '--channel=stable', '--pageIdRouting=true', '--experimental-structured-content=true', '--no-usage-statistics', '--no-performance-crux', '--redact-network-headers=true'];
export const CHROME_MAPPING = { pages: 'list_pages', select: 'select_page', open: 'new_page', snapshot: 'take_snapshot', click: 'click', fill: 'fill', network: 'list_network_requests', request: 'get_network_request', eval: 'evaluate_script', screenshot: 'take_screenshot' } as const;
export interface McpResult { content: Array<{ type: string; text?: string; [key: string]: unknown }>; structuredContent?: Record<string, any>; isError?: boolean }
export interface ChromeConnection {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpResult>;
  close(): Promise<void>;
  onDisconnect?: () => void;
  readonly pid?: number | null;
}
export type ChromeConnector = (signal: AbortSignal) => Promise<ChromeConnection>;
export function stdioChromeConnector(home: string, sessionId: string, secrets: string[]): ChromeConnector {
  return async (signal) => {
    signal.throwIfAborted();
    const env = getDefaultEnvironment();
    for (const key of ['DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY']) if (process.env[key]) env[key] = process.env[key]!;
    env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = '1'; env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = '1';
    const binary = join(dirname(createRequire(import.meta.url).resolve('chrome-devtools-mcp')), 'bin/chrome-devtools-mcp.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [binary, ...CHROME_ARGS], env, stderr: 'pipe' });
    const client = new Client({ name: 'xloom', version: '0.5.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(join(home, 'sessions', sessionId, 'artifacts')).href, name: 'XLoom Evidence' }] }));
    const logs = join(home, 'logs'); mkdirSync(logs, { recursive: true, mode: 0o700 });
    const diagnostic = new ArtifactStream(join(logs, `chrome-${sessionId}-${randomUUID()}.log`), secrets);
    let diagnosticError: unknown;
    const connection: ChromeConnection = {
      get pid() { return transport.pid; },
      call: async (name, args, sig) => {
        if (diagnosticError) throw diagnosticError;
        return await client.callTool({ name, arguments: args }, undefined, { signal: sig, timeout: 60_000 }) as McpResult;
      },
      close: async () => { try { await client.close(); } finally { diagnostic.close(); } },
    };
    client.onclose = () => connection.onDisconnect?.();
    transport.stderr?.on('data', (b: Buffer) => { try { diagnostic.write(b); } catch (e) { diagnosticError = e; void client.close(); } });
    try {
      await abortable(client.connect(transport), signal);
      const list = await client.listTools({}, { signal, timeout: 60_000 });
      for (const name of Object.values(CHROME_MAPPING)) {
        const tool = list.tools.find((t) => t.name === name);
        if (!tool) throw new Error(`固定 Chrome 后端缺少 ${name}`);
        if (!['list_pages', 'select_page','new_page'].includes(name) && !tool.inputSchema.properties?.pageId) throw new Error(`${name} 未提供固定 pageId 参数`);
      }
      if (diagnosticError) throw diagnosticError;
      signal.throwIfAborted(); return connection;
    } catch (e) { await connection.close(); throw e; }
  };
}
export interface ChromePage { id: number; title: string; url: string; selected?: boolean }
export class ChromeBackend {
  state: 'disconnected' | 'connected' | 'error' = 'disconnected';
  error?: string;
  selected?: ChromePage;
  connectionId?: string;
  private connection?: ChromeConnection;
  private connecting?: Promise<ChromeConnection>;
  private pages = new Map<number, ChromePage>();
  private uids = new Set<string>();
  get pid() { return this.connection?.pid; }
  constructor(private readonly connector: ChromeConnector) {}
  private resetHandles() { this.selected = undefined; this.pages.clear(); this.uids.clear(); }
  private async connect(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.connection && this.state !== 'error') return this.connection;
    if (this.connecting) return abortable(this.connecting, signal);
    this.resetHandles();
    const promise = this.connector(signal); this.connecting = promise;
    try {
      const connection = await promise; signal.throwIfAborted();
      this.connection = connection; this.connectionId = randomUUID(); this.error = undefined;
      connection.onDisconnect = () => {
        if (this.connection !== connection) return;
        this.state = 'error'; this.error = 'Chrome 后端断开；需新调用重新观察'; this.connection = undefined; this.resetHandles();
      };
      return connection;
    } finally { if (this.connecting === promise) this.connecting = undefined; }
  }
  async execute(command: ChromeCommand, files: ToolArtifacts, signal: AbortSignal): Promise<{ details: ExternalDetails; text: string }> {
    const { operation, args } = command;
    let submitted = false;
    let source: ExternalDetails = { backend: 'chrome', operation, outcome: 'not_started', status: 'error', retrievedAt: new Date().toISOString() };
    const fail = (message: string) => { throw new BackendError(message, { ...source, error: message }); };
    if (operation === 'help') fail('help 是本地说明，不调用后端');
    if (operation === 'select' && !this.pages.has(args.id)) fail('请先 pages 获取当前连接页面列表，再 select 实际 ID；历史 ID 不能直接复用');
    if (!['pages','select','open'].includes(operation) && !this.selected) fail('尚未选择页面；请先 pages/select 或 open');
    if (['click','fill'].includes(operation) && !this.uids.has(args.uid)) fail('元素不在当前页面最新 snapshot 中；请重新 snapshot，不自动重试动作');
    try {
      const connection = await this.connect(signal); signal.throwIfAborted();
      source = { ...source, connectionId: this.connectionId, ...(this.selected ? { pageId: this.selected.id, pageUrl: this.selected.url, pageTitle: this.selected.title } : {}) };
      let params: Record<string, unknown> = {};
      if (operation === 'select') params = { pageId: args.id, bringToFront: false };
      if (operation === 'open') params = { url: args.url, timeout: 55_000 };
      if (!['pages','select','open'].includes(operation)) params.pageId = this.selected!.id;
      if (operation === 'snapshot') params.filePath = files.path('snapshot.txt');
      if (operation === 'click' || operation === 'fill') params.uid = args.uid;
      if (operation === 'fill') params.value = args.value;
      if (operation === 'network') Object.assign(params, { pageIdx: args.page, pageSize: args.limit, includePreservedRequests: false });
      // MCP 1.8.0 enforces these suffixes in saveFile; .txt would be renamed by the backend.
      if (operation === 'request') Object.assign(params, { reqid: args.id, requestFilePath: files.path('request-body.network-request'), responseFilePath: files.path('response-body.network-response') });
      if (operation === 'eval') Object.assign(params, { function: `async () => (\n${args.expression}\n)`, filePath: files.path('evaluation.json') });
      if (operation === 'screenshot') Object.assign(params, { fullPage: args.fullPage, format: 'png', filePath: files.path('screenshot.png') });
      if (['select','open','click','fill','eval','snapshot'].includes(operation)) this.uids.clear();
      submitted = true;
      const result = await abortable(connection.call(CHROME_MAPPING[operation as Exclude<ChromeOperation,'help'>], params, signal), signal);
      files.save('backend-result.json', result);
      const text = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      files.save('backend-result.txt', text);
      const structured = result.structuredContent ?? {};
      if (structured.reconnected) throw new BackendError('Chrome 后端报告重新连接；句柄已失效，当前外部结果未知，暂停并重新观察', { ...source, outcome: 'unknown', status: 'error', fatal: true });
      if (result.isError) {
        const fatal = /(?:connect|connection|remote.debugg|chrome:\/\/inspect|browser.*(?:not.*running|closed)|Could not find.*Chrome|Protocol error|timed?\s*out|timeout)/i.test(text);
        const notStarted = /Could not connect to Chrome|Could not find DevToolsActivePort|Could not find.*Chrome/i.test(text);
        throw new BackendError(text, { ...source, status: 'error', outcome: notStarted ? 'not_started' : fatal ? 'unknown' : 'completed', fatal, error: text });
      }
      if (structured.pages !== undefined) {
        if (!Array.isArray(structured.pages) || structured.pages.some((p: any) => !Number.isInteger(p.id) || typeof p.url !== 'string' || typeof p.title !== 'string')) throw new Error('Chrome 固定页面返回格式不符');
        this.pages = new Map(structured.pages.map((p: ChromePage) => [p.id, p]));
      }
      if (operation === 'select' || operation === 'open') {
        const selected = structured.pages?.find((p: ChromePage) => p.selected && (operation === 'open' || p.id === args.id));
        if (!selected) throw new Error('后端未返回实际选中的页面 ID');
        this.selected = { ...selected };
      }
      if (operation === 'pages' && this.selected) {
        const current = this.pages.get(this.selected.id);
        if (!current || current.url !== this.selected.url) this.uids.clear();
        this.selected = current ? { ...current } : undefined;
      }
      if (this.selected) source = { ...source, pageId: this.selected.id, pageUrl: this.selected.url, pageTitle: this.selected.title };
      let output = text;
      if (operation === 'snapshot') {
        files.register('snapshot.txt'); output = files.previewFile('snapshot.txt');
        // Keep identifiers from the full latest snapshot, including read-backed rows.
        const input = createReadStream(files.path('snapshot.txt'));
        try {
          for await (const line of createInterface({ input, crlfDelay: Infinity })) {
            signal.throwIfAborted(); const uid = /\buid=([^\s]+)/.exec(line); if (uid) this.uids.add(uid[1]);
          }
        } finally { input.destroy(); }
        const url = /RootWebArea\s+"([^"]*)"\s+url="([^"]*)"/.exec(output);
        if (url && this.selected) { this.selected = { ...this.selected, title: url[1], url: url[2] }; source.pageTitle = url[1]; source.pageUrl = url[2]; }
      }
      if (operation === 'eval') { files.register('evaluation.json'); output = files.previewFile('evaluation.json'); }
      if (operation === 'screenshot') { const path = files.register('screenshot.png'); output = `截图已保存：${path}；需要图像时用 read，页面结构优先用 snapshot。`; }
      if (operation === 'network') {
        source.pagination = structured.pagination ?? null;
        output = JSON.stringify({ requests: structured.networkRequests ?? [], pagination: source.pagination, requestedPage: args.page, limit: args.limit });
      }
      if (operation === 'request') {
        const req = structured.networkRequest;
        if (!req || req.requestId !== args.id) throw new Error('后端未返回对应请求详情');
        const requestBody = files.available('request-body.network-request'), responseBody = files.available('response-body.network-response');
        Object.assign(source, { requestId: args.id, requestUrl: req.url, requestTime: null, httpStatus: req.status,
          requestBodyAvailable: !!requestBody, responseBodyAvailable: !!responseBody, historical: true });
        output = JSON.stringify({ requestId: args.id, url: req.url, method: req.method, status: req.status,
          requestTime: '后端未提供', retrievedAt: source.retrievedAt,
          requestBody: requestBody ?? req.requestBody ?? '不可取得', responseBody: responseBody ?? req.responseBody ?? '不可取得', failure: req.failure,
          note: '本次只读取已有请求记录，没有重新发送请求；认证头只保存在所选原始资料，不进入摘要。' });
      }
      this.state = 'connected';
      return { details: { ...source, outcome: 'completed', status: 'observed' }, text: output };
    } catch (e) {
      const err = e instanceof BackendError ? e : new BackendError(e instanceof Error ? e.message : String(e), { ...source, outcome: submitted ? 'unknown' : 'not_started', status: signal.aborted ? 'interrupted' : 'error', fatal: true });
      if (signal.aborted) Object.assign(err.details, { status: 'interrupted', outcome: submitted ? 'unknown' : 'not_started', fatal: true });
      if (err.details.fatal) {
        await this.close(); this.state = 'error';
        if (err.details.outcome === 'not_started') err.message += '；检查 Chrome 144+ 与 chrome://inspect/#remote-debugging 浏览器授权';
        this.error = err.message; err.details.error = err.message;
      }
      throw err;
    }
  }
  async close() {
    const connection = this.connection; this.connection = undefined; this.resetHandles(); this.connectionId = undefined;
    this.state = 'disconnected'; this.error = undefined;
    if (connection) { connection.onDisconnect = undefined; await connection.close(); }
  }
}
