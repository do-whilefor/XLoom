import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { activeFacts, pathState, validPathCheck, type AgentRole, type BoardState, type Intent } from './types.js';
import type { AgentMessage } from '../vendor/pi/agent/types.js';
import type { CustomMessage } from '../vendor/pi/coding-agent/core/messages.js';

export interface CapsuleMessage extends CustomMessage { customType: 'xloom.capsule'; runId: string; revision: number; content: string }
export const isCapsule = (message: AgentMessage): message is CapsuleMessage => message.role === 'custom' && message.customType === 'xloom.capsule';

export function buildCapsule(board: BoardState, intent: Intent, role: AgentRole = 'probe', sessionDir?: string): string {
  const target = intent.verifiesHypothesisId ? board.hypotheses[intent.verifiesHypothesisId] : undefined;
  const review = board.reviewIntentIds.includes(intent.id);
  const related = new Set([intent.id, ...intent.basisIds, ...(target ? [target.id] : [])]);
  for (const run of Object.values(board.runs)) if (run.intentId === intent.id || run.intentId === intent.parentId) {
    for (const e of run.evidenceIds) related.add(e);
  }
  if (review) for (const id of [...Object.keys(board.facts), ...Object.keys(board.hypotheses), ...Object.keys(board.intents)]) related.add(id);
  let size = -1;
  while (size !== related.size) {
    size = related.size;
    for (const p of Object.values(board.attackPaths)) if (related.has(p.id) || related.has(p.verifiesHypothesisId) || p.nodeIds.some((id) => related.has(id))) {
      related.add(p.id); related.add(p.verifiesHypothesisId);
      for (const id of p.nodeIds) related.add(id);
      for (const e of p.edges) { related.add(e.id); for (const id of e.evidenceIds) related.add(id); }
    }
    for (const h of Object.values(board.hypotheses)) if (related.has(h.id) || (h.duplicateOf && related.has(h.duplicateOf)) || h.factIds.some((id) => related.has(id))) {
      related.add(h.id); for (const id of [...h.factIds, ...(h.verification?.factIds ?? [])]) related.add(id);
      if (h.duplicateOf) related.add(h.duplicateOf);
    }
    for (const fact of Object.values(board.facts)) if (related.has(fact.id) || (fact.supersedes && related.has(fact.supersedes)) || fact.evidenceIds.some((id) => related.has(id))) {
      related.add(fact.id); if (fact.supersedes) related.add(fact.supersedes); for (const id of fact.evidenceIds) related.add(id);
    }
  }
  const facts = activeFacts(board).filter((f) => related.has(f.id));
  const hypotheses = Object.values(board.hypotheses).filter((h) => related.has(h.id));
  const evidence = Object.values(board.evidence).filter((e) => related.has(e.id))
    .map((e) => {
      if (!sessionDir) return e;
      // The model can read each absolute path directly. Keep relative paths in
      // the authoritative Board, without duplicating the list in every request.
      const { artifactPaths, ...metadata } = e;
      const absoluteArtifactPaths = artifactPaths.map((p) => join(sessionDir, p));
      for (const path of absoluteArtifactPaths) if (!existsSync(path)) throw new Error(`Evidence ${e.id} 相关材料缺失：${path}；暂停判断`);
      return { ...metadata, absoluteArtifactPaths };
    });
  const cursor = board.agentCursors[role];
  return '[XLoom 当前 Capsule — 程序状态，非新用户请求]\n' + JSON.stringify({
    revision: board.revision, role, goal: board.goal, goalRevision: board.goalRevision,
    currentIntent: intent, facts, hypotheses,
    attackPaths: Object.values(board.attackPaths).filter((p) => related.has(p.id)).map((p) => ({ ...p, state: pathState(board, p), coverage: validPathCheck(board, p) ?? null })),
    supersededFacts: Object.values(board.facts).filter((f) => related.has(f.id) && !facts.some((a) => a.id === f.id)),
    recentChanges: board.changes.filter((c) => c.revision > (cursor?.lastSeenRevision ?? 0) && (c.kind === 'scope_changed' || c.objectIds.some((id) => related.has(id)))),
    intents: Object.values(board.intents).filter((i) => related.has(i.id) || (i.verifiesHypothesisId && related.has(i.verifiesHypothesisId))), evidence,
    taskCounts: { open: Object.values(board.intents).filter((i) => i.state === 'open').length, blocked: Object.values(board.intents).filter((i) => i.state === 'blocked').length },
    previousRuns: Object.values(board.runs).filter((r) => r.intentId === intent.id || evidence.some((e) => e.runId === r.id)), outcome: board.outcome,
    hints: Object.values(board.hints).map(({ id, messageId }) => ({ id, messageId, delivered: cursor?.deliveredHintIds.includes(id) ?? false })),
    lastSeenRevision: cursor?.lastSeenRevision ?? 0, ...(role === 'probe' ? {} : { interpretation: '候选断言为待验证解释，状态不是既定事实。独立重新观察目标并检查适用前提与对照。' }),
    instruction: `只执行当前 ${intent.kind}。实际工具结果带程序生成 Evidence ID。遵循当前 Goal/Scope 及后来用户更改。中断或错误 Run 的副作用结果未知，先检查已有证据和实际状态，不重放旧工具列表。Hint 原文仅来自原生 user 消息。最终输出一个完整 xloom-update。`,
  }); // Sent on every request: omit indentation, preserve every value and reference.
}
