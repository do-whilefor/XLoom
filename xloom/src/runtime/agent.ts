import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentRole } from '../case/types.js';
import { configSecrets, type ActiveConfig } from '../config.js';
import { SessionBackends } from '../backends/session.js';
import { createLogger, redactor } from '../log.js';
import type { Session } from '../session/store.js';
import { createTools } from '../tools/index.js';
import { runAgentLoop } from '../vendor/pi/agent/agent-loop.js';
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '../vendor/pi/agent/types.js';
import type { AssistantMessage, Message, UserMessage } from '../vendor/pi/ai/types.js';
import { isCapsule, type CapsuleMessage } from '../case/capsule.js';
import { createProvider, failedMessage, resolveModel } from './providers.js';
import { SessionManager } from './session.js';
import { projectForModel, requestBudget, type RequestBudget } from './context.js';
import { assertToolBoundary, compact, prepareRoleCompaction, retention } from './compaction.js';
import type { CompactionSettings } from '../vendor/pi/coding-agent/core/compaction/compaction.js';
import { AssistantMessageEventStream } from '../vendor/pi/ai/utils/event-stream.js';
import { combineUsageTotals, responseUsage, type RecordedResponse, type UsageTotals } from './usage.js';
export { combineUsageTotals, type UsageTotals, type UsageField } from './usage.js';

export type RunState = 'idle' | 'running' | 'cancelling';
export type RuntimeEvent = AgentEvent & { agent: AgentRole; agentSessionId: string; runId?: string; responseRef?: string };
export interface RuntimeOptions {
  config: ActiveConfig; session: Session; home: string; role?: AgentRole;
  stream?: StreamFn;
  compactionSettings?: Partial<CompactionSettings>;
  onEvent?: (event: RuntimeEvent) => void;
  onState?: () => void;
  backends?: SessionBackends;
}

export function createAgent(options: RuntimeOptions) { return new ProbeAgent(options); }

export class ProbeAgent {
  readonly role: AgentRole;
  readonly sessionId: string;
  readonly model;
  readonly tools;
  readonly backends: SessionBackends;
  readonly session;
  readonly messages: AgentMessage[] = [];
  readonly persistence;
  state: RunState = 'idle';
  usage: UsageTotals | undefined;
  private readonly usageResponses = new Map<string, UsageTotals>();
  private activeResponseRef?: string;
  lastError: string | undefined;
  lastResult?: { finalText: string; stopReason: AssistantMessage['stopReason']; aborted: boolean };
  private queued: UserMessage[] = [];
  private controller?: AbortController;
  private active?: Promise<void>;
  private closed = false;
  private readonly stream: StreamFn;
  private readonly log;
  private readonly redact;
  private readonly systemPrompt: string;
  private readonly inputIds = new WeakMap<object, string>();
  private readonly persisted = new WeakSet<object>();
  private caseRun?: { capsule: CapsuleMessage; tools: AgentTool<any>[]; delivered: (ids: string[], revision?: number) => void; refresh?: () => { content: string; revision: number }; toolAttempts: number; stop?: (reason: string) => void; responseRef?: string };
  private consumedIds: string[] = [];
  private readonly knownInputIds = new Set<string>();
  private inputRequestId?: string;
  private compactRequest?: { focus: string };
  private compactActive = false;
  private compactedAt?: string;
  private storageFailed = false;
  contextBudget?: RequestBudget;
  compactStatus = '';

