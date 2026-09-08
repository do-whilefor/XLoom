import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathState, validPathCheck, validConfirmation, type AgentRole, type BoardState, type Evidence, type Intent } from './types.js';
import type { AgentMessage } from '../vendor/pi/agent/types.js';
import type { CustomMessage } from '../vendor/pi/coding-agent/core/messages.js';
import { toolScopeDecision } from './tool-scope.js';
import { applicablePromptRules } from './prompt-rules.js';
import { candidateReason } from './scheduler.js';
import { navigationContextIndex } from './context-navigation.js';
import { goalAssessmentSupport, goalGaps } from './goal-assessment.js';
import { checkEvidenceMaterials, compareIds, contextIndexEntries, digest, excerpt, jsonBytes, PROJECTION_POLICY, type ContextIndexSnapshot } from './context-index.js';

export interface CapsuleManifest {
  policyVersion: string; revision: number; role: AgentRole; intentId: string; fingerprint: string;
  bytes: { mandatory: number; working: number; index: number; overhead: number; total: number };
  budgets: { working: number; index: number; maxCapsule?: number };
  requiredIds: string[]; selected: Array<{ id: string; layer: 'mandatory' | 'working'; reason: string }>;
  folded: Array<{ id: string; reason: string }>;
  sources: Array<{ field: string; bytes: number }>; indexSnapshot?: ContextIndexSnapshot;
}
export interface CapsuleMessage extends CustomMessage {
  customType: 'xloom.capsule'; runId: string; revision: number; content: string; fingerprint?: string; manifest?: CapsuleManifest;
}
export const isCapsule = (message: AgentMessage): message is CapsuleMessage => message.role === 'custom' && message.customType === 'xloom.capsule';
export interface CapsuleOptions { sessionDir?: string; workingBytes?: number; indexBytes?: number; maxCapsuleBytes?: number; }
export interface RenderedCapsule { content: string; fingerprint: string; manifest: CapsuleManifest; }
export class CapsuleBudgetError extends Error {
  constructor(readonly manifest: CapsuleManifest) {
    super(`必需上下文超量：${manifest.bytes.mandatory + manifest.bytes.overhead} bytes，Capsule 可用 ${manifest.budgets.maxCapsule} bytes；暂停，未删除 Scope、纠正/反证或未知动作。占用：${manifest.sources.sort((a, b) => b.bytes - a.bytes).slice(0, 8).map((s) => `${s.field}=${s.bytes}`).join(', ')}`);
  }
}
const HEADER = '[XLoom 当前 Capsule — 程序状态，非新用户请求]\n';
const fieldBytes = (key: string, value: unknown) => Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)},`);

/** Directed hard dependencies only: sharing a Fact or an Evidence never traverses
 * back into every hypothesis/path that happens to mention it. */
export function renderCapsule(board: BoardState, intent: Intent, role: AgentRole = 'probe', options: CapsuleOptions = {}): RenderedCapsule {
  const workingLimit = Math.max(0, Math.min(PROJECTION_POLICY.workingBytes, options.workingBytes ?? PROJECTION_POLICY.workingBytes));
  const indexLimit = Math.max(0, Math.min(PROJECTION_POLICY.indexBytes, options.indexBytes ?? PROJECTION_POLICY.indexBytes));
  const review = board.reviewIntentIds.includes(intent.id), cursor = board.agentCursors[role];
  const goalSupport = goalAssessmentSupport(board);
  const readAllowed = toolScopeDecision(board, role, 'read').allowed;
  const related = new Set<string>(), reasons = new Map<string, string>(), queue: string[] = [];
  const select = (id: string | undefined, reason: string) => { if (id && !related.has(id)) { related.add(id); queue.push(id); reasons.set(id, reason); } };
  const aliases = new Map<string, string[]>();
  for (const h of Object.values(board.hypotheses)) if (h.duplicateOf) aliases.set(h.duplicateOf, [...(aliases.get(h.duplicateOf) ?? []), h.id]);
  const superseding = new Map<string, string[]>(), targetPaths = new Map<string, string[]>(), counterPaths = new Map<string, string[]>();
  for (const f of Object.values(board.facts)) if (f.supersedes) superseding.set(f.supersedes, [...(superseding.get(f.supersedes) ?? []), f.id]);
  for (const p of Object.values(board.attackPaths)) {
    targetPaths.set(p.verifiesHypothesisId, [...(targetPaths.get(p.verifiesHypothesisId) ?? []), p.id]);
    for (const e of p.edges) if (e.relation === 'contradicts') for (const id of [e.from, e.to]) counterPaths.set(id, [...(counterPaths.get(id) ?? []), p.id]);
  }
  select(intent.id, 'current-intent');
  const assessmentBasis = new Set(board.assessment?.goalRevision === board.goalRevision ? board.assessment.value.criteria.flatMap((c) => c.basisIds) : []);
  // Review must inspect the explicit assessment it is about to rely on. This
  // does not traverse reverse dependencies through every shared Fact.
  if (review) for (const id of assessmentBasis) select(id, 'review-goal-assessment-basis');
  const validFindings = new Set(Object.values(board.hypotheses).filter((h) => h.status === 'impact_verified' && validConfirmation(board, h)).map((h) => h.id));
  const goalLinkedFindings = new Set([...validFindings].filter((id) => assessmentBasis.has(id) || board.hypotheses[id].factIds.some((fid) => assessmentBasis.has(fid))));
  const recentIds = new Set(board.changes.filter((c) => c.revision > board.reviewCursor).flatMap((c) => c.objectIds));
  const fullRuns = new Set<string>();
  for (const run of Object.values(board.runs)) if ((run.intentId === intent.id || run.intentId === intent.parentId) &&
    (run.status !== 'completed' || run.evidenceIds.some((id) => board.evidence[id]?.outcomeKnown === false || board.evidence[id]?.execution?.outcome === 'unknown'))) {
    fullRuns.add(run.id); select(run.id, 'current-or-unresolved-run');
    for (const id of run.evidenceIds) select(id, 'current-or-unresolved-action');
  }
  for (let at = 0; at < queue.length; at++) {
    const id = queue[at], f = board.facts[id], h = board.hypotheses[id], i = id === intent.id ? intent : board.intents[id], p = board.attackPaths[id], e = board.evidence[id];
    if (i) { for (const basis of i.basisIds) select(basis, 'explicit-intent-basis'); select(i.verifiesHypothesisId, 'verification-target'); }
    if (f) { for (const eid of f.evidenceIds) select(eid, 'fact-source'); select(f.supersedes, 'superseded-link'); for (const next of superseding.get(id) ?? []) select(next, 'current-correction'); }
    if (h) {
      for (const alias of aliases.get(id) ?? []) select(alias, 'explicit-duplicate-supplement');
      for (const fid of [...h.factIds, ...(h.verification?.factIds ?? [])]) select(fid, 'candidate-and-verification-basis');
      for (const eid of Object.keys(h.verification?.checked?.evidence ?? {})) select(eid, 'B1-observation-binding');
      select(h.duplicateOf, 'duplicate-target'); select(h.verification?.runId, 'verification-provenance');
      for (const pid of targetPaths.get(id) ?? []) select(pid, 'target-path');
    }
    if (p) { select(p.verifiesHypothesisId, 'path-target'); for (const nid of p.nodeIds) select(nid, 'path-node'); for (const edge of p.edges) for (const eid of edge.evidenceIds) select(eid, edge.relation === 'contradicts' ? 'explicit-counterevidence' : 'path-edge-source'); }
    if (e && board.runs[e.runId]) select(e.runId, 'evidence-provenance');
    const run = board.runs[id];
    if (run && (run.status !== 'completed' || run.evidenceIds.some((eid) => board.evidence[eid]?.outcomeKnown === false || board.evidence[eid]?.execution?.outcome === 'unknown'))) {
      fullRuns.add(run.id); for (const eid of run.evidenceIds) select(eid, 'related-unresolved-action');
    }
    for (const pid of counterPaths.get(id) ?? []) select(pid, 'explicit-contradiction');
  }
  const sorted = <T extends { id: string }>(values: T[]) => values.sort((a, b) => compareIds(a.id, b.id));
  const selected = <T extends { id: string }>(values: Record<string, T>) => sorted(Object.values(values).filter((value) => related.has(value.id)));
  const replaced = new Set(Object.values(board.facts).flatMap((f) => f.supersedes ? [f.supersedes] : []));
  const materialProjection = (e: Evidence): unknown => {
    if (!options.sessionDir) {
      if (!readAllowed && e.artifactPaths.length) throw new Error(`必要材料访问缺口：read 被禁且 Evidence ${e.id} 没有可直供的 Session 材料；暂停判断`);
      return e;
    }
    const { artifactPaths, artifactSha256: _integrity, ...metadata } = e;
    const absoluteArtifactPaths = artifactPaths.map((path) => resolve(options.sessionDir!, path));
    if (readAllowed) return { ...metadata, absoluteArtifactPaths };
    // No hidden tool invocation. Literal bytes are normal program input and
    // remain old material, never freshObservation or proof of an unexecuted read.
    const inlineMaterials = absoluteArtifactPaths.map((path) => {
      const bytes = readFileSync(path), text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes) || text.includes('\u0000')) throw new Error(`必要材料访问缺口：read 被禁且 ${e.id} 材料不是可直供 UTF-8 文本；暂停判断`);
      return { path, text, provenance: '已有原始材料，程序直接投影；不是本次新目标观察' };
    });
    return { ...metadata, absoluteArtifactPaths, inlineMaterials };
  };
  // Folding does not cancel integrity checks, including same-revision changes.
  if (options.sessionDir) for (const e of Object.values(board.evidence)) checkEvidenceMaterials(e, options.sessionDir);
  const entries = contextIndexEntries(board);
  const indexSnapshot = options.sessionDir ? navigationContextIndex(board, options.sessionDir) : undefined;
  const rules = applicablePromptRules(board, intent, role);
  const hintIds = new Set<string>();
  const hints = sorted(Object.values(board.hints));
  if (hints.length) hintIds.add(hints[hints.length - 1].id);
  for (const rule of Object.values(board.toolScope?.rules ?? {})) for (const hint of hints) if (hint.messageId === rule?.messageId) hintIds.add(hint.id);
  const mandatory: Record<string, unknown> = {
    revision: board.revision, role, goal: board.goal, goalRevision: board.goalRevision,
    ...(board.toolScope ? { toolScope: { rules: board.toolScope.rules, ...(board.toolScope.error ? { error: board.toolScope.error } : {}) } } : {}),
    currentIntent: intent,
    facts: selected(board.facts).filter((f) => !replaced.has(f.id)), hypotheses: selected(board.hypotheses),
    attackPaths: selected(board.attackPaths).map((p) => ({ ...p, state: pathState(board, p), coverage: validPathCheck(board, p) ?? null })),
    supersededFacts: selected(board.facts).filter((f) => replaced.has(f.id)),
    recentChanges: board.changes.filter((c) => (c.kind === 'scope_changed' && c.revision > (cursor?.lastSeenRevision ?? 0)) ||
      (c.objectIds.some((id) => related.has(id)) && (['superseded', 'refuted'].includes(c.kind) || c.revision > (cursor?.lastSeenRevision ?? 0))))
      .map((c) => ({ ...c, objectIds: c.objectIds.filter((id) => related.has(id)) })),
    intents: selected(board.intents).filter((i) => i.id !== intent.id), evidence: selected(board.evidence).map(materialProjection),
    taskCounts: { open: Object.values(board.intents).filter((i) => i.state === 'open').length, blocked: Object.values(board.intents).filter((i) => i.state === 'blocked').length,
      unresolvedCandidates: Object.values(board.hypotheses).filter((h) => !h.duplicateOf && (h.needsReview || !['impact_verified', 'rejected'].includes(h.status))).length },
    previousRuns: selected(board.runs).map((r) => fullRuns.has(r.id) ? r : ({ id: r.id, intentId: r.intentId, agent: r.agent, agentSessionId: r.agentSessionId,
      inputRevision: r.inputRevision, goalRevision: r.goalRevision, status: r.status, purpose: r.purpose, startedAt: r.startedAt, endedAt: r.endedAt, reason: r.reason,
      evidenceIds: r.evidenceIds.filter((id) => related.has(id)) })),
    outcome: board.outcome, ...(board.assessment?.goalRevision === board.goalRevision ? { goalAssessment: board.assessment.value } : {}),
    goalGaps: goalGaps(board), goalCompletion: { supported: goalSupport.supported, ...(goalSupport.reason ? { reason: goalSupport.reason } : {}) },
    hints: hints.filter((h) => hintIds.has(h.id)).map(({ id, messageId }) => ({ id, messageId, delivered: cursor?.deliveredHintIds.includes(id) ?? false })),
    lastSeenRevision: cursor?.lastSeenRevision ?? 0,
    ...(readAllowed && indexSnapshot ? { materialAccess: { indexRoot: indexSnapshot.rootPath, snapshot: indexSnapshot.snapshot, snapshotRevision: indexSnapshot.revision, currentRevision: board.revision, derived: true,
      note: '此完整历史快照用于导航；成功的派生读取不更新入口。当前对象状态、用户约束和未知动作以本 Capsule 为准。' } } : {}),
    ...(readAllowed && rules.deferred.length ? { ruleReferences: rules.deferred.map(({ id, path }) => ({ id, path })) } : {}),
  };
  const common: Record<string, unknown> = {
    projectionPolicy: PROJECTION_POLICY.version, applicableRules: rules.inline,
    interpretation: review ? 'review：按当前目标覆盖、open/blocked 任务及未决候选概览判断；折叠不等于已完成，索引复读不是新调查变化。' : role === 'proof'
      ? '候选断言为待验证解释，状态不是既定事实。独立重新观察实际主体/对象/状态、适用前提与对照；保留关键反证。'
      : '优先当前目标缺口、探索依据、未知前提与候选；Finding 不等于 Goal 完成。',
    instruction: `只执行当前 ${intent.kind}。实际工具结果带程序生成 Evidence ID。遵循当前 Goal/Scope 及后来用户更改。中断或错误 Run 的副作用结果未知，先检查已有证据和实际状态，不重放旧工具列表。Hint 原文仅来自原生 user 消息。最终输出一个完整 xloom-update。索引摘录非全文，存在路径不表示已经读取；${readAllowed ? '必要原文可用已有 read 分段获取，旧材料不是新目标实验。' : 'read 被用户禁用，必要原文已直接投影；不得绕用其他工具读取索引。'}`,
  };
  const mandatoryJson = JSON.stringify(mandatory), commonJson = JSON.stringify(common);
  const baseContent = HEADER + mandatoryJson.slice(0, -1) + ',' + commonJson.slice(1);
  const baseBytes = Buffer.byteLength(baseContent);
  const requiredIds = [...related].sort(compareIds);
  const manifest: CapsuleManifest = { policyVersion: PROJECTION_POLICY.version, revision: board.revision, role, intentId: intent.id, fingerprint: '',
    bytes: { mandatory: Buffer.byteLength(mandatoryJson) - 2, working: 0, index: 0, overhead: baseBytes - (Buffer.byteLength(mandatoryJson) - 2), total: baseBytes },
    budgets: { working: workingLimit, index: indexLimit, ...(options.maxCapsuleBytes !== undefined ? { maxCapsule: options.maxCapsuleBytes } : {}) }, requiredIds,
    selected: requiredIds.map((id) => ({ id, layer: 'mandatory', reason: reasons.get(id)! })), folded: [],
    sources: [...Object.entries(mandatory), ...Object.entries(common)].map(([field, value]) => ({ field, bytes: fieldBytes(field, value) })), ...(indexSnapshot ? { indexSnapshot } : {}),
  };
  if (options.maxCapsuleBytes !== undefined && baseBytes > options.maxCapsuleBytes) throw new CapsuleBudgetError(manifest);
  const remaining = () => (options.maxCapsuleBytes ?? Infinity) - baseBytes - manifest.bytes.working - manifest.bytes.index;
  // Working material is an explicitly labelled excerpt; never a second full graph.
  const candidateIds = new Map<string, string>();
  for (const h of Object.values(board.hypotheses)) if (!related.has(h.id) && (review || h.factIds.some((id) => related.has(id)))) candidateIds.set(h.id, review ? 'review-unresolved-overview' : 'shared-basis-candidate-overview');
  for (const i of Object.values(board.intents)) if (!related.has(i.id) && (['open', 'blocked'].includes(i.state) || i.parentId === intent.id || i.id === intent.parentId || !!i.verifiesHypothesisId && related.has(i.verifiesHypothesisId))) candidateIds.set(i.id, 'goal-task-overview');
  for (const r of Object.values(board.runs)) if (!related.has(r.id) && (r.intentId === intent.id || r.intentId === intent.parentId)) candidateIds.set(r.id, 'older-related-run');
  const currentFactIds = new Set(Object.keys(board.facts).filter((id) => !replaced.has(id)));
  const dispatchReasons = new Map([...candidateIds.keys()].filter((id) => board.intents[id]).map((id) => [id, candidateReason(board, id, currentFactIds)]));
  const ordered = entries.filter((e) => candidateIds.has(e.id)).sort((a, b) => {
    const priority = (id: string) => review && goalLinkedFindings.has(id) ? -2
      : review && validFindings.has(id) && recentIds.has(id) ? -1
      : board.intents[id] && !dispatchReasons.get(id) ? 0
      : board.hypotheses[id]?.needsReview || ['disputed', 'rejected'].includes(board.hypotheses[id]?.status) ? 1 : board.intents[id] ? 2 : 3;
    return priority(a.id) - priority(b.id) || compareIds(a.id, b.id);
  });
  const working: unknown[] = [], workIds = new Set<string>();
  for (const entry of ordered) {
    const value = { id: entry.id, type: entry.type, status: entry.status, excerpt: entry.excerpt,
      ...(board.intents[entry.id] ? { kind: board.intents[entry.id].kind, state: board.intents[entry.id].state,
        objective: excerpt(board.intents[entry.id].objective), basisIds: board.intents[entry.id].basisIds.slice(0, 8),
        basisCount: board.intents[entry.id].basisIds.length, prerequisites: excerpt(board.intents[entry.id].prerequisites.join('; ')),
        ...(board.intents[entry.id].reason ? { reason: excerpt(board.intents[entry.id].reason!) } : {}),
        dispatch: dispatchReasons.get(entry.id) ?? '结构可派发；文本前提与语义范围仍须在正常回合核对' } : {}),
      ...(board.hypotheses[entry.id] ? { gaps: excerpt(board.hypotheses[entry.id].gaps.join('; ')), alternatives: excerpt(board.hypotheses[entry.id].alternatives.join('; ')),
        ...(validFindings.has(entry.id) ? { currentConfirmation: 'valid', factIds: board.hypotheses[entry.id].factIds.slice(0, 8),
          factCount: board.hypotheses[entry.id].factIds.length, proofRunId: board.hypotheses[entry.id].verification!.runId,
          ...(goalLinkedFindings.has(entry.id) ? { goalAssessmentRelation: 'shares explicit assessment Fact basis; criterion coverage still requires model assessment' } : {}) } : {}) } : {}) };
    const bytes = fieldBytes('working', [...working, value]);
    if (bytes > workingLimit || bytes - manifest.bytes.working > remaining()) continue;
    working.push(value); workIds.add(entry.id); manifest.bytes.working = bytes;
    manifest.selected.push({ id: entry.id, layer: 'working', reason: candidateIds.get(entry.id)! });
  }
  const index: Record<string, unknown> = {};
  const putIndex = (key: string, value: unknown) => {
    const bytes = fieldBytes('contextIndex', { ...index, [key]: value });
    if (bytes > indexLimit || bytes - manifest.bytes.index > remaining()) return false;
    index[key] = value; manifest.bytes.index = bytes; return true;
  };
  if (readAllowed && indexSnapshot) putIndex('overview', { objectCount: indexSnapshot.objectCount, pageCount: indexSnapshot.pageCount, directoryPageCount: indexSnapshot.directoryPageCount, note: '从 materialAccess.indexRoot 的轻量目录定位，再读相关完整页；metadata 不是新目标观察' });
  if (readAllowed && rules.deferred.length) putIndex('rules', rules.deferred.map(({ id, summary }) => ({ id, summary })));
  for (const entry of entries) if (!related.has(entry.id) && !workIds.has(entry.id)) manifest.folded.push({ id: entry.id, reason: candidateIds.has(entry.id) ? 'working-byte-budget' : 'no-directed-task-dependency; relation not proven irrelevant' });
  const payload = { ...mandatory, ...common, ...(working.length ? { working } : {}), ...(Object.keys(index).length ? { contextIndex: index } : {}) };
  const content = HEADER + JSON.stringify(payload);
  manifest.bytes.total = Buffer.byteLength(content);
  // Every byte has exactly one owner, including commas and wrapper text.
  manifest.bytes.overhead = manifest.bytes.total - manifest.bytes.mandatory - manifest.bytes.working - manifest.bytes.index;
  const fingerprint = digest(content); manifest.fingerprint = fingerprint;
  return { content, fingerprint, manifest };
}

export function buildCapsule(board: BoardState, intent: Intent, role: AgentRole = 'probe', sessionDir?: string): string {
  return renderCapsule(board, intent, role, { sessionDir }).content;
}
