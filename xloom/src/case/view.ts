import { activeFacts, validConfirmation, type BoardState } from './types.js';
import { renderPaths } from './report.js';

const safe = (text: string) => text.replace(/\r/g, '').replace(/\n/g, ' ');
export function renderBoard(board: BoardState): string {
  const active = new Set(activeFacts(board).map((f) => f.id));
  const lines = ['# XLoom Blackboard', '', `Revision: ${board.revision}`, `执行：${board.execution} · 调查结果：${board.outcome}`,
    `原因：${safe(board.reason) || '—'}`, '', '## Goal', '', board.goal.request,
    '', '### Scope', '', ...board.goal.scope.map((s) => `- ${safe(s)}`),
    '', '### 成功条件', '', ...board.goal.successCriteria.map((s, i) => `${i + 1}. ${safe(s)}`),
    '', '## 事实', '', ...Object.values(board.facts).map((f) => `- ${f.id}${active.has(f.id) ? '' : ' [已被纠正，不再有效]'}：${safe(f.statement)} (${f.evidenceIds.join(', ')})${f.supersedes ? `；纠正 ${f.supersedes}` : ''}`),
    '', '## 假设与当前验证状态', '', ...Object.values(board.hypotheses).map((h) =>
      `- ${h.id} [${h.status}${h.needsReview ? ' / 需要复核' : ''}${h.duplicateOf ? ` / 并入候选 ${h.duplicateOf}` : ''}] ${safe(h.claim)}；事实 ${h.factIds.join(', ')}；缺口 ${h.gaps.map(safe).join('；')}`),
    '', '## 探索任务', '', ...Object.values(board.intents).filter((i) => i.kind === 'explore').map((i) =>
      `- ${i.id} [${i.state}] ${safe(i.objective)}${i.reason ? `；${safe(i.reason)}` : ''}`),
    '', '## 独立验证任务', '', ...Object.values(board.intents).filter((i) => i.kind === 'verify').map((i) =>
      `- ${i.id} [${i.state}] ${safe(i.objective)}；假设 ${i.verifiesHypothesisId}；前提 ${i.prerequisites.map(safe).join('；')}`),
    '', '## Evidence', '', ...Object.values(board.evidence).map((e) =>
      `- ${e.id} [${e.status} / ${e.kind}] ${e.agent} ${e.runId}/${e.toolCallId} ${e.tool}：${safe(e.summary)}\n  ${e.artifactPaths.map((p) => `\`${p}\``).join(' ')}`),
    '', '## 影响已验证（当前有效）', '', ...Object.values(board.hypotheses).filter((h) => validConfirmation(board, h)).map((h) => {
      const v = h.verification!, run = board.runs[v.runId], intent = board.intents[run.intentId];
      const evidence = [...new Set(h.factIds.flatMap((id) => board.facts[id]?.evidenceIds ?? []))];
      return `- ${h.id}：${safe(h.claim)}\n  Proof ${v.runId} / ${run.agentSessionId}；${v.verdict}\n  前提：${intent.prerequisites.map(safe).join('；')}\n  对照：${safe(v.controls)}\n  服务端：${safe(v.backendResult)}\n  影响：${safe(v.impact)}\n  限制：${safe(v.limitations) || '未说明'}\n  事实：${h.factIds.join(', ')}；Evidence：${evidence.join(', ')}`;
    }),
    '', '## AttackPath', '', ...renderPaths(board),
    '', '## 最近提交', '', board.lastSummary || '尚未提交', '',
    '此文件由 events.jsonl 生成；修改本文件不改变权威状态。', ''];
  return lines.join('\n');
}
