import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refreshValidity, emptyBoard, parseGoal, toolCallRef, hasToolSource, type AgentRole, type BoardEvent, type BoardState, type EventPayloads, type Evidence, type IdPrefix, type Intent, type XLoomUpdate } from './types.js';
import { normalizeUpdate } from './update.js';
import { renderBoard } from './view.js';
import { readReportUsage, renderReport } from './report.js';
import { basename } from 'node:path';
import { redactStructured } from '../log.js';

export class ViewWriteError extends Error {
  constructor(readonly revision: number, cause: unknown) { super(`事件 r${revision} 已保存，但 view.md 生成失败：${String(cause)}`, { cause }); }
}

/** A pure replay reducer. Only this file appends authoritative events. */
export function applyEvent(board: BoardState, event: BoardEvent): void {
  if (event.revision !== board.revision + 1 || !event.timestamp || !['user', 'program', 'probe', 'proof'].includes(event.source)) throw new Error('黑板事件顺序或来源无效');
  const count = (id: string) => {
    const match = /^(PE|[IREFHNP])([1-9]\d*)$/.exec(id);
    if (!match) throw new Error(`持久 ID 无效：${id}`);
    const prefix = match[1] as IdPrefix;
    board.counters[prefix] = Math.max(board.counters[prefix], Number(match[2]));
  };
  switch (event.type) {
    case 'cursor_restored': {
      board.agentCursors[event.payload.agent] = event.payload.cursor;
      board.deliveredMessageIds = [...new Set(Object.values(board.agentCursors).flatMap((c) => c?.deliveredMessageIds ?? []))];
      for (const h of Object.values(board.hints)) h.delivered = board.deliveredMessageIds.includes(h.messageId);
      board.lastSeenRevision = Math.max(0, ...Object.values(board.agentCursors).map((c) => c?.lastSeenRevision ?? 0)); break;
    }
    case 'case_created': {
      if (board.revision) throw new Error('不能重复创建 Case');
      const p = event.payload;
      board.goal = p.goal; board.originalGoal = p.goal; board.goalMessageId = p.messageId;
      board.goalRevision = event.revision; board.knowledgeRevision = event.revision;
      board.intents[p.intent.id] = p.intent; count(p.intent.id); break;
    }
    case 'agent_created': {
      const { agent, agentSessionId } = event.payload;
      if (!['probe', 'proof'].includes(agent) || !agentSessionId || board.agentSessions[agent] || Object.values(board.agentSessions).includes(agentSessionId)) throw new Error('角色 Session 无效、重复或不独立');
      board.agentSessions[agent] = agentSessionId;
      board.agentCursors[agent] = { lastSeenRevision: 0, deliveredHintIds: [], deliveredMessageIds: [] }; break;
    }
    case 'hint_added': {
      const h = event.payload.hint;
      board.hints[h.id] = h; count(h.id); board.knowledgeRevision = event.revision; delete board.assessment; break;
    }
    case 'goal_changed':
      board.changes.push({ revision: event.revision, kind: 'scope_changed', objectIds: [], summary: '用户已修改目标/范围，以当前 Goal 为准' });
      board.goal = event.payload.goal; board.goalRevision = event.revision;
      board.goalChanges.push({ ...event.payload, revision: event.revision });
      board.knowledgeRevision = event.revision; delete board.assessment; board.outcome = 'in_progress'; break;
    case 'run_started': {
      const r = event.payload.run;
      const intent = board.intents[r.intentId];
      if (board.runs[r.id] || intent?.state !== 'open' || r.agent !== (intent.kind === 'verify' ? 'proof' : 'probe')) throw new Error('Run 只能派发角色匹配的开放任务');
      if (intent.verifiesHypothesisId && board.hypotheses[intent.verifiesHypothesisId]?.duplicateOf) throw new Error('重复候选的验证任务已阻塞，不能静默改目标');
      if ((board.agentSessions[r.agent] && board.agentSessions[r.agent] !== r.agentSessionId) || (r.agent === 'proof' && !board.agentSessions.proof)) throw new Error('Run 与实际角色 Session 不匹配');
      if (Object.values(board.runs).some((r) => r.status === 'running')) throw new Error('已有活动 Run');
      board.runs[r.id] = r; count(r.id); board.intents[r.intentId].state = 'running'; break;
    }
    case 'tool_started': {
      const p = event.payload; const run = board.runs[p.runId];
      const ref = toolCallRef(p);
      if (!run || run.status !== 'running' || run.toolCallIds.includes(ref)) throw new Error('工具执行来源无效或重复');
      run.toolCallIds.push(ref);
      if (p.responseRef) (run.toolCallSources ??= {})[ref] = { toolCallId: p.toolCallId, responseRef: p.responseRef, tool: p.tool };
      break;
    }
    case 'evidence_recorded': {
      const e = event.payload.evidence; const run = board.runs[e.runId];
      if (e.agent !== run?.agent || !hasToolSource(run, e) || board.evidence[e.id] || run.evidenceIds.some((id) => toolCallRef(board.evidence[id]) === toolCallRef(e))) throw new Error('证据来源不存在或重复');
      board.evidence[e.id] = e; run.evidenceIds.push(e.id); count(e.id); break;
    }
    case 'inputs_delivered': {
      const { messageIds, inputRevision } = event.payload;
      const role = event.payload.agent ?? 'probe';
      const cursor = board.agentCursors[role] ??= { lastSeenRevision: 0, deliveredHintIds: [], deliveredMessageIds: [] };
      cursor.deliveredMessageIds = [...new Set([...cursor.deliveredMessageIds, ...messageIds])];
      cursor.deliveredHintIds = Object.values(board.hints).filter((h) => cursor.deliveredMessageIds.includes(h.messageId)).map((h) => h.id);
      cursor.lastSeenRevision = Math.max(cursor.lastSeenRevision, inputRevision);
      board.deliveredMessageIds = [...new Set([...board.deliveredMessageIds, ...messageIds])];
      for (const h of Object.values(board.hints)) h.delivered = board.deliveredMessageIds.includes(h.messageId);
      board.lastSeenRevision = Math.max(board.lastSeenRevision, inputRevision); break;
    }
    case 'agent_committed': {
      const p = event.payload; const run = board.runs[p.runId];
      if (!run || run.status !== 'running' || event.source !== run.agent) throw new Error('重复提交、来源不符或未知 Run');
      const knowledgeChanged = p.facts.length || p.hypotheses.some((h) => JSON.stringify(board.hypotheses[h.id]) !== JSON.stringify(h)) || (p.attackPaths ?? []).some((path) => board.attackPaths[path.id]?.revision !== path.revision);
      const replaced = new Set(p.facts.flatMap((f) => f.supersedes ? [f.supersedes] : []));
      for (const f of p.facts) { board.facts[f.id] = f; count(f.id); }
      for (const h of p.hypotheses) { board.hypotheses[h.id] = h; count(h.id); }
      for (const path of p.attackPaths ?? []) { board.attackPaths[path.id] = path; count(path.id); for (const e of path.edges) count(e.id); }
      for (const i of p.intents) { board.intents[i.id] = i; count(i.id); }
      board.intents[run.intentId].state = p.intentState;
      board.intents[run.intentId].reason = p.reason;
      run.status = 'completed'; run.endedAt = event.timestamp;
      board.lastSummary = p.summary;
      if (knowledgeChanged) board.changes.push({ revision: event.revision,
        kind: replaced.size ? 'superseded' : p.hypotheses.some((h) => ['rejected', 'disputed'].includes(h.status)) ? 'refuted' : 'changed',
        objectIds: [...new Set([...p.facts.map((f) => f.id), ...replaced, ...p.hypotheses.map((h) => h.id), ...p.intents.map((i) => i.id), ...(p.attackPaths ?? []).map((path) => path.id)])], summary: p.summary });
      if (run.purpose !== 'review' && knowledgeChanged) board.knowledgeRevision = event.revision;
      if (p.goalAssessment && p.goalRevision === board.goalRevision) board.assessment = { goalRevision: p.goalRevision, value: p.goalAssessment };
      refreshValidity(board);
      break;
    }
    case 'run_failed': case 'run_interrupted': {
      const run = board.runs[event.payload.runId];
      if (!run || run.status !== 'running') throw new Error('不能重写已结束的 Run');
      run.status = event.type === 'run_failed' ? 'failed' : 'interrupted';
      run.endedAt = event.timestamp; run.reason = event.payload.reason;
      const intent = board.intents[run.intentId];
      if (intent.state === 'running') { intent.state = 'blocked'; intent.reason = event.payload.reason; }
      break;
    }
    case 'review_scheduled':
      board.intents[event.payload.intent.id] = event.payload.intent; count(event.payload.intent.id);
      board.reviewIntentIds.push(event.payload.intent.id); board.reviewCursor = event.payload.knowledgeRevision; break;
    case 'intent_reopened': {
      const i = board.intents[event.payload.intentId];
      if (!i || i.state !== 'blocked') throw new Error('只能显式恢复受阻任务');
      if (i.verifiesHypothesisId && board.hypotheses[i.verifiesHypothesisId]?.duplicateOf) throw new Error('重复候选任务继续阻塞，请明确创建主候选验证');
      i.state = 'open'; i.reason = event.payload.reason; break;
    }
    case 'execution_changed': {
      const p = event.payload;
      if (Object.keys(p).some((key) => !['execution', 'outcome', 'reason'].includes(key)) ||
        !['idle', 'running', 'paused'].includes(p.execution) || !['in_progress', 'satisfied', 'exhausted', 'blocked'].includes(p.outcome) || typeof p.reason !== 'string')
        throw new Error('执行控制事件字段无效，不能覆盖调查知识');
      board.execution = p.execution; board.outcome = p.outcome; board.reason = p.reason; break;
    }
    default: throw new Error(`未知黑板事件：${(event as { type: string }).type}`);
  }
  board.revision = event.revision;
}

