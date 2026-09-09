import { activeFacts, validConfirmation, type BoardState } from './types.js';
import { renderPaths } from './report.js';
import { confirmedHttpImpact, confirmedHttpScope } from './confirmed-scope.js';
import { toolScopeSummary } from './tool-scope.js';
import { candidateReason } from './scheduler.js';
import { goalGaps } from './goal-assessment.js';

const safe = (text: string) => text.replace(/\r/g, '').replace(/\n/g, ' ');
export function renderBoard(board: BoardState): string {
  const active = new Set(activeFacts(board).map((f) => f.id));
  const dispatchNote = (id: string) => {
    const reason = board.intents[id].state === 'open' ? candidateReason(board, id, active) : undefined;
    return reason ? `；暂不可派发：${safe(reason)}` : '';
  };
  const gaps = goalGaps(board).map((c) => `条件 ${c.criterion} (${c.status})${c.reason ? `：${safe(c.reason)}` : ''}`);
  const lines = ['# XLoom Blackboard', '', `Revision: ${board.revision}`, `执行：${board.execution} · 调查结果：${board.outcome}`,
    `原因：${safe(board.reason) || '—'}`,
    ...(board.nextIntentId ? [`下一任务推荐：${safe(board.nextIntentId)}（待派发时复核，使用一次）`] : []), '', '## Goal', '', board.goal.request,
    '', '### Scope', '', ...board.goal.scope.map((s) => `- ${safe(s)}`),
    ...(board.toolScope ? ['', '### 用户工具范围', '', ...toolScopeSummary(board).map((s) => `- ${safe(s)}`)] : []),
    '', '### 成功条件', '', ...board.goal.successCriteria.map((s, i) => `${i + 1}. ${safe(s)}`),
    '', `当前目标缺口：${gaps.join('；') || '当前评估均已覆盖；最终结果仍以全局完成判定为准'}`,
    '', '## 事实', '', ...Object.values(board.facts).map((f) => `- ${f.id}${active.has(f.id) ? '' : ' [已被纠正，不再有效]'}：${safe(f.statement)} (${f.evidenceIds.join(', ')})${f.supersedes ? `；纠正 ${f.supersedes}` : ''}`),
    '', '## 假设与当前验证状态', '', ...Object.values(board.hypotheses).map((h) =>
      `- ${h.id} [${h.status}${h.needsReview ? ' / 需要复核' : ''}${h.duplicateOf ? ` / 并入候选 ${h.duplicateOf}` : ''}] ${safe(validConfirmation(board, h) ? confirmedHttpScope(h.httpAssertion) : h.claim)}${validConfirmation(board, h) ? `；原始断言：${safe(h.claim)}` : ''}；事实 ${h.factIds.join(', ')}；缺口 ${h.gaps.map(safe).join('；')}${h.reviewReason ? `；复核原因：${safe(h.reviewReason)}` : ''}`),
    '', '## 探索任务', '', ...Object.values(board.intents).filter((i) => i.kind === 'explore').map((i) =>
      `- ${i.id} [${i.state}] ${safe(i.objective)}${i.reason ? `；${safe(i.reason)}` : ''}${dispatchNote(i.id)}`),
    '', '## 独立验证任务', '', ...Object.values(board.intents).filter((i) => i.kind === 'verify').map((i) =>
      `- ${i.id} [${i.state}] ${safe(i.objective)}；假设 ${i.verifiesHypothesisId}；前提 ${i.prerequisites.map(safe).join('；')}${dispatchNote(i.id)}`),
    '', '## Evidence', '', ...Object.values(board.evidence).map((e) =>
      `- ${e.id} [${e.status} / ${e.kind}] ${e.agent} ${e.runId}/${e.toolCallId} ${e.tool}：${safe(e.summary)}\n  ${e.artifactPaths.map((p) => `\`${p}\``).join(' ')}`),
    '', '## 影响已验证（当前有效）', '', ...Object.values(board.hypotheses).filter((h) => validConfirmation(board, h)).map((h) => {
      const v = h.verification!, run = board.runs[v.runId], intent = board.intents[run.intentId];
      const evidence = [...new Set(h.factIds.flatMap((id) => board.facts[id]?.evidenceIds ?? []))];
      return `- ${h.id}：${safe(confirmedHttpScope(h.httpAssertion))}\n  程序核对的影响：${safe(confirmedHttpImpact(h.httpAssertion))}\n  原始断言：${safe(h.claim)}\n  Proof影响解释：${safe(v.impact)}\n  Proof ${v.runId} / ${run.agentSessionId}；${v.verdict}\n  验证任务前提（原文）：${intent.prerequisites.map(safe).join('；')}\n  Proof对照解释：${safe(v.controls)}\n  Proof响应解释：${safe(v.backendResult)}\n  限制：${safe(v.limitations) || '未说明'}\n  事实：${h.factIds.join(', ')}；Evidence：${evidence.join(', ')}`;
    }),
    '', '## AttackPath', '', ...renderPaths(board),
    '', '## 最近提交', '', board.lastSummary || '尚未提交', '',
    '此文件由 events.jsonl 生成；修改本文件不改变权威状态。', ''];
  return lines.join('\n');
}
