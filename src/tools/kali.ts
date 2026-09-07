import { Type } from 'typebox';
import type { AgentTool } from '../vendor/pi/agent/types.js';
export function createKaliTool(execute?: AgentTool<any>['execute']): AgentTool<any> {
  return { name: 'kali', label: 'Kali · 远程 SSH', description: '在配置的 Kali 上执行远程 command；cwd 是远程目录。每调用独立非交互 exec，不继承 cd/export。返回 stdout/stderr、退出码和信号，无需追加命令获取退出码。本机保存输出；远程文件不自动下载。timeoutMs 默认 60000。需要可核对HTTP时，command用 xloom-http {"url":"实际URL","method":"GET","headers":{}}：由固定Python3标准库程序在远端实际请求一次，无重定向、无重试或安装。localhost指远端；旧curl/stdout不自动成为原生HTTP记录。',
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String({ minLength: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })) }, { additionalProperties: false }),
    execute: execute ?? (async () => { throw new Error('Kali 需要活动 Case Run 绑定来源'); }) };
}