  constructor(private readonly options: RuntimeOptions) {
    this.role = options.role ?? 'probe';
    const internal = options.session.ensureAgent(this.role);
    this.sessionId = internal.id;
    this.model = resolveModel(options.config);
    this.session = options.session;
    this.tools = createTools(options.session.metadata.cwd);
    this.backends = options.backends ?? new SessionBackends(options.config, options.home, options.session.metadata.id);
    this.persistence = SessionManager.open(internal.path);
    this.redact = redactor(...configSecrets(options.config));
    const logger = createLogger(options.home, this.session.metadata.id, this.redact);
    this.log = (event: string, error?: string, toolCallId?: string, tool?: string) => logger(event, error, { agent: this.role, agentSessionId: this.sessionId, runId: this.caseRun?.capsule.runId, ...(toolCallId ? { toolCallId, tool } : {}) });
    this.stream = this.recordStream(options.stream ?? createProvider(options.config));
    this.systemPrompt = ['common', this.role].map((name) => readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8')).join('\n\n')
      + `\n当前工作目录：${this.session.metadata.cwd}`;
    const entries = this.persistence.getEntries();
    const sourceIds = new Map(entries.flatMap((e) => e.type === 'custom' && e.customType === 'xloom.input-source' ? [[(e.data as any).messageId as string, (e.data as any).sourceMessageId as string] as const] : []));
    for (const e of entries) {
      if (e.type === 'message') {
        this.persisted.add(e.message);
        if (e.message.role === 'user') { const id = (e.message as UserMessage & { xloomInputId?: string }).xloomInputId ?? sourceIds.get(e.id) ?? e.id; this.inputIds.set(e.message, id); this.knownInputIds.add(id); }
        if (e.message.role === 'assistant') this.addUsage(e.message, e.id);
      }
      if (e.type === 'custom' && e.customType === 'xloom.compaction-response') this.addUsage(e.data as RecordedResponse, e.id);
    }
    this.messages.push(...this.persistence.buildSessionContext().messages);
    const latestCompaction = entries.findLast((e) => e.type === 'compaction');
    if (latestCompaction?.type === 'compaction') {
      this.compactedAt = (latestCompaction.details as any)?.sourceLeaf;
      this.compactStatus = `${this.role} 已恢复压缩分界`;
    }
    this.log('session_started');
  }

  createRole(role: AgentRole) { return createAgent({ ...this.options, role, backends: this.backends }); }

  get pendingInputs(): readonly UserMessage[] { return this.queued; }
  get responseRef() { return this.activeResponseRef; }

  hasInput(id: string) { return this.knownInputIds.has(id); }
  ensurePendingInput(text: string, id: string) {
    if (!this.hasInput(id)) { this.recordInput(text, id); return; }
    if ([...this.messages, ...this.queued].some((m) => this.inputIds.get(m) === id)) return;
    // A failed request may have been manually compacted. Re-offer the same source ID once.
    const message: UserMessage & { xloomInputId: string } = { role: 'user', content: text, timestamp: Date.now(), xloomInputId: id };
    this.inputIds.set(message, id); this.queued.push(message);
  }

  recordInput(text: string, sourceMessageId?: string): string {
    if (this.closed) throw new Error('会话已经关闭');
    const originalId = sourceMessageId ?? this.session.recordUser(text);
    if (this.knownInputIds.has(originalId)) return originalId;
    const message: UserMessage & { xloomInputId: string } = { role: 'user', content: text, timestamp: Date.now(), xloomInputId: originalId };
    // Root timeline already durably owns the original. Append the native user
    // message only when Pi consumes it, after the complete call/result group.
    this.knownInputIds.add(originalId); this.inputIds.set(message, originalId); this.queued.push(message);
    this.session.setTitle(this.redact(text)); this.options.onState?.(); return originalId;
  }

  runIntent(capsule: CapsuleMessage, tools: AgentTool<any>[], delivered: (ids: string[], revision?: number) => void, refresh?: () => { content: string; revision: number }, stop?: (reason: string) => void): Promise<void> {
    if (this.closed || this.storageFailed || this.state !== 'idle') return Promise.reject(new Error(`${this.role} 尚未完成收尾、保存失败或已关闭`));
    this.caseRun = { capsule, tools, delivered, refresh, toolAttempts: 0, stop };
    this.consumedIds = this.messages.flatMap((m) => this.inputIds.has(m) ? [this.inputIds.get(m)!] : []);
    this.persistence.appendCustomEntry('xloom.capsule', capsule);
    // Old projections remain in the transcript for audit, never stack in model requests.
    for (let i = this.messages.length - 1; i >= 0; i--) if (isCapsule(this.messages[i])) this.messages.splice(i, 1);
    this.state = 'running'; this.lastError = undefined; this.lastResult = undefined;
    this.controller = new AbortController();
    const controller = this.controller;
    const prompts: AgentMessage[] = [...this.queued.splice(0), capsule];
    this.active = Promise.resolve().then(() => this.run(prompts, controller));
    this.options.onState?.(); return this.active;
  }

  submit(text: string): Promise<void> {
    text = text.trim();
    if (!text) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error('会话已经关闭'));
    this.recordInput(text);
    if (this.state !== 'idle') {
      this.persistence.appendCustomEntry('xloom.pending-input', { text, status: 'queued', timestamp: Date.now() });
      this.options.onState?.();
      return Promise.resolve();
    }
    this.state = 'running';
    this.lastError = undefined;
    this.controller = new AbortController();
    // Establish the active promise before callbacks can cancel or close the run.
    const controller = this.controller;
    this.active = Promise.resolve().then(() => this.run(this.queued.splice(0), controller));
    this.options.onState?.();
    return this.active;
  }

