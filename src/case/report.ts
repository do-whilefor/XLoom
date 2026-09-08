import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { combineUsageTotals, responseUsage, type RecordedResponse, type UsageField, type UsageTotals } from '../runtime/usage.js';
import { activeFacts, pathState, validConfirmation, validVerification, type BoardState } from './types.js';
import { confirmedHttpImpact, confirmedHttpScope } from './confirmed-scope.js';
import { toolScopeSummary } from './tool-scope.js';
import { goalAssessmentSupport } from './goal-assessment.js';

export const ordered = <T extends { id: string }>(values: Record<string, T>): T[] => Object.values(values).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
// Markdown is a display projection. It cannot introduce executable HTML or links supplied by a model.
export const cell = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}|]/g, '\\$&')
  .replace(/\b(Bearer\s+)[^\s;,]+/gi, '$1[REDACTED]').replace(/\b((?:api[_-]?key|auth[_-]?token|access[_-]?token|password|cookie|authorization)\s*[:=]\s*)[^\s;,]+/gi, '$1[REDACTED]');
const list = (items: string[]) => items.length ? items.map(cell).join('；') : '无';

export function renderPaths(board: BoardState): string[] {
  const lines: string[] = [];
  for (const p of ordered(board.attackPaths)) {
    const h = board.hypotheses[p.verifiesHypothesisId], v = h?.verification;
    lines.push(`### ${p.id} · ${pathState(board, p)} · r${p.revision}`, '', `原始路径说明：${cell(p.summary)}`,
      ...(h?.httpAssertion ? [`结构化路径范围：${cell(confirmedHttpScope(h.httpAssertion))}；实际覆盖以当前边状态为准。`] : []), '',
      `关联断言：${p.verifiesHypothesisId}。主节点：${p.nodeIds.join(' → ')}。`, '',
      '| 边 | 方向 | 关系 | 条件 | 依据 | 当前覆盖 |', '| --- | --- | --- | --- | --- | --- |');
    for (const e of p.edges) lines.push(`| ${e.id} | ${e.from} → ${e.to} | ${e.relation} | ${cell(e.condition)} | ${e.evidenceIds.join(', ')} | ${e.relation === 'enables' ? e.confirmed ? '已验证' : '未验证' : '关系线索'} |`);
    lines.push('', `阻塞缺口：${list(p.gaps)}`, `候选缺口：${list(h?.gaps ?? [])}`, '');
    if (v?.pathCheck?.pathId === p.id) lines.push(`路径检查出处：Proof ${v.runId}，覆盖版本 r${v.pathCheck.pathRevision}，边 ${v.pathCheck.edgeIds.join(', ')}，complete=${v.pathCheck.complete}（当前效力以上述状态为准）。`,
      `Proof连续性解释：${cell(v.pathCheck.continuity)}`, `验证范围限制：${cell(v.limitations) || '未说明'}`, '');
    if (h?.reviewReason) lines.push(`复核原因：${cell(h.reviewReason)}`, '');
  }
  return lines.length ? lines : ['无；独立问题可以直接依据 Proof 验证成为 Finding。', ''];
}

export interface ReportUsage { total?: UsageTotals; compact?: UsageTotals; unavailable?: boolean }
/** Read only numerical response records; opaque continuation and message content never enter the report. */
export function readReportUsage(sessionDir: string): ReportUsage {
  const total = new Map<string, UsageTotals>(), compact = new Map<string, UsageTotals>();
  try {
    for (const role of ['probe', 'proof']) {
      const path = join(sessionDir, 'agents', `${role}.jsonl`);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        const isCompact = entry.type === 'custom' && entry.customType === 'xloom.compaction-response';
        const m: RecordedResponse | undefined = isCompact ? entry.data : entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message : undefined;
        if (!m || (!m.xloomResponseId && !m.responseId && !m.usageAvailable && !m.usage?.totalTokens && !m.usage?.input && !m.usage?.output)) continue;
        const key = `${role}:${m.xloomResponseId ?? (m.responseId ? `${m.provider}:${m.api}:${m.model}:${m.responseId}` : entry.id)}`;
        const usage = responseUsage(m); total.set(key, usage); if (isCompact) compact.set(key, usage);
      }
    }
    return { total: combineUsageTotals([...total.values()]), compact: combineUsageTotals([...compact.values()]) };
  } catch { return { unavailable: true }; }
}

