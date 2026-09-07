import { Type } from 'typebox';
import type { AgentTool } from '../vendor/pi/agent/types.js';

export const CHROME_HELP = `chrome command = 操作名 + 可选完整 JSON 对象；一调用一操作。
工具参数示例：{"command":"pages"}。command 的值是 pages，不要再次编码成 {"command":"pages"} 字符串。
help | pages | snapshot
select {"id":页面ID} | open {"url":"https://..."}（新建标签页）
click {"uid":"最新快照元素ID"} | fill {"uid":"元素ID","value":"文本"}
network {"page":0,"limit":20}（limit 最大 100；page 是请求分页）
request {"id":请求ID}（读取已有记录，不重发；请求时间可能不可取得）
eval {"expression":"document.title"}（仅页面表达式，可产生副作用）
screenshot {"fullPage":false}（本机证据路径由程序生成）
先 pages 后 select，或 open；页面操作需明确选择。切换/恢复后重新 pages/select/snapshot。
共用用户现有 stable Chrome Profile，不自动换身份；Chrome 144+，chrome://inspect/#remote-debugging 启用并允许浏览器授权。
网络只覆盖后端可观察记录；旧请求和截图不单独算 Proof 新实验。`;
export const CHROME_OPERATIONS = ['help', 'pages', 'select', 'open', 'snapshot', 'click', 'fill', 'network', 'request', 'eval', 'screenshot'] as const;
export type ChromeOperation = typeof CHROME_OPERATIONS[number];
export interface ChromeCommand { operation: ChromeOperation; args: Record<string, any> }
export function parseChromeCommand(command: string): ChromeCommand {
  if (typeof command !== 'string') throw new Error('chrome.command 必须为字符串');
  const match = /^\s*([a-z]+)(?:\s+([\s\S]*))?\s*$/.exec(command);
  if (!match || !CHROME_OPERATIONS.includes(match[1] as ChromeOperation)) throw new Error('未知 Chrome 操作；command 的值必须以操作名开头，例如 pages、help 或 open {"url":"https://example.test"}。不要只传 JSON，也不要把外层 {"command":...} 再编码成字符串。');
  const operation = match[1] as ChromeOperation;
  let args: Record<string, any> = {};
  if (match[2]?.trim()) {
    try { args = JSON.parse(match[2]); } catch { throw new Error('操作参数必须是一个完整 JSON 对象；不支持 shell 或多操作串接'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Chrome 参数必须是 JSON 对象');
  }
  const keys: Record<ChromeOperation, string[]> = { help: [], pages: [], select: ['id'], open: ['url'], snapshot: [], click: ['uid'], fill: ['uid','value'], network: ['page','limit'], request: ['id'], eval: ['expression'], screenshot: ['fullPage'] };
  if (Object.keys(args).some((key) => !keys[operation].includes(key))) throw new Error(`${operation} 有未支持的参数；用 chrome help 查看`);
  const str = (key: string, empty = false) => { if (typeof args[key] !== 'string' || (!empty && !args[key].trim()) || args[key].includes('\0')) throw new Error(`${operation}.${key} 必须是${empty ? '' : '非空'}字符串`); };
  if (['select','request'].includes(operation) && (!Number.isSafeInteger(args.id) || args.id < (operation === 'request' ? 1 : 0))) throw new Error(`${operation}.id 必须是实际返回的整数 ID`);
  if (operation === 'open') { str('url'); let u: URL; try { u = new URL(args.url); } catch { throw new Error('open.url 必须为完整 URL'); }
    if (!['http:','https:','about:'].includes(u.protocol) || (u.protocol === 'about:' && args.url !== 'about:blank')) throw new Error('open 支持 http/https/about:blank URL'); }
  if (operation === 'click' || operation === 'fill') str('uid');
  if (operation === 'fill') str('value', true);
  if (operation === 'eval') str('expression');
  if (operation === 'network') {
    args.page ??= 0; args.limit ??= 20;
    if (!Number.isSafeInteger(args.page) || args.page < 0 || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) throw new Error('network.page 必须为非负整数，limit 必须为 1 至 100');
  }
  if (operation === 'screenshot') { args.fullPage ??= false; if (typeof args.fullPage !== 'boolean') throw new Error('screenshot.fullPage 必须为布尔值'); }
  return { operation, args };
}
export function createChromeTool(execute?: AgentTool<any>['execute']): AgentTool<any> {
  return { name: 'chrome', label: 'Chrome · 用户已有浏览器', description: '操作用户已有 Chrome。command 为操作名 + JSON 对象：help/pages/select/open/snapshot/click/fill/network/request/eval/screenshot。用 help 查看参数。先明确页面；旧网络记录不是新实验。',
    parameters: Type.Object({ command: Type.String({ description: '操作字符串，例如 pages、help、open {"url":"https://example.test"}、eval {"expression":"document.title"}。值以操作名开头，不是单独的 JSON，也不包含外层 command 包装。' }) }, { additionalProperties: false }),
    execute: execute ?? (async (_id, args) => { if (parseChromeCommand((args as { command: string }).command).operation === 'help') return { content: [{ type:'text', text: CHROME_HELP }], details: {} }; throw new Error('Chrome 需要活动 Case Run 绑定来源'); }) };
}