export class BlackboardStore {
  private board = emptyBoard();
  private writeFailed = false;
  readonly dir: string;
  readonly eventsPath: string;
  readonly reportPath: string;
  reportStatus: { revision?: number; error?: string } = {};
  private lastReportInput?: string;
  private lastReportText?: string;
  constructor(readonly sessionDir: string, private readonly render = renderBoard, private readonly redact: (text: string) => string = (text) => text) {
    this.dir = join(sessionDir, 'blackboard'); this.eventsPath = join(this.dir, 'events.jsonl');
    this.reportPath = join(sessionDir, 'results', 'report.md');
    if (existsSync(this.eventsPath)) {
      const text = readFileSync(this.eventsPath, 'utf8');
      if (text && !text.endsWith('\n')) throw new Error('黑板包含未完成的事件尾行；请保留文件排查，不自动忽略');
      for (const line of text.split('\n').filter(Boolean)) applyEvent(this.board, JSON.parse(line));
    }
  }
  current(): BoardState { return structuredClone(this.board); }
  restoreCursor(agent: AgentRole, cursor: import('./types.js').RoleCursor) {
    if (this.board.revision && JSON.stringify(this.board.agentCursors[agent]) !== JSON.stringify(cursor)) this.append('cursor_restored', { agent, cursor });
  }
  id(prefix: IdPrefix): string { return `${prefix}${this.board.counters[prefix] + 1}`; }
  private append<K extends keyof EventPayloads>(type: K, payload: EventPayloads[K], source: BoardEvent['source'] = 'program') {
    if (this.writeFailed) throw new Error('事件写入曾失败，本会话已停止写入，需保留文件排查');
    const event = structuredClone({ revision: this.board.revision + 1, timestamp: new Date().toISOString(), source, type, payload }) as BoardEvent;
    const next = this.current(); applyEvent(next, event);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fd = openSync(this.eventsPath, 'a', 0o600);
    try { writeFileSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd); }
    catch (error) { this.writeFailed = true; throw error; }
    finally { closeSync(fd); }
    this.board = next;
    try { this.rebuildView(false); }
    finally {
      if (['case_created', 'hint_added', 'goal_changed', 'agent_committed', 'execution_changed', 'run_failed', 'run_interrupted', 'intent_reopened'].includes(type)) this.rebuildReport();
    }
    return event;
  }
  rebuildView(report = true) {
    if (!this.board.revision) return;
    try {
      writeFileSync(join(this.dir, 'view.md.tmp'), this.render(this.current()), { mode: 0o600 });
      renameSync(join(this.dir, 'view.md.tmp'), join(this.dir, 'view.md'));
    } catch (error) { throw new ViewWriteError(this.board.revision, error); }
    finally { if (report) this.rebuildReport(); }
  }
  rebuildReport() {
    if (!this.board.revision) return;
    try {
      const usage = readReportUsage(this.sessionDir), input = JSON.stringify([this.board, usage]);
      if (input === this.lastReportInput && existsSync(this.reportPath) && readFileSync(this.reportPath, 'utf8') === this.lastReportText) return;
      const safeBoard = redactStructured(this.board, this.redact, true);
      // Board text is already masked. A second pass would erase trusted tool/backend
      // names when a password happens to equal one of those protocol words.
      const text = renderReport(safeBoard, this.redact(basename(this.sessionDir)), new Date().toISOString(), usage);
      const dir = join(this.sessionDir, 'results'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'report.md.tmp'), text, { mode: 0o600 });
      renameSync(join(dir, 'report.md.tmp'), this.reportPath);
      this.lastReportInput = input; this.lastReportText = text;
      this.reportStatus = { revision: this.board.revision };
    } catch (error) {
      // The durable board remains committed. A failed projection never retries a model/tool.
      if (this.reportStatus.revision === undefined) try {
        const old = /^Revision: (\d+)$/m.exec(readFileSync(this.reportPath, 'utf8')); if (old) this.reportStatus.revision = Number(old[1]);
      } catch { /* There may be no readable older report. */ }
      this.reportStatus.error = this.redact(`报告未刷新，旧版本 ${this.reportStatus.revision === undefined ? '未知/无' : `r${this.reportStatus.revision}`} 已过期；当前黑板 r${this.board.revision}：${String(error)}`);
    }
  }
  create(request: string, messageId: string) {
    const intent: Intent = { id: this.id('I'), kind: 'explore', objective: request, basisIds: [], prerequisites: [], state: 'open', createdRevision: 1 };
    this.append('case_created', { goal: parseGoal(request), messageId, intent }, 'user');
  }
  addHint(content: string, messageId: string) {
    this.append('hint_added', { hint: { id: this.id('N'), messageId, content, createdAt: new Date().toISOString(), delivered: false } }, 'user');
  }
  changeGoal(request: string, messageId: string) { this.append('goal_changed', { goal: parseGoal(request), messageId }, 'user'); }
  registerAgent(agent: AgentRole, agentSessionId: string) {
    if (this.board.agentSessions[agent] === agentSessionId) return;
    this.append('agent_created', { agent, agentSessionId });
  }
  startRun(intent: Intent, agent: AgentRole = 'probe', agentSessionId = this.board.agentSessions[agent] ?? 'legacy-unbound-probe') {
    const run = { id: this.id('R'), intentId: intent.id, agent, agentSessionId, inputRevision: this.board.revision,
      goalRevision: this.board.goalRevision, purpose: this.board.reviewIntentIds.includes(intent.id) ? 'review' as const : 'task' as const,
      startedAt: new Date().toISOString(), status: 'running' as const, toolCallIds: [], evidenceIds: [] };
    this.append('run_started', { run }); return structuredClone(run);
  }
  toolStarted(runId: string, toolCallId: string, tool: Evidence['tool'], artifactPath: string, responseRef?: string) { this.append('tool_started', { runId, toolCallId, tool, artifactPath, ...(responseRef ? { responseRef } : {}) }); }
  recordEvidence(fields: Omit<Evidence, 'id' | 'recordedAt'>) {
    const evidence = { ...fields, id: this.id('E'), recordedAt: new Date().toISOString() };
    this.append('evidence_recorded', { evidence }); return evidence;
  }
  delivered(messageIds: string[], inputRevision: number, agent: AgentRole = 'probe') {
    const cursor = this.board.agentCursors[agent];
    const pending = messageIds.filter((id) => !cursor?.deliveredMessageIds.includes(id));
    if (pending.length || inputRevision > (cursor?.lastSeenRevision ?? 0)) this.append('inputs_delivered', { messageIds: pending, inputRevision, agent });
  }
  commit(runId: string, update: XLoomUpdate) {
    const run = this.board.runs[runId]; if (!run) throw new Error('未知 Run');
    const commit = normalizeUpdate(update, this.current(), run);
    this.append('agent_committed', commit, run.agent); return commit;
  }
  endRun(runId: string, reason: string, interrupted: boolean) { this.append(interrupted ? 'run_interrupted' : 'run_failed', { runId, reason }); }
  execution(execution: BoardState['execution'], outcome: BoardState['outcome'], reason: string) { this.append('execution_changed', { execution, outcome, reason }); }
  reopen(intentId: string, reason: string) { this.append('intent_reopened', { intentId, reason }, 'user'); }
  scheduleReview() {
    const intent: Intent = { id: this.id('I'), kind: 'explore', objective: '收尾评估：依据现有事实、用户成功条件和新 Hint 判断可执行的下一步或明确结束原因；不要重复已有任务，技术支持不等于影响确认，条件不足则明确受阻。', basisIds: [], prerequisites: [], state: 'open', createdRevision: this.board.revision + 1 };
    this.append('review_scheduled', { intent, knowledgeRevision: this.board.knowledgeRevision }); return intent;
  }
}