  private async run(prompts: AgentMessage[], controller: AbortController): Promise<void> {
    const context = this.caseRun;
    const emit = (event: AgentEvent) => this.receive(event, context);
    this.log('run_started');
    try {
      await runAgentLoop(prompts, {
        systemPrompt: this.systemPrompt, tools: this.caseRun?.tools ?? this.tools, messages: this.messages.slice(),
      }, {
        model: this.model,
        transformContext: async () => {
          await this.beforeRequest(controller.signal);
          return this.messages.slice();
        },
        convertToLlm: (messages) => projectForModel(messages, this.model),
        getSteeringMessages: async () => {
          if (controller.signal.aborted) return [];
          const pending = this.queued.splice(0);
          if (pending.length) this.persistence.appendCustomEntry('xloom.pending-input', { status: 'consumed', count: pending.length });
          this.options.onState?.();
          return pending;
        },
      }, emit, controller.signal, this.stream);
    } catch (error) {
      const message = failedMessage(this.model, this.redact(error instanceof Error ? error.message : String(error)), controller.signal.aborted);
      emit({ type: 'message_start', message });
      emit({ type: 'message_end', message });
      emit({ type: 'agent_end', messages: [message] });
    } finally {
      if (controller.signal.aborted) {
        this.persistence.appendCustomEntry('xloom.interruption', { status: 'interrupted', queuedInputs: this.queued.length });
      }
      this.controller = undefined;
      if (this.lastResult) this.lastResult.aborted = controller.signal.aborted;
      this.log(controller.signal.aborted ? 'run_cancelled' : this.lastError ? 'run_failed' : 'run_finished', this.lastError);
      this.caseRun = undefined;
      this.state = 'idle';
      this.active = undefined;
      this.options.onState?.();
    }
  }

