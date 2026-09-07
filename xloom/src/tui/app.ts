import type { ProbeAgent, RuntimeEvent } from '../runtime/agent.js';
import type { CaseLoop } from '../case/loop.js';
import { hideUpdateBlock } from '../case/update.js';
import { CombinedAutocompleteProvider } from '../vendor/pi/tui/autocomplete.js';
import type { AgentEvent } from '../vendor/pi/agent/types.js';
import type { AssistantMessage } from '../vendor/pi/ai/types.js';
import { AssistantMessageComponent } from '../vendor/pi/coding-agent/modes/interactive/components/assistant-message.js';
import { ToolExecutionComponent } from '../vendor/pi/coding-agent/modes/interactive/components/tool-execution.js';
import { getEditorTheme, theme } from '../vendor/pi/coding-agent/modes/interactive/theme/theme.js';
import { Container, Editor, Loader, matchesKey, ProcessTerminal, Spacer, Text, TUI, truncateToWidth, type Terminal } from '../vendor/pi/tui/index.js';
import { helpText, parseCommand, statusText } from './commands.js';
import { SessionPicker } from './session-picker.js';

export class XLoomTui {
  readonly ui: TUI;
  readonly editor: Editor;
  readonly timeline = new Container();
  readonly tools = new Map<string, ToolExecutionComponent>();
  readonly assistants: Array<{ component: AssistantMessageComponent; message: AssistantMessage }> = [];
  private readonly footer = new Text('', 1, 0);
  private readonly loading = new Container();
  private loader?: Loader;
  private readonly activeAssistants = new Map<string, { component: AssistantMessageComponent; message: AssistantMessage }>();
  private hideThinking = false;
  private expandedTools = false;
  private readonly completedTools = new Set<string>();
  private lastCtrlC = 0;
  private agent?: ProbeAgent | CaseLoop;
  private exit?: () => void;
  private closed = false;
  private resume?: () => Promise<void>;
  private selecting = false;
  private switching = false;
  private cancelPicker?: () => void;
  private readonly removeInputListener;

