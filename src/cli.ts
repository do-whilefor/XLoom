#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from './cli-args.js';
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const help = `XLoom ${version} — M6 · 五类提供商 / 三种协议 / 六工具 / 路径与报告\n\n用法：xloom | xloom -c | xloom -r [完整会话 ID]\n      xloom --help | xloom --version\n\nxloom 始终新建；-c 继续当前目录最近实际工作；-r 选择整个调查。\n恢复后等待输入，不重放历史工具。模型配置：~/.xloom/config.json\n模型和思考配置在启动时生效；修改后退出重启，可用 -c 继续。\n调查结果自动保存至会话目录 results/report.md。\n可用命令：/help /resume /compact [保留重点] /status /exit\n快捷键：Enter 提交，Esc 暂停，Ctrl+O 工具，Ctrl+T 思考，Ctrl+C 清空/双击退出\n`;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help') process.stdout.write(help);
  else if (options.mode === 'version') process.stdout.write(`xloom ${version}\n`);
  else { const { startApp } = await import('./app.js'); await startApp(options as import('./app.js').StartMode); }
} catch (error) {
  process.stderr.write(`XLoom：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
}
