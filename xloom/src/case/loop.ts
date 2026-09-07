import { configSecrets, type ActiveConfig } from '../config.js';
import { redactor } from '../log.js';
import type { ProbeAgent } from '../runtime/agent.js';
import { combineUsageTotals } from '../runtime/usage.js';
import { recordedTools } from './artifacts.js';
import { buildCapsule } from './capsule.js';
import { BlackboardStore, ViewWriteError } from './store.js';
import { activeFacts, validConfirmation, pathState, type AgentRole, type BoardState, type Intent } from './types.js';
import { parseUpdate } from './update.js';

export function selectExplore(board: BoardState): Intent | undefined {
  return Object.values(board.intents).filter((i) => i.kind === 'explore' && i.state === 'open')
    .sort((a, b) => a.createdRevision - b.createdRevision || a.id.localeCompare(b.id, 'en', { numeric: true }))[0];
}
export function selectNextIntent(board: BoardState): Intent | undefined {
  const open = Object.values(board.intents).filter((i) => i.state === 'open' && !board.hypotheses[i.verifiesHypothesisId ?? '']?.duplicateOf)
    .sort((a, b) => a.createdRevision - b.createdRevision || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return open.find((i) => i.kind === 'verify') ?? open.find((i) => i.kind === 'explore');
}
export function requiresProof(board: BoardState): boolean {
  // Explicit exclusions are scope, not success conditions. Keep all affirmative
  // clauses (including requirements elsewhere in the same Goal) for the existing
  // conservative check. This is not a general natural-language permission parser.
  const affirmative = [board.goal.request, ...board.goal.successCriteria].join('\n')
    .split(/([。！？；;\n，,])/)
    .filter(clause => /(?:但|而|仍|\bhowever\b|\bbut\b|\balso\b)/i.test(clause) ||
      !/^\s*(?:(?:不要|无需|无须|不必|不需要|不要求|禁止|不)(?:再|额外|独立|进一步)?(?:进行|创建|做|推断|确认|证明|验证|利用|评估|扫描)|(?:do not|don't|no need to)\s+(?:verify|confirm|prove|assess|exploit)\b|(?:无需|无须|不必|不需要|不要求)(?:额外|独立)?安全影响验证\s*$)/i.test(clause))
    .join('');
  return /(?:确认|证明|验证|利用|可利用|影响|危害).{0,24}(?:漏洞|安全|越权|注入|执行代码)|(?:漏洞|安全|越权|注入).{0,24}(?:确认|证明|验证|影响|危害)|(?:confirm|prove|verify|exploit).{0,35}(?:vulnerab|security|impact)|(?:vulnerab|security).{0,35}(?:confirm|impact|exploit)/is
    .test(affirmative);
}
export function hasSupportedGoalCompletion(board: BoardState): boolean {
  if (!board.assessment || board.assessment.goalRevision !== board.goalRevision || Object.values(board.hints).some((h) => !h.delivered)) return false;
  if (requiresProof(board) && !board.assessment.value.criteria.some((c) => c.status === 'satisfied' && c.basisIds.some((id) => board.hypotheses[id] && validConfirmation(board, board.hypotheses[id])))) return false;
  const active = new Set(activeFacts(board).map((f) => f.id));
  const validFact = (id: string) => active.has(id) && board.facts[id].evidenceIds.every((eid) => {
    const e = board.evidence[eid]; return e && e.kind !== 'derived' && (e.status === 'observed' || (e.kind === 'observation' && e.status === 'error' && e.outcomeKnown === true));
  });
  return board.goal.successCriteria.every((_c, index) => {
    const c = board.assessment!.value.criteria.find((c) => c.criterion === index + 1);
    // Action receipts can support a multi-step ordinary task alongside a real
    // observation of its result. A receipt by itself still cannot satisfy it.
    if (!c?.basisIds.some((id) => (board.facts[id] ? [id] : board.hypotheses[id]?.factIds ?? []).some((fid) =>
      validFact(fid) && board.facts[fid].evidenceIds.some((eid) => board.evidence[eid].kind === 'observation')))) return false;
    const safetyCriterion = requiresProof({ ...board, goal: { ...board.goal, request: _c, successCriteria: [_c] } });
    if (safetyCriterion && !c?.basisIds.some((id) => board.hypotheses[id] && validConfirmation(board, board.hypotheses[id]))) return false;
    return c?.status === 'satisfied' && c.basisIds.length > 0 && c.basisIds.every((id) => {
      if (board.facts[id]) return validFact(id);
      const h = board.hypotheses[id];
      return h && !h.duplicateOf && (h.status !== 'impact_verified' || validConfirmation(board, h)) && !h.needsReview && !['rejected', 'disputed'].includes(h.status) && h.factIds.length > 0 && h.factIds.every(validFact) &&
        !Object.values(board.intents).some((i) => i.kind === 'verify' && i.verifiesHypothesisId === id && ['open', 'blocked'].includes(i.state));
    });
  });
}

export class CaseLoop {
  readonly store: BlackboardStore;
  private active?: Promise<void>;
  private stopReason = '';
  private closed = false;
  stage = '等待 Goal';
  currentIntentId?: string;
  currentRole?: AgentRole;
  proof?: ProbeAgent;
  get activeAgent() { return (this.currentRole ?? this.session.metadata.lastActiveRole) === 'proof' && this.proof ? this.proof : this.probe; }
  get agents() { return this.proof ? [this.probe, this.proof] : [this.probe]; }
  constructor(readonly probe: ProbeAgent, private readonly config: ActiveConfig,
    private readonly notice: (text: string) => void = () => {}, private readonly changed: () => void = () => {}, store?: BlackboardStore) {
    this.store = store ?? new BlackboardStore(probe.session.dir, undefined, redactor(...configSecrets(config)));
    if (probe.session.metadata.agents.proof) this.proof = probe.createRole('proof');
    if (probe.session.restored) this.stage = '会话已恢复，等待输入';
  }
  get session() { return this.probe.session; }
  get model() { return this.probe.model; }
  get usage() { return combineUsageTotals(this.agents.map((agent) => agent.usage)); }
  get pendingInputs() { return this.activeAgent.pendingInputs; }
  get state() { return this.activeAgent.state === 'cancelling' ? 'cancelling' : this.active || this.activeAgent.state === 'running' ? 'running' : 'idle'; }
  get board() { return this.store.current(); }
  get lastError() { return this.activeAgent.lastError; }
  async submit(text: string): Promise<void> {
    if (this.closed) throw new Error('会话已经关闭');
    if (!text.trim()) return;
    try {
      for (const agent of this.agents) agent.assertSaved();
      if (!this.board.revision && /^(继续|continue)$/i.test(text.trim())) {
        this.session.recordUser(text, undefined, false); this.notice('尚无已保存的 Goal，请先输入调查目标'); return;
      }
      const continuing = !!this.board.revision && /^(继续|continue)$/i.test(text.trim());
      if (continuing && !this.active && hasSupportedGoalCompletion(this.board)) {
        this.session.recordUser(text); this.finish('satisfied', '已有结果满足目标，等待新的要求'); return;
      }
      const messageId = this.activeAgent.recordInput(text);
      if (!this.board.revision) this.store.create(text, messageId);
      else if (!continuing) {
        this.store.addHint(text, messageId);
        const change = /^(?:修改目标|更改目标|change goal)\s*[:：]\s*([\s\S]+)$/i.exec(text.trim());
        if (change) this.store.changeGoal(change[1], messageId);
      }
      if (this.active || this.activeAgent.state !== 'idle') { this.changed(); return; }
      this.stopReason = '';
      this.store.rebuildView();
      const b = this.board;
      const interrupted = Object.values(b.runs).filter((r) => ['interrupted', 'failed'].includes(r.status)).reverse()
        .find((r) => b.intents[r.intentId]?.state === 'blocked' && !b.hypotheses[b.intents[r.intentId]?.verifiesHypothesisId ?? '']?.duplicateOf);
      if (interrupted) this.store.reopen(interrupted.intentId, '用户显式继续；先检查此前证据与实际状态，再重新判断动作');
      this.store.execution('running', 'in_progress', '用户输入启动本周期');
      this.active = Promise.resolve().then(() => this.advance());
      this.changed();
      await this.active;
    } catch (error) { this.pauseForError(error); }
  }
  private finish(outcome: BoardState['outcome'], reason: string) {
    this.store.execution('idle', outcome, reason); this.stage = reason;
    this.notice(`调查结果：${outcome} — ${reason}\n${this.resultText}`);
  }
  get resultText() {
    const b = this.board, findings = Object.values(b.hypotheses).filter((h) => validConfirmation(b, h));
    const limits = [...new Set([...findings.map((h) => h.verification!.limitations), ...Object.values(b.attackPaths).flatMap((p) => p.gaps), ...Object.values(b.hypotheses).filter((h) => !h.duplicateOf).flatMap((h) => h.gaps)])].filter(Boolean);
    return `当前有效问题 ${findings.length}；未决候选 ${Object.values(b.hypotheses).filter((h) => !h.duplicateOf && !validConfirmation(b, h) && h.status !== 'rejected').length}\n${Object.values(b.attackPaths).map((p) => `${p.id}：${pathState(b, p)}`).join('；') || '无候选路径'}\n关键限制：${limits.slice(0, 4).join('；') || '以已记录的验证范围为限'}\n${this.store.reportStatus.error ?? `报告：${this.store.reportPath}（r${this.store.reportStatus.revision ?? '未知'}）`}`;
  }
  private async advance() {
    let runs = 0;
    try {
      while (!this.stopReason && !this.closed) {
        const board = this.board;
        if (hasSupportedGoalCompletion(board)) { this.finish('satisfied', '用户成功条件已有实际观察支持'); break; }
        let intent = selectNextIntent(board);
        if (!intent) {
          const waiting = Object.values(board.intents).filter((i) => ['open', 'blocked'].includes(i.state));
          if (board.knowledgeRevision > board.reviewCursor) {
            intent = this.store.scheduleReview();
          } else {
            this.finish(waiting.length ? 'blocked' : 'exhausted', waiting.length ? '现有任务受阻，需要补充输入或执行条件' : '现有证据下没有可执行后继；不代表证明系统无漏洞'); break;
          }
        }
        if (runs >= this.config.limits.maxRunsPerCycle) { this.cancel(`达到本周期 Run 上限 ${this.config.limits.maxRunsPerCycle}`); break; }
        if (this.stopReason || this.closed) break;
        const role: AgentRole = intent.kind === 'verify' ? 'proof' : 'probe';
        const agent = role === 'probe' ? this.probe : this.proof ??= this.probe.createRole('proof');
        this.store.registerAgent('probe', this.probe.sessionId);
        this.store.registerAgent(role, agent.sessionId);
        this.currentRole = role;
        this.session.activity(role);
        const snapshot = this.board;
        if (role === 'probe' && !agent.hasInput(snapshot.goalMessageId)) agent.recordInput(snapshot.originalGoal.request, snapshot.goalMessageId);
        // Native input once per role, preserving the original source identity in its transcript.
        for (const hint of Object.values(snapshot.hints)) if (!snapshot.agentCursors[role]?.deliveredMessageIds.includes(hint.messageId)) agent.ensurePendingInput(hint.content, hint.messageId);
        const capsule = buildCapsule(snapshot, intent, role, this.session.dir);
        const run = this.store.startRun(intent, role, agent.sessionId); runs++;
        this.currentIntentId = intent.id; this.stage = '执行任务';
        this.notice(`${role === 'proof' ? 'Proof' : 'Probe'} · 任务 ${intent.id} · ${run.id}${run.purpose === 'review' ? ' · 收尾评估' : ''}\n${intent.objective}`);
        this.changed();
        if (this.stopReason || this.closed) {
          this.store.endRun(run.id, this.stopReason || '会话退出', true); break;
        }
        const tools = recordedTools({ cwd: this.session.metadata.cwd, store: this.store, run, backends: this.probe.backends,
          responseRef: () => agent.responseRef,
          supportsImages: agent.model.input.includes('image'),
          maxToolCalls: this.config.limits.maxToolCallsPerRun, stop: (reason) => this.cancel(reason), notice: this.notice });
        await agent.runIntent({ role: 'custom', customType: 'xloom.capsule', display: false, runId: run.id, revision: run.inputRevision, content: capsule, timestamp: Date.now() }, tools,
          (ids, inputRevision = run.inputRevision) => {
            const previous = this.board.revision;
            this.store.delivered(ids, inputRevision, role);
            if (this.board.revision !== previous) {
              const cursor = this.board.agentCursors[role]; if (cursor) this.session.saveCursor(role, cursor);
            }
          }, () => { const current = this.board; return { content: buildCapsule(current, current.intents[intent.id], role, this.session.dir), revision: current.revision }; }, (reason) => this.cancel(reason));
        if (this.stopReason || this.closed || agent.lastResult?.aborted) {
          this.store.endRun(run.id, this.stopReason || '执行中断，已发生动作的结果可能未知', true); break;
        }
        if (agent.lastError || !agent.lastResult || ['error', 'aborted', 'length'].includes(agent.lastResult.stopReason))
          throw new Error(agent.lastError ?? '模型没有完整最终回复或达到输出上限');
        this.stage = '解析与提交'; this.changed();
        this.notice(`任务 ${intent.id}：正在解析与提交`);
        if (this.stopReason || this.closed) { this.store.endRun(run.id, this.stopReason || '会话退出', true); break; }
        const commit = this.store.commit(run.id, parseUpdate(agent.lastResult.finalText));
        this.session.activity(role);
        const objects = [...commit.facts, ...commit.hypotheses, ...commit.intents, ...(commit.attackPaths ?? [])].map((o) => o.id).join(', ');
        const verificationSummary = commit.hypotheses.filter((h) => h.verification).map((h) => `${h.id}: ${h.needsReview ? '原确认需要复核' : h.duplicateOf ? `并入 ${h.duplicateOf}，不继承验证` : h.verification!.verdict} / ${h.status} · ${h.verification!.limitations}`).join('\n');
        this.stage = '提交成功'; this.notice(`任务 ${intent.id}：提交成功 · r${this.board.revision}${objects ? ` · 对象 ${objects}` : ''}\n${commit.summary}${verificationSummary ? `\n${role} 验证：${verificationSummary}` : ''}`); this.changed();
        if (this.store.reportStatus.error) this.notice(this.store.reportStatus.error);
        if (commit.attackPaths?.length) this.notice(commit.attackPaths.map((p) => `${p.id}：${pathState(this.board, this.board.attackPaths[p.id])}`).join('；'));
        if (!this.stopReason && !this.closed && agent.compactPending) { await agent.flushCompact(); this.store.rebuildReport(); this.notice(agent.compactStatus); }
      }
    } catch (error) { this.pauseForError(error); }
    finally {
      this.active = undefined; this.currentIntentId = undefined; this.currentRole = undefined;
      this.store.rebuildReport();
      if (this.stopReason && !this.closed) this.notice(this.resultText);
      this.changed();
    }
  }
  private pauseForError(error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    this.stopReason = reason; this.stage = error instanceof ViewWriteError ? '视图失败（事件已保存）' : '执行或提交失败';
    this.activeAgent.cancel();
    try {
      // Never relabel or reapply a commit whose event was already durable.
      const running = Object.values(this.board.runs).find((r) => r.status === 'running');
      if (running && this.activeAgent.state === 'idle') this.store.endRun(running.id, reason, false);
    } catch { /* The durable event remains the source of truth even when its projection is unavailable. */ }
    try { if (this.board.revision) this.store.execution('paused', this.board.outcome, reason); } catch { /* Report the original storage failure. */ }
    this.notice(`${this.stage}：${reason}`); this.changed();
  }
  cancel(reason = '用户暂停；保留证据，等待显式输入继续'): void {
    // Set the outer gate before aborting Pi or invoking callbacks.
    this.stopReason = reason; this.stage = '暂停';
    try { if (this.board.revision) this.store.execution('paused', this.board.outcome, reason); this.session.control('paused', this.currentRole, reason); } catch (error) { this.notice(String(error)); }
    this.activeAgent.cancel(); this.changed();
  }
  async compact(focus = '') {
    const target = this.activeAgent;
    if (target.compactPending) { this.notice('已有压缩请求正在等待或执行'); return; }
    this.notice(`准备压缩 ${target.role === 'proof' ? 'Proof' : 'Probe'}`);
    try { await target.requestCompact(focus); this.store.rebuildReport(); this.notice(target.compactStatus); }
    catch (e) { this.pauseForError(e); }
  }
  async pauseAndWait(reason = '会话切换') {
    this.cancel(reason); await this.active;
    // An idle manual compaction is also an active model path.
    await this.activeAgent.waitForIdle();
    await this.probe.backends.close();
    for (const agent of this.agents) agent.assertSaved();
  }
  async close() {
    this.closed = true; this.cancel('会话退出');
    await this.active;
    for (const agent of this.agents) await agent.close();
    this.session.release();
  }
}