  constructor(readonly terminal: Terminal = new ProcessTerminal(), private readonly redact: (s: string) => string = (s) => s) {
    this.ui = new TUI(terminal, true);
    this.editor = new Editor(this.ui, getEditorTheme(), { paddingX: 1 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
      { name: 'help', description: '帮助' }, { name: 'status', description: '会话和黑板状态' }, { name: 'exit', description: '保存并退出' },
      { name: 'resume', description: '选择调查' }, { name: 'compact', description: '压缩当前或最近角色' },
    ], process.cwd()));
    this.ui.addChild(new Text(theme.bold(theme.fg('accent', 'XLoom')) + theme.fg('muted', '  M6 · Probe / Proof · 六工具'), 1, 1));
    this.ui.addChild(new Text('本机工作，依据真实结果继续。输入任务开始；/help 查看帮助。', 1, 0));
    this.ui.addChild(this.timeline);
    this.ui.addChild(this.loading);
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.editor);
    this.ui.addChild(this.footer);
    this.ui.setFocus(this.editor);
    this.editor.onSubmit = (text) => { void this.submit(text); };
    this.removeInputListener = this.ui.addInputListener((data) => {
      if (this.selecting) return undefined;
      if (matchesKey(data, 'escape')) { this.agent?.cancel(); return { consume: true }; }
      if (matchesKey(data, 'ctrl+o')) {
        this.expandedTools = !this.expandedTools;
        for (const tool of this.tools.values()) tool.setExpanded(this.expandedTools);
        this.ui.requestRender(); return { consume: true };
      }
      if (matchesKey(data, 'ctrl+t')) {
        this.hideThinking = !this.hideThinking;
        for (const item of this.assistants) {
          item.component.setHideThinkingBlock(this.hideThinking); item.component.updateContent(item.message);
        }
        this.ui.requestRender(); return { consume: true };
      }
      if (matchesKey(data, 'ctrl+c')) {
        const now = Date.now();
        if (now - this.lastCtrlC < 1000) this.exit?.();
        else { this.editor.setText(''); this.notice('再次按 Ctrl+C 退出'); }
        this.lastCtrlC = now;
        return { consume: true };
      }
      this.lastCtrlC = 0;
      return undefined;
    });
  }

  bind(agent: ProbeAgent | CaseLoop, exit: () => void, resume?: () => Promise<void>) { this.agent = agent; this.exit = exit; this.resume = resume; this.refreshStatus(); }
  chooseSession(home: string, cwd: string): Promise<string | undefined> {
    this.selecting = true;
    return new Promise((resolve) => {
      const done = (id?: string) => { handle.hide(); this.selecting = false; this.cancelPicker = undefined; resolve(id); };
      const picker = new SessionPicker(home, cwd, done, () => this.ui.requestRender());
      const handle = this.ui.showOverlay(picker, { width: '95%' });
      this.cancelPicker = () => done();
    });
  }
  restoreHistory(loop: CaseLoop) {
    for (const tool of this.tools.values()) tool.dispose();
    this.tools.clear(); this.completedTools.clear(); this.assistants.length = 0; this.activeAssistants.clear(); this.timeline.clear();
    const refs = loop.session.timeline;
    const display: Array<{ timestamp: string; show: () => void }> = refs.flatMap((e) => e.type === 'user' ? [{ timestamp: e.timestamp, show: () => this.notice(`你\n${e.content}`) }] : []);
    const controls: Record<string, string> = { resumed: '恢复', paused: '暂停', compact_started: '开始压缩', compact_completed: '压缩完成', compact_failed: '压缩失败', compact_cancelled: '取消压缩' };
    for (const entry of refs) if (entry.type === 'control' && controls[entry.action]) display.push({ timestamp: entry.timestamp,
      show: () => this.notice(`${controls[entry.action]}${entry.agent ? ` · ${entry.agent}` : ''}${entry.detail ? ` · ${entry.detail}` : ''}`) });
    for (const agent of loop.agents) {
      let runId: string | undefined;
      let responseRef: string | undefined;
      for (const entry of agent.persistence.getEntries()) {
        if (entry.type === 'custom' && entry.customType === 'xloom.capsule') runId = (entry.data as any).runId;
        if (entry.type !== 'message' || entry.message.role === 'user') continue;
        if (entry.message.role === 'assistant') responseRef = (entry.message as AssistantMessage & { xloomResponseId?: string }).xloomResponseId ?? entry.id;
        const message = entry.message, origin = { agent: agent.role, agentSessionId: agent.sessionId, runId, responseRef };
        display.push({ timestamp: entry.timestamp, show: () => {
          if (message.role === 'assistant') { this.onEvent({ type: 'message_start', message, ...origin }); this.onEvent({ type: 'message_end', message, ...origin }); }
          if (message.role === 'toolResult') this.onEvent({ type: 'tool_execution_end', toolCallId: message.toolCallId, toolName: message.toolName, result: { content: message.content, details: message.details }, isError: message.isError, ...origin });
        } });
      }
    }
    display.sort((a, b) => a.timestamp.localeCompare(b.timestamp)); for (const item of display) item.show();
    this.notice(`会话已恢复，等待输入\n${loop.session.metadata.title}\n目录：${loop.session.metadata.cwd}\nGoal：${loop.board.goal.request || '尚未输入'}\n结果：${loop.board.outcome} · ${loop.board.lastSummary || loop.board.reason}`);
    this.notice(loop.resultText);
  }
  start() { this.ui.start(); }
  notice(text: string) {
    this.timeline.addChild(new Text(this.redact(text), 1, 1));
    this.ui.requestRender();
  }
  async submit(text: string) {
    if (!text.trim() || !this.agent || this.closed) return;
    try {
      const command = parseCommand(text);
      if (this.switching && command !== 'exit') { this.notice('正在切换会话，请等待选择完成'); return; }
      if (command === 'help') this.notice(helpText);
      else if (command === 'status') this.notice(statusText(this.agent));
      else if (command === 'exit') this.exit?.();
      else if (command === 'compact') {
        const focus = text.replace(/^\/compact\s*/, '');
        if ('compact' in this.agent) await this.agent.compact(focus); else await this.agent.requestCompact(focus);
      }
      else if (command === 'resume') {
        if (!this.resume) throw new Error('当前运行入口不支持会话选择');
        this.switching = true; try { await this.resume(); } finally { this.switching = false; }
      }
      else {
        this.editor.addToHistory(text);
        if (this.agent.state !== 'idle') this.notice(`已排队：${text}`);
        await this.agent.submit(text);
      }
    } catch (error) { this.notice(`错误：${error instanceof Error ? error.message : String(error)}`); }
  }
  private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
    let component = this.tools.get(id);
    if (!component) {
      component = new ToolExecutionComponent(name, id, args, {}, this.ui, this.agent?.session.metadata.cwd ?? process.cwd());
      component.setExpanded(this.expandedTools);
      this.tools.set(id, component);
      this.timeline.addChild(component);
    }
    return component;
  }
  onEvent(event: AgentEvent & Partial<Pick<RuntimeEvent, 'agent' | 'agentSessionId' | 'runId' | 'responseRef'>>) {
    const runOrigin = event.runId ? `${event.agent}:${event.runId}:` : '';
    const origin = runOrigin + (event.responseRef ? `${event.responseRef}:` : '');
    const label = `${event.agent === 'proof' ? 'Proof' : 'Probe'}${event.runId ? ` · ${event.runId}` : ''}`;
    const key = (id: string) => origin + id;
    if (this.closed) return;
    if (event.type === 'message_start') {
      if (event.message.role === 'user') {
        const content = event.message.content;
        const text = typeof content === 'string' ? content : content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        this.timeline.addChild(new Text(theme.fg('accent', `你 → ${label}`) + '\n' + this.redact(text), 1, 1));
      } else if (event.message.role === 'assistant') {
        this.timeline.addChild(new Text(theme.fg('accent', label), 1, 0));
        const display = this.assistantDisplay(event.message);
        const item = { component: new AssistantMessageComponent(display, this.hideThinking), message: display };
        this.activeAssistants.set(origin, item);
        this.assistants.push(item);
        this.timeline.addChild(item.component);
      }
    }
    if ((event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
      const activeAssistant = this.activeAssistants.get(origin);
      if (activeAssistant) {
        // Scrub only a display copy; never edit signatures, reasoning or tool arguments in protocol history.
        const display = this.assistantDisplay(event.message);
        activeAssistant.message = display;
        activeAssistant.component.updateContent(display);
      }
      for (const block of event.message.content) if (block.type === 'toolCall') {
        const args = this.displayCopy(block.arguments);
        if (!this.tools.has(key(block.id))) this.timeline.addChild(new Text(theme.fg('muted', `${label} · ${block.name} · ${block.name === 'kali' ? '远程 SSH' : block.name === 'chrome' ? '已有 Chrome' : '本机'} · ${block.id}`), 1, 0));
        const tool = this.tool(key(block.id), block.name, args);
        tool.updateArgs(args);
        if (event.type === 'message_end') tool.setArgsComplete();
      }
      if (event.type === 'message_end' && event.message.stopReason === 'length') this.notice('达到模型输出上限，本次执行已暂停。');
    }
    if (event.type === 'tool_execution_start') this.tool(key(event.toolCallId), event.toolName, this.displayCopy(event.args)).markExecutionStarted();
    if (event.type === 'tool_execution_update') this.tools.get(key(event.toolCallId))?.updateResult({ ...this.displayCopy(event.partialResult), isError: false }, true);
    if (event.type === 'tool_execution_end') {
      this.completedTools.add(key(event.toolCallId));
      this.tool(key(event.toolCallId), event.toolName, {}).updateResult({ ...this.displayCopy(event.result), isError: event.isError });
    }
    if (event.type === 'agent_end') {
      for (const [id, tool] of this.tools) if (id.startsWith(runOrigin) && !this.completedTools.has(id)) {
        tool.updateResult({ content: [{ type: 'text', text: '本次响应中断或达到上限；该工具未执行。' }], isError: true });
        this.completedTools.add(id);
      }
    }
    this.refreshStatus();
    this.ui.requestRender();
  }
  private displayCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? this.redact(item) : item)) as T;
  }
  private assistantDisplay(message: AssistantMessage): AssistantMessage {
    const text = hideUpdateBlock(message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    let inserted = false;
    return { ...message, content: message.content.flatMap((b): AssistantMessage['content'] => {
      if (b.type === 'text') { if (inserted) return []; inserted = true; return [{ ...b, text: this.redact(text) }]; }
      if (b.type === 'thinking') return b.redacted ? [] : [{ type: 'thinking', thinking: this.redact(b.thinking) }];
      return [{ type: 'toolCall', id: b.id, name: b.name, arguments: this.displayCopy(b.arguments) }];
    }) };
  }
  refreshStatus() {
    if (!this.agent || this.closed) return;
    const agent = this.agent;
    if (agent.state !== 'idle' && !this.loader) {
      this.loader = new Loader(this.ui, (s) => theme.fg('accent', s), (s) => theme.fg('muted', s), 'Agent 正在工作');
      this.loading.addChild(this.loader);
    } else if (agent.state === 'idle' && this.loader) {
      this.loader.stop(); this.loader = undefined; this.loading.clear();
    }
    const tokens = agent.usage?.available.includes('totalTokens') ? ` · ${agent.usage.totalTokens} tokens${agent.usage.complete ? '' : '（不完整）'}` : ' · 用量不可用';
    const pending = agent.pendingInputs.length ? ` · 排队 ${agent.pendingInputs.length}` : '';
    const task = 'board' in agent ? ` · ${agent.currentRole ?? '等待'} ${agent.currentIntentId ?? ''} r${agent.board.revision} ${agent.board.outcome} · ${agent.activeAgent.compactPending ? agent.activeAgent.compactStatus : agent.stage}` : '';
    this.footer.setText(truncateToWidth(`${agent.model.id} · 思考 ${agent.session.metadata.model.thinking ?? '模型默认'} · ${agent.state}${task} · ${agent.session.metadata.id.slice(0, 8)}${tokens}${pending}`, Math.max(1, this.terminal.columns - 2)));
    this.ui.requestRender();
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.cancelPicker?.();
    this.loader?.stop();
    for (const tool of this.tools.values()) tool.dispose();
    this.removeInputListener();
    try { await this.terminal.drainInput(150, 30); } finally { this.ui.stop(); }
  }
}
