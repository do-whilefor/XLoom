import type { StartMode } from './app.js';
import { validSessionId } from './session/store.js';
export function parseArgs(args: string[]): StartMode | { mode: 'help' | 'version' } {
  if (!args.length) return { mode: 'new' };
  if (args.length === 1) {
    if (args[0] === '--help') return { mode: 'help' };
    if (args[0] === '--version') return { mode: 'version' };
    if (args[0] === '-c') return { mode: 'continue' };
    if (args[0] === '-r') return { mode: 'pick' };
  }
  if (args.length === 2 && args[0] === '-r' && validSessionId(args[1])) return { mode: 'resume', id: args[1] };
  throw new Error('未支持或互斥的参数；用法：xloom | xloom -c | xloom -r [完整会话 ID] | --help | --version');
}
