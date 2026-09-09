import { createBashTool as createPiBashTool } from '../vendor/pi/coding-agent/core/tools/bash.js';
import { executeHttp, isHttpCommand } from './http.js';

/** Recognize only standalone, unambiguous placeholders, never parse arbitrary shell code.
 * Redirections, substitutions, arguments and compound scripts retain their Pi semantics.
 */
export function isBashNoop(command: string): boolean {
  const source = command.trim().replace(/;\s*$/, '').trim();
  if (!source) return true;
  if (/^(?:(?:builtin|command)\s+)?(?:(?:\/usr\/bin\/|\/bin\/)?true|:)$/.test(source)) return true;
  if (/^(?:echo(?:\s+(?:''|""))?|printf\s+(?:''|""))$/.test(source)) return true;
  const shell = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh)\s+-(?:c|lc)\s+(?:'([^']*)'|"([^"$`\\]*)"|(true|:))$/.exec(source);
  return !!shell && /^(?:true|:)\s*;?$/.test((shell[1] ?? shell[2] ?? shell[3]).trim());
}

export function createBashTool(...args: Parameters<typeof createPiBashTool>): ReturnType<typeof createPiBashTool> {
  const tool = createPiBashTool(...args);
  return { ...tool, description: tool.description + '\n仅执行有实际用途的本机命令；true、空命令等占位会在启动 shell 前拒绝。收尾直接输出最终 xloom-update 文本。\n需要可核对的HTTP观察时，command可用显式模式：xloom-http {"url":"http://...","method":"GET","headers":{"X-Test-Identity":"bob"}}。该模式由程序直接发送一个HTTP请求，不进入shell，不重试或跟随重定向；POST可附body JSON。普通curl/stdout不自动成为可信HTTP记录。',
    execute: (async (id, params, signal, onUpdate) => {
      signal?.throwIfAborted();
      if (isHttpCommand(params.command)) {
        const observed = await executeHttp(params.command, signal);
        return { content: [{ type: 'text', text: observed.text }], details: { http: observed.exchange, exitCode: 0 } };
      }
      if (isBashNoop(params.command)) {
        throw Object.assign(new Error('未执行：这是无实际观察的 bash 占位命令，未启动本机 shell，也没有生成 Evidence。已有足够材料时，请直接在最终文本输出完整 xloom-update JSON 代码块；工具调用不能提交黑板。若仍缺观察，请选择符合用户范围且有实际用途的操作。'),
          { details: { backend: 'local', status: 'not_executed', outcome: 'not_started', reasonCode: 'bash_noop' } });
      }
      return tool.execute(id, params, signal, onUpdate);
    }) as typeof tool.execute };
}