  private receive(event: AgentEvent, context: ProbeAgent['caseRun']): void {
    const messageRef = (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant'
      ? (event.message as RecordedResponse).xloomResponseId : undefined;
    if (messageRef && (!context || context === this.caseRun)) {
      this.activeResponseRef = messageRef;
      if (context) context.responseRef = messageRef;
    }
    const attributed = { ...event, agent: this.role, agentSessionId: this.sessionId, responseRef: messageRef ?? context?.responseRef ?? this.activeResponseRef, ...(context ? { runId: context.capsule.runId } : {}) };
    if (context && context !== this.caseRun) {
      this.persistence.appendCustomEntry('xloom.late-event', attributed);
      this.options.onEvent?.(attributed);
      return; // Audit/display only: cannot mutate a later Run or commit knowledge.
    }
    // Pi emits start before schema validation: invalid calls must also consume
    // the same Run budget instead of forming an unbounded validation loop.
    if (context && event.type === 'tool_execution_start' && ++context.toolAttempts > this.options.config.limits.maxToolCallsPerRun) {
      const reason = `达到每 Run 工具调用上限 ${this.options.config.limits.maxToolCallsPerRun}（含参数错误调用）；后续工具未执行`;
      context.stop?.(reason); this.cancel();
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') this.log(event.type, undefined, event.toolCallId, event.toolName);
    if (event.type === 'message_end') {
      const message = event.message;
      if (message.role === 'assistant' && message.errorMessage) {
        message.errorMessage = this.redact(message.errorMessage);
        this.lastError = message.errorMessage;
      }
      if (message.role === 'assistant' && message.stopReason !== 'toolUse') this.lastResult = {
        finalText: message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), stopReason: message.stopReason, aborted: message.stopReason === 'aborted' };
      if (message.role === 'user') { const id = this.inputIds.get(message); if (id) this.consumedIds.push(id); }
      let entryId: string | undefined;
      if (!isCapsule(message) && !this.persisted.has(message)) {
        try {
          entryId = this.persistence.appendMessage(message as Message); this.persisted.add(message);
          const sourceMessageId = this.inputIds.get(message);
          if (message.role === 'user' && sourceMessageId) this.persistence.appendCustomEntry('xloom.input-source', { messageId: entryId, sourceMessageId });
        }
        catch (e) { this.storageFailed = true; this.lastError = `Pi 消息保存失败：${String(e)}`; throw e; }
      }
      if (!this.messages.includes(message)) this.messages.push(message);
      if (entryId) this.session.message(this.role, entryId, context?.capsule.runId);
      if (context && entryId && this.inputRequestId && message.role === 'assistant' && ['stop', 'toolUse'].includes(message.stopReason)) {
        this.persistence.appendCustomEntry('xloom.input-accepted', { inputId: this.inputRequestId, responseEntryId: entryId,
          revision: context.capsule.revision, messageIds: this.consumedIds });
        context.delivered(this.consumedIds, context.capsule.revision);
        this.inputRequestId = undefined;
      }
      if (message.role === 'assistant') this.addUsage(message, entryId ?? this.activeResponseRef ?? randomUUID());
    }
    try { this.options.onEvent?.(attributed); }
    catch (error) { this.log('display_failed', this.redact(String(error))); }
  }

  private addUsage(message: RecordedResponse, fallback: string) {
    // A local validation failure before the transport starts is not a model response.
    if (!message.xloomResponseId && !message.responseId && !message.usageAvailable && !message.usage?.totalTokens && !message.usage?.input && !message.usage?.output) return;
    const key = message.xloomResponseId ?? (message.responseId ? `${message.provider}:${message.api}:${message.model}:${message.responseId}` : fallback);
    this.usageResponses.set(key, responseUsage(message));
    this.usage = combineUsageTotals([...this.usageResponses.values()]);
  }
  private recordStream(source: StreamFn): StreamFn {
    return async (model, context, options) => {
      const responseRef = randomUUID();
      const output = new AssistantMessageEventStream();
      let partial: RecordedResponse | undefined;
      let terminal = false;
      const bind = (message: AssistantMessage): RecordedResponse => ({ ...message,
        api: model.api, provider: model.provider, model: model.id, xloomResponseId: responseRef,
        ...(this.options.config.thinking === undefined ? {} : { thinking: this.options.config.thinking }) });
      const fail = (error: unknown) => {
        const failure: RecordedResponse = { ...partial, ...bind(failedMessage(model, this.redact(String(error)), options?.signal?.aborted)),
          ...(partial ? { content: partial.content, usage: partial.usage, responseId: partial.responseId, usageAvailable: partial.usageAvailable } : {}),
          usageComplete: false };
        output.push({ type: 'error', reason: failure.stopReason as 'error' | 'aborted', error: failure });
        terminal = true;
      };
      void (async () => {
        try {
          const incoming = await source(model, context, options);
          for await (const event of incoming) {
            if (terminal) continue;
            if (event.type === 'done' || event.type === 'error') {
              const message = bind(event.type === 'done' ? event.message : event.error);
              partial = message;
              if (options?.signal?.aborted && message.stopReason !== 'aborted') { fail('Request was aborted'); continue; }
              if (event.type === 'done' && !['stop', 'toolUse', 'length'].includes(message.stopReason)) { fail(`协议未返回合法终态：${message.stopReason}`); continue; }
              if (message.errorMessage) message.errorMessage = this.redact(message.errorMessage);
              output.push(event.type === 'done' ? { ...event, message } : { ...event, error: message });
              terminal = true;
            } else {
              partial = bind(event.partial);
              output.push({ ...event, partial });
            }
          }
          if (!terminal) fail('响应流在明确终态之前关闭，已保存部分内容并暂停');
        } catch (error) { if (!terminal) fail(error); }
        finally { output.end(); }
      })();
      return output;
    };
  }
  private budget() { return requestBudget({ systemPrompt: this.systemPrompt, tools: this.caseRun?.tools ?? this.tools, messages: projectForModel(this.messages, this.model) }, this.options.config); }
  private async beforeRequest(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.caseRun?.refresh) {
      const fresh = this.caseRun.refresh();
      if (fresh.revision !== this.caseRun.capsule.revision) {
        const capsule = { ...this.caseRun.capsule, ...fresh };
        this.persistence.appendCustomEntry('xloom.capsule', capsule);
        for (let i = this.messages.length - 1; i >= 0; i--) if (isCapsule(this.messages[i])) this.messages.splice(i, 1);
        this.messages.push(capsule); this.caseRun.capsule = capsule;
      }
    }
    this.contextBudget = this.budget();
    const manual = !!this.compactRequest;
    if (manual || !this.contextBudget.fits) await this.performCompact(signal, !manual);
    this.contextBudget = this.budget();
    if (!this.contextBudget.fits) throw new Error(`必要输入仍超过上下文容量，已保存并暂停；估算输入 ${this.contextBudget.input}，可用 ${this.contextBudget.availableInput}（系统 ${this.contextBudget.system}、工具 ${this.contextBudget.tools}、历史/Capsule ${this.contextBudget.history}）。不会反复压缩或删去约束。`);
    signal.throwIfAborted();
    if (this.caseRun) this.inputRequestId = this.persistence.appendCustomEntry('xloom.input-prepared', {
      revision: this.caseRun.capsule.revision, runId: this.caseRun.capsule.runId, messageIds: this.consumedIds, budget: this.contextBudget,
    });
    this.options.onState?.();
  }
  get compactPending() { return !!this.compactRequest || this.compactActive; }
  async requestCompact(focus = '') {
    if (this.compactPending) return;
    if (this.closed || this.storageFailed) throw new Error('当前会话已关闭或保存失败');
    this.compactRequest = { focus }; this.compactStatus = `等待压缩 ${this.role}`; this.options.onState?.();
    if (this.state !== 'idle') return;
    this.state = 'running'; this.controller = new AbortController(); const signal = this.controller.signal;
    this.active = Promise.resolve().then(() => this.performCompact(signal, false)).then(() => {});
    try { await this.active; }
    finally { this.state = 'idle'; this.controller = undefined; this.active = undefined; this.options.onState?.(); }
  }
  async flushCompact() { if (this.compactRequest) { const focus = this.compactRequest.focus; this.compactRequest = undefined; await this.requestCompact(focus); } }
  private async performCompact(signal: AbortSignal, automatic: boolean) {
    const focus = this.compactRequest?.focus ?? ''; this.compactRequest = undefined;
    signal.throwIfAborted();
    const branch = this.persistence.getBranch();
    const sourceLeaf = branch.findLast((e) => e.type === 'message' && e.message.role === 'assistant')?.id;
    const before = this.budget();
    const preparation = prepareRoleCompaction(branch, before.availableInput, { reserveTokens: this.options.config.maxOutputTokens, ...this.options.compactionSettings });
    if (!preparation || !sourceLeaf || sourceLeaf === this.compactedAt) { this.compactStatus = '暂无可压缩的 Agent 历史'; this.options.onState?.(); return; }
    assertToolBoundary(projectForModel(this.messages, this.model));
    const currentCapsule = this.messages.findLast(isCapsule);
    this.compactActive = true; this.compactStatus = `正在压缩 ${this.role}`;
    this.session.control('compact_started', this.role, automatic ? '自动' : focus); this.options.onState?.();
    const responses: string[] = [];
    try {
      const summaryStream: StreamFn = async (model, context, options) => {
        const budget = requestBudget(context, this.options.config, options?.maxTokens);
        if (!budget.fits) throw new Error(`摘要必要输入超过容量（估算 ${budget.input}），停止压缩`);
        const stream = await this.stream(model, context, options);
        // Pi awaits result(); persist actual usage even for a cancelled/failed summary.
        const result = stream.result.bind(stream);
        let saved = false;
        stream.result = async () => {
          const response = await result();
          if (!saved) {
            saved = true;
            const id = this.persistence.appendCustomEntry('xloom.compaction-response', { responseId: response.responseId, xloomResponseId: (response as RecordedResponse).xloomResponseId,
              provider: response.provider, api: response.api, model: response.model, thinking: this.options.config.thinking,
              usage: response.usage, usageAvailable: (response as RecordedResponse).usageAvailable, usageComplete: (response as RecordedResponse).usageComplete,
              stopReason: response.stopReason, budget, error: response.errorMessage && this.redact(response.errorMessage) });
            responses.push(id); this.addUsage(response, id);
          }
          return response;
        };
        return stream;
      };
      const result = await compact(preparation, this.model, undefined, undefined,
        retention + (focus ? `\n用户保留重点：${focus}` : '') + (currentCapsule ? `\n当前有效共享状态（优先于历史）：${currentCapsule.content}` : ''),
        signal, this.options.config.thinking, summaryStream, undefined, this.sessionId);
      signal.throwIfAborted();
      if (!result.summary.trim()) throw new Error('摘要为空，保留原上下文');
      try { this.persistence.appendCompaction(result.summary, result.firstKeptEntryId, before.input,
        { ...(result.details as object), sourceLeaf, responses, budgetBefore: before }, false, result.usage); }
      catch (e) { this.storageFailed = true; throw new Error(`压缩记录保存失败，保留原上下文：${String(e)}`); }
      const queued = new Set(this.queued);
      this.messages.splice(0, this.messages.length, ...this.persistence.buildSessionContext().messages.filter((m) => !queued.has(m as UserMessage)));
      if (currentCapsule) this.messages.push(currentCapsule);
      this.compactedAt = sourceLeaf; this.contextBudget = this.budget();
      this.compactStatus = `${this.role} 压缩完成 · 请求估算 ${before.input} → ${this.contextBudget.input}`;
      this.session.control('compact_completed', this.role, this.compactStatus);
    } catch (e) {
      this.compactStatus = `${this.role} 压缩${signal.aborted ? '取消' : '失败'}，保留原上下文`;
      try { this.session.control(signal.aborted ? 'compact_cancelled' : 'compact_failed', this.role, this.redact(String(e))); } catch { this.storageFailed = true; }
      throw e;
    } finally { this.compactActive = false; this.options.onState?.(); }
  }

  cancel(): void {
    this.compactRequest = undefined;
    if (this.state !== 'running') return;
    this.state = 'cancelling';
    this.controller?.abort();
    this.options.onState?.();
  }

  async close(): Promise<void> {
    if (this.closed) { await this.active; return; }
    this.closed = true;
    this.cancel();
    await this.active;
    await this.backends.close();
    this.log('session_closed');
  }
  async waitForIdle() { try { await this.active; } catch { /* The owner reports compaction failure. */ } }
  assertSaved() { if (this.storageFailed) throw new Error('Pi 记录保存失败，停止会话切换'); this.session.assertSaved(); }
}
