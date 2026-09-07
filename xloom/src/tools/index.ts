import { createReadTool, createWriteTool, createEditTool } from '../vendor/pi/coding-agent/core/tools/index.js';
import { createBashTool } from './bash.js';
import { createChromeTool } from './chrome.js';
import { createKaliTool } from './kali.js';
export function createTools(cwd: string) {
  return [createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd), createChromeTool(), createKaliTool()];
}
