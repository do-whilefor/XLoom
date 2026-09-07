import { activeFacts, type BoardState, type Intent, type RunRecord, type XLoomUpdate } from './types.js';

/** Structural checks only. Text prerequisites and semantic scope need the normal
 * Agent turn; an unconfirmed Hypothesis is valid investigation background. */
export function candidateReason(board: BoardState, id: string, currentFacts?: ReadonlySet<string>): string | undefined {
  if (!Object.hasOwn(board.intents, id)) return `Intent 不存在：${id}`;
  const intent = board.intents[id];
  if (intent.state !== 'open') return `任务 ${id} 状态为 ${intent.state}，需要 open`;
  if (!['explore', 'verify'].includes(intent.kind)) return `任务 ${id} 角色不可派发`;
  if (intent.kind === 'verify') {
    const target = board.hypotheses[intent.verifiesHypothesisId ?? ''];
    if (!target) return `任务 ${id} 的验证目标不存在`;
    if (target.duplicateOf) return `候选 ${target.id} 已归并至 ${target.duplicateOf}`;
    if (!intent.prerequisites.length) return `任务 ${id} 缺少已记录的验证前提`;
  } else if (intent.verifiesHypothesisId) return `任务 ${id} 不能以 explore 派发独立验证`;
  const active = currentFacts ?? new Set(activeFacts(board).map((f) => f.id));
  for (const basis of intent.basisIds) {
    if (Object.hasOwn(board.facts, basis)) {
      if (!active.has(basis)) return `任务 ${id} 的直接 Fact 依据已失效：${basis}`;
    } else if (!Object.hasOwn(board.hypotheses, basis)) return `任务 ${id} 的依据不存在：${basis}`;
  }
}

export function legalCandidates(board: BoardState): Intent[] {
  const active = new Set(activeFacts(board).map((f) => f.id));
  return Object.values(board.intents).filter((i) => !candidateReason(board, i.id, active)).sort((a, b) =>
    Number(b.kind === 'verify') - Number(a.kind === 'verify') || a.createdRevision - b.createdRevision ||
    a.id.localeCompare(b.id, 'en', { numeric: true }) || a.id.localeCompare(b.id, 'en'));
}

/** The recommending role must have consumed inputs; the next role need not have
 * a Session or cursor yet. A Run's Goal version never changes while it runs. */
export function recommendationSourceReason(board: BoardState, run: RunRecord): string | undefined {
  if (run.goalRevision !== board.goalRevision) return `新 Goal 使推荐过期：来源 ${run.id} 的目标版本 ${run.goalRevision}，当前 ${board.goalRevision}`;
  if (Object.values(board.hints).some((h) => !board.agentCursors[run.agent]?.deliveredHintIds.includes(h.id)))
    return `新输入使推荐过期：来源 ${run.id}/${run.agent} 尚未消费全部 Hint`;
}

/** Any subsequent run_started consumes the pointer, so its only possible source
 * is the latest completed Run. This is derived history, not another queue. */
export function recommendationSourceRun(board: BoardState): RunRecord | undefined {
  return Object.values(board.runs).filter((r) => r.status === 'completed')
    .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))[0];
}

export function recommendationReason(board: BoardState, run: RunRecord, id: string,
  move: XLoomUpdate['next_move'], createdIds: string[]): string | undefined {
  const source = recommendationSourceReason(board, run);
  if (source) return source;
  const invalid = candidateReason(board, id);
  if (invalid) return invalid;
  const intent = board.intents[id];
  if (move === 'stop' || (move === 'verify' && intent.kind !== 'verify') ||
    (move === 'widen' && (intent.kind !== 'explore' || !createdIds.includes(id))))
    return `推荐 ${id} 与 next_move=${move} 方向不符`;
}

export function selectIntent(board: BoardState): { intent?: Intent; reason: string } {
  const candidates = legalCandidates(board);
  const last = recommendationSourceRun(board);
  const suggested = board.nextIntentId && candidates.find((i) => i.id === board.nextIntentId);
  const stale = last && recommendationSourceReason(board, last);
  if (suggested && !stale) return { intent: suggested, reason: `程序调度：推荐 ${suggested.id}；来源 ${last?.id ?? '已保存 Commit'} 的 agent_committed` };
  const ignored = board.nextIntentId ? stale ?? candidateReason(board, board.nextIntentId) : undefined;
  const intent = candidates[0];
  return { intent, reason: `程序调度：fallback ${intent?.id ?? '无合法候选'}；verify、创建顺序、数字 ID${ignored ? `；忽略推荐：${ignored}` : ''}` };
}

export class SchedulingChangedError extends Error {}