export function renderReport(board: BoardState, sessionId: string, generatedAt: string, usage: ReportUsage = {}): string {
  const active = new Set(activeFacts(board).map((f) => f.id)), findings = ordered(board.hypotheses).filter((h) => validConfirmation(board, h));
  const goalSupport = goalAssessmentSupport(board);
  const lines = ['# XLoom 当前调查结果', '', `Session: ${cell(sessionId)}`, `Revision: ${board.revision}`, `生成时间：${cell(generatedAt)}`, '报告格式：M6 / 1',
    `执行：${board.execution}；调查结果：${board.outcome}；有效问题：${findings.length}`, `原因：${cell(board.reason) || '尚未结束'}`, '',
    '本文件只对应上述黑板版本；当前效力以 ../blackboard/events.jsonl 为准。历史确认、技术命中和相关性线索不能替代当前有效确认。', '',
    '## Goal 与范围', '', `原始目标：${cell(board.originalGoal.request)}`, `当前目标：${cell(board.goal.request)}`, `起点：${list(board.goal.origin)}`, `范围：${list(board.goal.scope)}`, ''];
  if (board.toolScope) lines.push('### 用户工具范围', '', ...toolScopeSummary(board).map((s) => `- ${cell(s)}`), '');
  lines.push(`当前目标依据：${goalSupport.supported ? '已完整覆盖' : '尚未完整覆盖'}${goalSupport.reason ? `；${cell(goalSupport.reason)}` : ''}`, '');
  board.goal.successCriteria.forEach((text, index) => {
    const reported = board.assessment?.value.criteria.find((c) => c.criterion === index + 1);
    const current = board.assessment?.goalRevision === board.goalRevision ? reported : undefined;
    const support = goalSupport.criteria[index], status = !support.supported && support.status === 'satisfied' ? 'unknown' : support.status;
    const reason = support.supported ? current?.reason : support.reason;
    const original = reported && (reported !== current || reported.status !== status)
      ? `；原始模型评估 ${reported.status}（Goal r${board.assessment!.goalRevision}）：${cell(reported.reason)}；原依据 ${reported.basisIds.join(', ') || '无'}` : '';
    lines.push(`${index + 1}. ${cell(text)} — ${status}；依据 ${current?.basisIds.join(', ') || '无'}；${cell(reason ?? '尚未评估')}${original}`);
  });
  lines.push('', '## 已确认问题', '');
  if (!findings.length) lines.push('当前没有有效的影响确认。', '');
  for (const h of findings) {
    const v = h.verification!, run = board.runs[v.runId], intent = board.intents[run.intentId];
    lines.push(`### ${h.id} · ${cell(confirmedHttpScope(h.httpAssertion))}`, '', `程序核对的影响：${cell(confirmedHttpImpact(h.httpAssertion))}`,
      `原始断言：${cell(h.claim)}`, `Proof影响解释：${cell(v.impact)}`, `验证任务前提（原文）：${list(intent.prerequisites)}`, `Proof：${v.runId} / ${cell(run.agentSessionId)}`,
      `Proof对照解释：${cell(v.controls)}`, `Proof响应解释：${cell(v.backendResult)}`, `范围与限制：${cell(v.limitations) || '未说明'}`,
      `本次验证事实：${v.factIds.join(', ')}；对应 Evidence：${[...new Set(v.factIds.flatMap((id) => board.facts[id].evidenceIds))].join(', ')}`,
      `补充观察事实（不自动扩大独立验证范围）：${h.factIds.filter((id) => !v.factIds.includes(id)).join(', ') || '无'}`, `尚未确认扩展：${list(h.gaps)}`, '');
  }
  lines.push('## 未确认事项', '');
  for (const h of ordered(board.hypotheses).filter((h) => !h.duplicateOf && !validConfirmation(board, h))) {
    lines.push(`- ${h.id} [${h.status}${h.needsReview ? ' / 需要复核' : ''}] ${cell(h.claim)}；事实 ${h.factIds.join(', ')}；缺口 ${list(h.gaps)}；替代解释 ${list(h.alternatives)}`);
    if (h.reviewReason) lines.push(`  复核原因：${cell(h.reviewReason)}`);
    if (h.verification) lines.push(`  验证 ${h.verification.runId} / ${h.verification.verdict}（${validVerification(board, h) ? '当前有效的限定判断' : '历史记录，当前不生效'}）；对照 ${cell(h.verification.controls)}；结果 ${cell(h.verification.backendResult)}；限制 ${cell(h.verification.limitations) || '未说明'}`);
  }
  lines.push('', '## AttackPath', '', ...renderPaths(board), '## 聚合说明', '');
  for (const h of ordered(board.hypotheses).filter((h) => h.duplicateOf)) lines.push(`- ${h.id} 并入候选 ${h.duplicateOf}：${cell(h.claim)}；补充观察 ${h.factIds.join(', ')}；${h.verification ? `原验证 ${h.verification.runId}，范围 ${cell(h.verification.limitations)}` : '没有独立验证'}。主候选不继承此验证。最近相关说明：${cell(board.changes.findLast((c) => c.objectIds.includes(h.id))?.summary ?? '见原提交')}`);
  lines.push('聚合理由见相应 agent_committed.summary / reason；原始断言、来源和验证范围保留在事件历史。', '', '## 后续行动与受阻条件', '');
  for (const i of ordered(board.intents).filter((i) => ['open', 'blocked', 'running'].includes(i.state))) lines.push(`- ${i.id} [${i.kind} / ${i.state}] ${cell(i.objective)}；依据 ${i.basisIds.join(', ')}；前提 ${list(i.prerequisites)}；${cell(i.reason ?? '待执行')}`);
  lines.push('', '## 证据索引', '');
  for (const f of ordered(board.facts)) lines.push(`- ${f.id} [${active.has(f.id) ? '当前有效' : '已纠正'}] ${cell(f.statement)}；Evidence ${f.evidenceIds.join(', ')}${f.supersedes ? `；纠正 ${f.supersedes}` : ''}`);
  lines.push('');
  for (const e of ordered(board.evidence)) {
    const paths = e.artifactPaths.map((p) => {
      const normalized = posix.normalize(p);
      if (!normalized.startsWith('artifacts/') || normalized.includes('\\')) return '材料路径无效';
      return `[${cell(basename(p))}](../${normalized.split('/').map(encodeURIComponent).join('/')})`;
    });
    lines.push(`- ${e.id} · ${e.runId} / ${e.agent} / ${e.tool} / ${e.backend} · ${e.status} / ${e.kind} · ${cell(e.toolCallId)}：${paths.join(' · ')}`);
  }
  lines.push('', '## 用量与限制', '');
  const usageLine = (label: string, u?: UsageTotals) => {
    const field = (key: UsageField) => u?.available.includes(key) ? String(u[key]) : '未知';
    return `${label}：请求 ${u?.requests ?? '未知'}；输入 ${field('input')}；输出 ${field('output')}；缓存读 ${field('cacheRead')}；缓存写 ${field('cacheWrite')}；推理 ${field('reasoning')}；总 token ${field('totalTokens')}；统计${u?.complete ? '完整' : '不完整或未知'}。`;
  };
  lines.push(usageLine('累计（含 Compact）', usage.total), usageLine('其中 Compact（已包含，不另加）', usage.compact));
  const runs = ordered(board.runs);
  const durations = runs.map((r) => r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : undefined);
  lines.push(`Run ${runs.length}；登记工具调用 ${runs.reduce((sum, r) => sum + r.toolCallIds.length, 0)}；Evidence ${Object.keys(board.evidence).length}；已结束 Run 耗时 ${durations.filter((v): v is number => v !== undefined && Number.isFinite(v)).reduce((a, b) => a + b, 0)} ms${durations.some((v) => v === undefined) ? '（未结束 Run 耗时未知）' : ''}。`,
    '推理、缓存均按提供商口径记录，不重复加总；未返回统计及费用为未知。报告生成不调用模型。exhausted 不证明目标绝对安全，blocked 不等于反驳。原始材料保存在本地，单独复制报告不包含全部证据。', '');
  return lines.join('\n');
}
