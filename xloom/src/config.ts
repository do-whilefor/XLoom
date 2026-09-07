import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveCapabilities, protocolBaseUrl, providerDefaults, resolveThinking } from './runtime/models.js';

export const xloomHome = () => join(homedir(), '.xloom');
export type Provider = 'glm' | 'kimi' | 'deepseek' | 'anthropic' | 'openai';
export type LlmApi = 'openai-completions' | 'anthropic-messages' | 'openai-responses';
export type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelConfig {
  provider: Provider; id: string; apiKey: string; thinking?: string; baseUrl?: string; api?: LlmApi;
  contextWindow?: number; maxOutputTokens?: number;
}
export interface ModelInfo { readonly provider: Provider; readonly id: string; readonly api?: LlmApi; readonly thinking?: Thinking }
export interface ActiveConfig extends ModelInfo {
  readonly api: LlmApi; readonly apiKey: string; readonly baseUrl: string;
  readonly contextWindow: number; readonly maxOutputTokens: number;
  readonly limits: { readonly maxRunsPerCycle: number; readonly maxToolCallsPerRun: number };
  /** Startup snapshot; validated only when the remote tool is actually used. */
  readonly kali?: unknown;
}
export interface KaliConfig { host: string; port: number; username: string; password: string }
export function parseKaliConfig(value: unknown): KaliConfig {
  const fail = () => new Error('请在 ~/.xloom/config.json 配置 kali.host、port（默认 22）、username、password，然后退出重启；/resume 不重载配置');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const k = value as Record<string, unknown>;
  for (const field of ['host', 'username', 'password']) if (typeof k[field] !== 'string' || !(k[field] as string).trim() || (k[field] as string).includes('\0')) throw fail();
  const port = k.port ?? 22;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw fail();
  return { host: (k.host as string).trim(), port: Number(port), username: k.username as string, password: k.password as string };
}
export function configSecrets(config: ActiveConfig): string[] {
  const k = config.kali as { password?: unknown } | undefined;
  return [config.apiKey, ...(typeof k?.password === 'string' ? [k.password] : [])];
}
export const exampleConfig = {
  model: 'glm-main',
  models: { 'glm-main': { provider: 'glm', api: 'anthropic-messages', id: 'glm-5.3-flash',
    apiKey: '<填写你的 API Key>', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    thinking: 'high', maxOutputTokens: 16384 },
    'glm-standard': { provider: 'glm', id: 'glm-5.3-flash', apiKey: '<填写 GLM API Key>' },
    'kimi-main': { provider: 'kimi', id: 'kimi-k3', apiKey: '<填写 Kimi API Key>', contextWindow: '<填写已确认的上下文容量>', thinking: 'high' },
    'deepseek-main': { provider: 'deepseek', id: 'deepseek-v4-flash', apiKey: '<填写 DeepSeek API Key>', thinking: 'high' },
    'claude-main': { provider: 'anthropic', id: 'claude-sonnet-4-6', apiKey: '<填写 Anthropic API Key>', thinking: 'high' },
    'codex-main': { provider: 'openai', id: 'gpt-5.4', apiKey: '<填写 OpenAI API Key>', thinking: 'high' },
  },
  limits: { maxRunsPerCycle: 40, maxToolCallsPerRun: 50 },
  kali: { host: '192.168.1.100', port: 22, username: 'kali', password: '<填写 Kali SSH 密码；不使用时删除 kali 段>' },
};
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}
export function parseConfig(value: unknown): ActiveConfig {
  const root = object(value, 'config');
  if (typeof root.model !== 'string' || !root.model.trim()) throw new Error('config.model 必须指定活动配置别名');
  const models = object(root.models, 'config.models');
  const prefix = `models.${root.model}`;
  const selected = object(models[root.model], prefix);
  for (const field of Object.keys(selected)) if (!['provider', 'id', 'apiKey', 'thinking', 'baseUrl', 'api', 'contextWindow', 'maxOutputTokens'].includes(field)) throw new Error(`${prefix}.${field} 未支持；模型配置不接受透传参数`);
  if (typeof selected.provider !== 'string' || !Object.hasOwn(providerDefaults, selected.provider)) throw new Error(`${prefix}.provider 仅支持 glm、kimi、deepseek、anthropic、openai`);
  const provider = selected.provider as Provider;
  if (typeof selected.id !== 'string' || !selected.id.trim() || selected.id.trim() !== selected.id || /[<>\u0000-\u001f]/.test(selected.id)) throw new Error(`${prefix}.id 必须填写完整的真实模型 ID，不允许占位符或首尾空白`);
  const id = selected.id;
  const api = selected.api === undefined ? providerDefaults[provider].api : selected.api;
  if (!['openai-completions', 'anthropic-messages', 'openai-responses'].includes(String(api))) throw new Error(`${prefix}.api 仅支持 openai-completions、anthropic-messages、openai-responses`);
  const defaultBaseUrl = protocolBaseUrl(provider, api as LlmApi);
  if (!defaultBaseUrl) throw new Error(`${prefix}.api：provider=${provider} 与 ${String(api)} 的组合尚未实现`);
  if (typeof selected.apiKey !== 'string' || !selected.apiKey.trim() || /[<>]/.test(selected.apiKey)) throw new Error(`${prefix}.apiKey 尚未填写有效密钥`);
  if (selected.apiKey.trim().startsWith('!') || /[\u0000-\u001f]/.test(selected.apiKey)) throw new Error(`${prefix}.apiKey 必须是字面密钥；不执行命令或读取其他凭据`);
  const capabilities = effectiveCapabilities({ provider, api: api as LlmApi, id });
  const thinking = selected.thinking;
  if (thinking !== undefined && (typeof thinking !== 'string' || !capabilities.thinking.allowed.includes(thinking as Thinking))) {
    throw new Error(`${prefix}.thinking ${capabilities.thinking.allowed.length ? `仅支持 ${capabilities.thinking.allowed.join('、')}` : '未知模型没有已确认的映射，必须省略'}；不自动替换思考档位`);
  }
  const baseUrl = selected.baseUrl === undefined ? defaultBaseUrl : selected.baseUrl;
  if (typeof baseUrl !== 'string') throw new Error(`${prefix}.baseUrl 必须是 URL`);
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error(`${prefix}.baseUrl 不是有效 URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${prefix}.baseUrl 必须是不含认证信息或查询参数的 HTTP(S) URL`);
  const capacity = (field: string, fallback?: number, upper?: number) => {
    const n = selected[field] === undefined ? fallback : selected[field];
    if (n === undefined) throw new Error(`${prefix}.${field} 缺少已确认容量，必须显式填写正整数`);
    if (!Number.isSafeInteger(n) || Number(n) < 1 || (upper !== undefined && Number(n) > upper)) throw new Error(`${prefix}.${field} 必须为正整数${upper === undefined ? '' : `且不能超过已知上限 ${upper}`}`);
    return Number(n);
  };
  const contextWindow = capacity('contextWindow', capabilities.contextWindow, capabilities.maxContextWindow);
  const maxOutputTokens = capacity('maxOutputTokens', capabilities.defaultMaxOutputTokens, capabilities.maxOutputTokens);
  const rawLimits = root.limits === undefined ? {} : object(root.limits, 'limits');
  for (const key of Object.keys(rawLimits)) if (!['maxRunsPerCycle', 'maxToolCallsPerRun'].includes(key)) throw new Error(`未知 limits 字段：${key}`);
  const limit = (key: string, fallback: number) => {
    const n = rawLimits[key] ?? fallback;
    if (!Number.isSafeInteger(n) || Number(n) < 1) throw new Error(`limits.${key} 必须是正整数`);
    return Number(n);
  };
  if (maxOutputTokens >= contextWindow) throw new Error(`${prefix}.maxOutputTokens 必须小于 contextWindow`);
  const active: ActiveConfig = { provider, id, api: api as LlmApi,
    apiKey: selected.apiKey.trim(), baseUrl: baseUrl.replace(/\/+$/, ''),
    ...(thinking === undefined ? {} : { thinking: thinking as Thinking }), contextWindow, maxOutputTokens,
    limits: { maxRunsPerCycle: limit('maxRunsPerCycle', 40), maxToolCallsPerRun: limit('maxToolCallsPerRun', 50) },
    ...(root.kali !== undefined ? { kali: structuredClone(root.kali) } : {}) };
  try { resolveThinking(active); } catch (error) { throw new Error(`${prefix}.${(error as Error).message}`); }
  return deepFreeze(active);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function loadConfig(home = xloomHome()): ActiveConfig {
  const path = join(home, 'config.json');
  if (!existsSync(path)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(exampleConfig, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    throw new Error(`已生成配置模板：${path}。请填写 models.glm-main.apiKey 后重新启动。`);
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`无法读取有效的 JSON 配置：${path}（请检查语法和读取权限）`); }
  return parseConfig(raw);
}
export const publicModelInfo = (config: ModelInfo): ModelInfo => ({ provider: config.provider, id: config.id,
  ...(config.api === undefined ? {} : { api: config.api }), ...(config.thinking === undefined ? {} : { thinking: config.thinking }) });
