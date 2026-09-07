import { Type, type TProperties, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { activeFacts, backendForTool, hasToolSource, coversMainPath, refreshValidity, validVerification, type AttackPath, type AttackPathEdge, type BoardState, type Commit, type Fact, type Hypothesis, type IdPrefix, type Intent, type RunRecord, type XLoomUpdate } from './types.js';

const str = Type.String({ minLength: 1, pattern: '\\S' });
const strings = Type.Array(str);
const object = <T extends TProperties>(fields: T) => Type.Object(fields, { additionalProperties: false });
const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map((v) => Type.Literal(v)));
const verification = object({ verdict: enumOf('supported', 'rejected', 'disputed'), factIds: Type.Array(str, { minItems: 1 }),
  controls: str, backendResult: str, impact: str, limitations: Type.String(),
  pathCheck: Type.Optional(object({ pathId: str, edgeIds: Type.Array(str, { minItems: 1, uniqueItems: true }), complete: Type.Boolean(), continuity: str })) });
const hypFields = { claim: str, status: enumOf('lead', 'technical_hit', 'impact_verified', 'rejected', 'disputed'), factIds: strings, alternatives: strings, gaps: strings };
const intentFields = { kind: enumOf('explore', 'verify'), objective: str, basisIds: strings, prerequisites: strings,
  parentId: Type.Optional(str), verifiesHypothesisId: Type.Optional(str), state: enumOf('open', 'blocked') };
const partial = (fields: TProperties): Record<string, TSchema> => Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, Type.Optional(schema)]));
const patchIntentFields = partial(intentFields); delete patchIntentFields.kind;
patchIntentFields.state = Type.Optional(enumOf('open', 'blocked', 'cancelled'));
const edgeFields = { from: str, to: str, relation: enumOf('supports', 'contradicts', 'related_to', 'enables'), condition: str, evidenceIds: Type.Array(str, { minItems: 1, uniqueItems: true }) };
const pathFields = { summary: str, nodeIds: Type.Array(str, { minItems: 2, uniqueItems: true }),
  edges: Type.Array(Type.Union([object({ ref: str, ...edgeFields }), object({ id: str, ...edgeFields })])), gaps: strings, verifiesHypothesisId: str };
const schema = object({
  summary: str, facts: Type.Array(object({ ref: str, statement: str, evidenceIds: Type.Array(str, { minItems: 1 }), supersedes: Type.Optional(str) })),
  hypotheses: Type.Array(Type.Union([object({ ref: str, ...hypFields, duplicateOf: Type.Optional(str) }), object({ id: str, ...partial(hypFields), duplicateOf: Type.Optional(Type.Union([str, Type.Null()])), verification: Type.Optional(verification) })])),
  intents: Type.Array(Type.Union([object({ ref: str, ...intentFields }), object({ id: str, ...patchIntentFields })])),
  attackPaths: Type.Array(Type.Union([object({ ref: str, ...pathFields }), object({ id: str, ...partial(pathFields) })])), intentState: enumOf('open', 'done', 'blocked', 'cancelled'),
  next_move: enumOf('continue', 'widen', 'verify', 'stop'), reason: str,
  goalAssessment: Type.Optional(object({ criteria: Type.Array(object({ criterion: Type.Integer({ minimum: 1 }),
    status: enumOf('satisfied', 'unknown', 'rejected'), basisIds: strings, reason: str })) })),
});
const checker = TypeCompiler.Compile(schema);

export function parseUpdate(text: string): XLoomUpdate {
  const starts = [...text.matchAll(/^\s*```xloom-update\s*$/gm)];
  const blocks = [...text.matchAll(/^[ \t]*```xloom-update[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/gm)];
  if (starts.length !== 1 || blocks.length !== 1) throw new Error('最终回复必须且只能包含一个完整的 xloom-update JSON 代码块');
  let value: unknown;
  try { value = JSON.parse(blocks[0][1]); } catch { throw new Error('xloom-update 不是合法 JSON；没有自动修复或重试'); }
  return validateUpdateShape(value);
}
export function validateUpdateShape(value: unknown): XLoomUpdate {
  if (!checker.Check(value)) {
    const errors = [...checker.Errors(value)].slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`).join('; ');
    throw new Error(`XLoomUpdate 字段或状态非法：${errors}`);
  }
  return value as unknown as XLoomUpdate;
}
export function hideUpdateBlock(text: string, streaming = true): string {
  let visible = text.replace(/^[ \t]*```xloom-update\b[^\n]*\n[\s\S]*?(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/gim, '');
  const marker = /^[ \t]*```xloom-update\b/im.exec(visible);
  if (marker) visible = visible.slice(0, marker.index);
  if (streaming) {
    const last = visible.lastIndexOf('\n') + 1;
    const line = visible.slice(last).trimStart();
    if (line && '```xloom-update'.startsWith(line)) visible = visible.slice(0, last);
  }
  return visible.trimEnd();
}

export function normalizeUpdate(raw: XLoomUpdate, board: BoardState, run: RunRecord): Commit {
  const update = validateUpdateShape(raw);
  if (run.status !== 'running' || board.runs[run.id]?.status !== 'running') throw new Error('该 Run 已经结束，不能重复提交');
  const actual = board.runs[run.id];
  if (board.execution === 'paused' || ['agent', 'agentSessionId', 'intentId'].some((key) => actual[key as keyof RunRecord] !== run[key as keyof RunRecord])) throw new Error('Run 已暂停或实际执行来源不符');
  const currentIntent = board.intents[run.intentId];
  if (run.agent !== (currentIntent.kind === 'verify' ? 'proof' : 'probe')) throw new Error('角色与当前任务不符');
  const counters = { ...board.counters };
  const refs: Record<string, string> = Object.create(null);
  const existing = new Set([...Object.keys(board.facts), ...Object.keys(board.hypotheses), ...Object.keys(board.intents), ...Object.keys(board.evidence), ...Object.keys(board.attackPaths), ...Object.values(board.attackPaths).flatMap((p) => p.edges.map((e) => e.id))]);
  const reserve = (ref: string, prefix: IdPrefix) => {
    if (!ref.trim() || Object.hasOwn(refs, ref) || existing.has(ref) || /^(?:[IREFHNP]|PE)\d+$/.test(ref)) throw new Error(`ref 不唯一或与持久 ID 冲突：${ref}`);
    refs[ref] = `${prefix}${++counters[prefix]}`;
  };
  update.facts.forEach((f) => reserve(f.ref, 'F'));
  update.hypotheses.forEach((h) => { if ('ref' in h) reserve(h.ref, 'H'); });
  update.intents.forEach((i) => { if ('ref' in i) reserve(i.ref, 'I'); });
  update.attackPaths.forEach((p) => { if ('ref' in p) reserve(p.ref, 'P'); for (const e of p.edges ?? []) if ('ref' in e) reserve(e.ref, 'PE'); });
  const resolveRef = (id: string) => Object.hasOwn(refs, id) ? refs[id] : id;
  const unique = (ids: string[]) => [...new Set(ids.map(resolveRef))];
  const effective = new Set(activeFacts(board).map((f) => f.id));
  const replaced = new Set<string>();
  const facts: Fact[] = update.facts.map((f) => {
    if (!f.statement.trim()) throw new Error('Fact statement 不可为空');
    for (const id of f.evidenceIds) {
      const evidence = board.evidence[id];
      if (!Object.hasOwn(board.evidence, id) || !hasToolSource(board.runs[evidence.runId], evidence) || !board.runs[evidence.runId]?.evidenceIds.includes(id) || evidence.agent !== board.runs[evidence.runId].agent) throw new Error(`不存在或来源无效的 Evidence：${id}`);
      if (evidence.kind === 'derived') throw new Error(`${id} 来自黑板、会话或模型生成材料，不能作为新的目标验证证据`);
      if (evidence.backend !== backendForTool(evidence.tool)) throw new Error(`${id} 工具与实际 backend 来源不符`);
    }
    if (f.supersedes && (!effective.has(f.supersedes) || replaced.has(f.supersedes))) throw new Error(`supersedes 必须指向一个未被纠正的既有 Fact：${f.supersedes}`);
    if (f.supersedes) replaced.add(f.supersedes);
    return { id: refs[f.ref], statement: f.statement, evidenceIds: [...new Set(f.evidenceIds)], ...(f.supersedes ? { supersedes: f.supersedes } : {}) };
  });
  for (const id of replaced) effective.delete(id);
  facts.forEach((f) => effective.add(f.id));
  const allFacts = { ...board.facts, ...Object.fromEntries(facts.map((f) => [f.id, f])) };
  const seenHyp = new Set<string>();
  const hypotheses: Hypothesis[] = update.hypotheses.map((draft) => {
    const id = 'ref' in draft ? refs[draft.ref] : draft.id;
    if (seenHyp.has(id)) throw new Error(`同批 Hypothesis 重复更新：${id}`); seenHyp.add(id);
    if (!('ref' in draft) && !Object.hasOwn(board.hypotheses, id)) throw new Error(`Hypothesis 不存在：${id}`);
    const { ref: _ref, ...fields } = draft as typeof draft & { ref?: string };
    const h = { ...board.hypotheses[id], ...fields, id } as Hypothesis;
    h.factIds = unique(h.factIds);
    for (const id of h.factIds) if (!effective.has(id) && ('ref' in draft || draft.factIds !== undefined)) throw new Error(`假设引用了不存在或已被纠正的 Fact：${id}`);
    if (h.status === 'technical_hit' && !h.factIds.length) throw new Error('technical_hit 必须有实际 Fact 支撑');
    if (draft.duplicateOf === null) delete h.duplicateOf;
    else if (h.duplicateOf) h.duplicateOf = resolveRef(h.duplicateOf);
    h.needsReview = board.hypotheses[id]?.needsReview ?? false;
    const v = 'verification' in draft ? draft.verification : undefined;
    if ('ref' in draft && (h.status === 'impact_verified' || v)) throw new Error('新建 Hypothesis 只能建立候选，不能直接确认');
    if (run.agent === 'probe' && (v || draft.status === 'impact_verified')) throw new Error('Probe 不能提交 verification 或 impact_verified');
    if (draft.status === 'impact_verified' && !v) throw new Error('影响确认必须提交本次 Proof verification');
    // A previous verification cannot silently certify a changed claim or chain.
    const old = board.hypotheses[id];
    if (v && old.claim !== h.claim) throw new Error('验证中不能改写待验证断言；先保存候选再安排明确的新验证');
    if (old && !v && (old.claim !== h.claim || old.factIds.some((fid) => !h.factIds.includes(fid)) ||
      (old.verification && (JSON.stringify(old.gaps) !== JSON.stringify(h.gaps) || JSON.stringify(old.alternatives) !== JSON.stringify(h.alternatives) || old.status !== h.status)))) {
      if (!['rejected', 'disputed'].includes(h.status)) h.status = 'disputed';
      h.needsReview = true;
    }
    if (v) {
      if (run.agent !== 'proof' || currentIntent.kind !== 'verify' || currentIntent.verifiesHypothesisId !== id || !board.hypotheses[id]) throw new Error('verification 必须指向当前 Proof verify 的既有目标');
      if (!board.agentSessions.proof || !board.agentSessions.probe || run.agentSessionId !== board.agentSessions.proof || run.agentSessionId === board.agentSessions.probe) throw new Error('Proof Session 必须实际独立于 Probe');
      const factIds = unique(v.factIds);
      for (const fid of factIds) {
        if (!effective.has(fid) || !h.factIds.includes(fid)) throw new Error('verification Fact 不存在、失效或不在候选证据链中');
        for (const eid of allFacts[fid].evidenceIds) {
          const e = board.evidence[eid], origin = e && board.runs[e.runId];
          if (!e || e.kind !== 'observation' || e.status !== 'observed' || !hasToolSource(origin, e) || !origin.evidenceIds.includes(eid) || e.agent !== origin.agent || (origin.id !== run.id && origin.status !== 'completed')) throw new Error('verification 只接受有效、完成的真实观察，不能使用派生材料、写回执、中断或失败结果');
        }
      }
      if (!factIds.some((fid) => allFacts[fid].evidenceIds.some((eid) => {
        const e = board.evidence[eid]; return e.runId === run.id && e.agent === 'proof' && e.freshObservation !== false && hasToolSource(run, e) && run.evidenceIds.includes(e.id);
      }))) throw new Error('verification 缺少本次 Proof 的新真实观察');
      if ((v.verdict === 'supported' && !['technical_hit', 'impact_verified'].includes(h.status)) || (v.verdict !== 'supported' && h.status !== v.verdict)) throw new Error('verdict 与 Hypothesis 状态不一致');
      if (h.status === 'impact_verified') {
        if (h.gaps.length || h.alternatives.length || !currentIntent.prerequisites.length) throw new Error('影响确认仍有关键缺口、替代解释或缺少前提');
        if (run.goalRevision !== board.goalRevision || Object.values(board.hints).some((hint) => !board.agentCursors.proof?.deliveredHintIds.includes(hint.id))) throw new Error('当前目标或用户输入尚未由本次 Proof 审视');
        if (update.intentState !== 'done') throw new Error('影响确认需要当前 verify 同批完成');
        for (const fid of h.factIds) if (allFacts[fid].evidenceIds.some((eid) => board.evidence[eid].status !== 'observed' || board.evidence[eid].kind !== 'observation')) throw new Error('影响证据链包含未完成或非观察材料');
      }
      const { pathCheck, ...verificationFields } = v;
      h.verification = { ...verificationFields, factIds, runId: run.id,
        ...(pathCheck ? { pathCheck: { ...pathCheck, pathId: resolveRef(pathCheck.pathId), edgeIds: unique(pathCheck.edgeIds), pathRevision: 0 } } : {}) };
      h.needsReview = false;
    }
    return h;
  });
  const allHypotheses = { ...structuredClone(board.hypotheses), ...Object.fromEntries(hypotheses.map((h) => [h.id, h])) };
  for (const h of Object.values(allHypotheses)) if (h.duplicateOf) {
    if (h.duplicateOf === h.id || !Object.hasOwn(allHypotheses, h.duplicateOf) || allHypotheses[h.duplicateOf].duplicateOf ||
      Object.values(board.hypotheses).some((other) => other.duplicateOf === h.id)) throw new Error(`duplicateOf 必须指向本 Case 的非重复候选，禁止自引用、重复链或再次合并主候选：${h.id}`);
  }
  const attackPaths: AttackPath[] = [];
  const seenPaths = new Set<string>();
  for (const draft of update.attackPaths) {
    const id = 'ref' in draft ? refs[draft.ref] : draft.id, old = board.attackPaths[id];
    if (seenPaths.has(id) || (!('ref' in draft) && !Object.hasOwn(board.attackPaths, id))) throw new Error(`路径不存在或同批重复：${id}`);
    seenPaths.add(id);
    const { edges: edgeDrafts, ref: _ref, ...fields } = draft as typeof draft & { ref?: string };
    const path = { ...old, ...fields, id, revision: old?.revision ?? board.revision + 1 } as AttackPath;
    path.summary = path.summary.trim(); path.nodeIds = path.nodeIds.map(resolveRef); path.gaps = [...new Set(path.gaps.map((s) => s.trim()))].sort();
    path.verifiesHypothesisId = resolveRef(path.verifiesHypothesisId);
    const target = allHypotheses[path.verifiesHypothesisId];
    if (!target || new Set(path.nodeIds).size !== path.nodeIds.length) throw new Error('路径必须引用有效目标且节点不能重复');
    for (const nid of path.nodeIds) {
      if (!effective.has(nid) && !Object.hasOwn(allHypotheses, nid)) throw new Error(`路径节点不存在或 Fact 已失效：${nid}`);
      const deps = allFacts[nid] ? [nid] : allHypotheses[nid].factIds;
      if (deps.some((fid) => !target.factIds.includes(fid))) throw new Error('路径节点关键 Fact 必须同时进入关联 Hypothesis.factIds');
    }
    const seenEdges = new Set<string>();
    path.edges = edgeDrafts ? edgeDrafts.map((e): AttackPathEdge => {
      const eid = 'ref' in e ? refs[e.ref] : e.id;
      if (seenEdges.has(eid) || (!('ref' in e) && !old?.edges.some((oe) => oe.id === eid))) throw new Error(`边必须属于当前既有路径且不能重复：${eid}`);
      seenEdges.add(eid);
      return { id: eid, from: resolveRef(e.from), to: resolveRef(e.to), relation: e.relation, condition: e.condition.trim(), evidenceIds: unique(e.evidenceIds).sort(), confirmed: false };
    }) : structuredClone(old?.edges ?? []);
    for (const e of path.edges) {
      if (e.from === e.to || !path.nodeIds.includes(e.from) || !path.nodeIds.includes(e.to)) throw new Error('路径边端点必须是本路径中不同的有效节点');
      for (const eid of e.evidenceIds) {
        const ev = board.evidence[eid], origin = ev && board.runs[ev.runId];
        if (!ev || !hasToolSource(origin, ev) || !origin.evidenceIds.includes(eid) || ev.kind !== 'observation' || ev.status !== 'observed' ||
          (origin.id !== run.id && origin.status !== 'completed') || !target.factIds.some((fid) => effective.has(fid) && allFacts[fid].evidenceIds.includes(eid))) throw new Error('路径连接依据须有真实有效来源，并由目标的有效 Fact 显式引用');
      }
    }
    path.edges.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    const content = (p: AttackPath) => JSON.stringify({ summary: p.summary, nodeIds: p.nodeIds, edges: p.edges.map(({ confirmed: _c, ...e }) => e), gaps: p.gaps, verifiesHypothesisId: p.verifiesHypothesisId });
    if (!old || content(path) !== content(old)) path.revision = board.revision + 1;
    attackPaths.push(path);
  }
  const allPaths = { ...structuredClone(board.attackPaths), ...Object.fromEntries(attackPaths.map((p) => [p.id, p])) };
  for (const h of hypotheses) if (h.verification?.runId === run.id) {
    const c = h.verification.pathCheck;
    if (h.duplicateOf) throw new Error('重复候选不能提交验证；请明确验证主候选');
    if (c) {
      const p = allPaths[c.pathId];
      if (!p || p.verifiesHypothesisId !== currentIntent.verifiesHypothesisId || p.verifiesHypothesisId !== h.id) throw new Error(`pathCheck 必须引用当前 verify 目标关联路径：任务目标 ${currentIntent.verifiesHypothesisId}；${c.pathId} 的目标 ${p?.verifiesHypothesisId ?? '不存在'}。请为路径目标明确安排 verify`);
      const missingFacts = p.nodeIds.flatMap((id) => allFacts[id] ? [id] : allHypotheses[id]?.factIds ?? []).filter((id) => !h.factIds.includes(id));
      const missingEvidence = p.edges.flatMap((e) => e.evidenceIds).filter((id) => !h.factIds.some((fid) => effective.has(fid) && allFacts[fid].evidenceIds.includes(id)));
      if (missingFacts.length || missingEvidence.length) throw new Error(`路径 ${p.id} 的关键依据必须同时保留在 ${h.id}.factIds：Fact ${[...new Set(missingFacts)].join(', ') || '无'}；Evidence ${[...new Set(missingEvidence)].join(', ') || '无'}。若依据已改变，请同批更新路径节点和边依据`);
      c.pathRevision = p.revision;
      if (c.edgeIds.some((id) => !p.edges.some((e) => e.id === id && e.relation === 'enables'))) throw new Error('pathCheck 只接受本路径 enables 边');
      if (c.complete && (h.status !== 'impact_verified' || h.verification.verdict !== 'supported' || p.gaps.length || !coversMainPath(p, c))) throw new Error('完整路径确认需要 supported、影响确认、完整唯一主连接覆盖及无关键 gaps');
      if (!c.complete && h.status === 'impact_verified') throw new Error('部分路径支持不能成为影响确认');
    } else if (h.status === 'impact_verified' && Object.values(allPaths).some((p) => p.verifiesHypothesisId === h.id)) throw new Error('路径断言的影响确认必须提交完整 pathCheck');
  }
  const checkBasis = (ids: string[]) => {
    for (const id of ids) if (!effective.has(id) && !Object.hasOwn(allHypotheses, id)) throw new Error(`basisIds 引用不存在或失效：${id}`);
  };
  const seenIntent = new Set<string>();
  const intents: Intent[] = update.intents.map((draft) => {
    const id = 'ref' in draft ? refs[draft.ref] : draft.id;
    if (id === run.intentId) throw new Error('当前任务只能通过 intentState 更新');
    if (seenIntent.has(id)) throw new Error(`同批 Intent 重复更新：${id}`); seenIntent.add(id);
    if (!('ref' in draft) && !Object.hasOwn(board.intents, id)) throw new Error(`Intent 不存在：${id}`);
    if (!('ref' in draft) && ['done', 'cancelled', 'running'].includes(board.intents[id].state)) throw new Error(`不能改写已经结束或正在执行的任务：${id}`);
    const { ref: _ref, ...fields } = draft as typeof draft & { ref?: string };
    const i = { ...board.intents[id], ...fields, id, createdRevision: board.intents[id]?.createdRevision ?? board.revision + 1 } as Intent;
    i.basisIds = unique(i.basisIds); checkBasis(i.basisIds);
    if (i.parentId) i.parentId = resolveRef(i.parentId);
    if (i.verifiesHypothesisId) i.verifiesHypothesisId = resolveRef(i.verifiesHypothesisId);
    if (i.kind === 'verify') {
      if (!i.verifiesHypothesisId || !Object.hasOwn(allHypotheses, i.verifiesHypothesisId) || !i.prerequisites.length) throw new Error('verify Intent 必须引用候选假设并说明实际前提');
    } else if (i.verifiesHypothesisId) throw new Error('不能将独立验证任务伪装为 explore');
    return i;
  });
  const allIntents = { ...structuredClone(board.intents), ...Object.fromEntries(intents.map((i) => [i.id, i])) };
  allIntents[run.intentId] = { ...allIntents[run.intentId], state: update.intentState };
  for (const i of Object.values(allIntents)) if (i.kind === 'verify' && ['open', 'blocked'].includes(i.state) && allHypotheses[i.verifiesHypothesisId!]?.duplicateOf) {
    i.state = 'blocked'; i.reason = `候选 ${i.verifiesHypothesisId} 已并入 ${allHypotheses[i.verifiesHypothesisId!].duplicateOf}；保留原验证目标，需要验证主候选时明确创建新任务`;
    if (i.id !== run.intentId && !intents.some((other) => other.id === i.id)) intents.push(i);
  }
  for (const i of intents) {
    if (i.parentId && (!Object.hasOwn(allIntents, i.parentId) || i.parentId === i.id)) throw new Error(`parentId 无效：${i.parentId}`);
    const visited = new Set<string>([i.id]); let parent = i.parentId;
    while (parent) { if (visited.has(parent)) throw new Error('Intent parentId 形成循环'); visited.add(parent); parent = allIntents[parent]?.parentId; }
  }
  const openExplore = Object.values(allIntents).some((i) => i.state === 'open');
  // Exact equivalent tasks are actionable duplicates; semantic experiments remain the Agent's judgment.
  const openVerifications = Object.values(allIntents).filter((i) => i.kind === 'verify' && ['open', 'blocked'].includes(i.state));
  for (const i of intents.filter((i) => !board.intents[i.id] && i.kind === 'verify')) {
    if (openVerifications.some((other) => other.id !== i.id && other.verifiesHypothesisId === i.verifiesHypothesisId && other.objective.trim() === i.objective.trim() && JSON.stringify(other.prerequisites) === JSON.stringify(i.prerequisites))) throw new Error('已有等价待验证任务，请引用或更新它');
  }
  const verify = Object.values(allIntents).some((i) => i.kind === 'verify' && ['open', 'blocked'].includes(i.state));
  if (update.next_move === 'continue' && !openExplore) throw new Error('continue 缺少可继续的任务');
  if (update.next_move === 'widen' && !intents.some((i) => !board.intents[i.id] && i.kind === 'explore' && i.state === 'open')) throw new Error('widen 必须提出新的可执行探索方向');
  if (update.next_move === 'verify' && !verify) throw new Error('verify 缺少有效的待验证任务');
  if (update.next_move === 'stop' && update.intentState === 'open') throw new Error('stop 不能将当前任务留为 open');
  if (run.purpose === 'review' && update.intentState === 'open') throw new Error('收尾评估不能重新开放自身；有实际新方向时提出新的 explore');
  const assessment = structuredClone(update.goalAssessment);
  const criteria = new Set<number>();
  for (const c of assessment?.criteria ?? []) {
    if (c.criterion > board.goal.successCriteria.length || criteria.has(c.criterion)) throw new Error('GoalAssessment 条件编号无效或重复');
    criteria.add(c.criterion); c.basisIds = unique(c.basisIds); checkBasis(c.basisIds);
    if (c.status === 'satisfied' && !c.basisIds.length) throw new Error('satisfied 条件必须有依据');
    // Source checks cannot determine the truth of arbitrary natural-language claims.
    if (c.status === 'satisfied' && !c.basisIds.some((id) => {
      const ids = allFacts[id] ? [id] : allHypotheses[id]?.factIds ?? [];
      return ids.some((fid) => effective.has(fid) && allFacts[fid].evidenceIds.some((eid) => {
        const e = board.evidence[eid]; return e.kind === 'observation' && (e.status === 'observed' || (e.status === 'error' && e.outcomeKnown === true));
      }));
    })) throw new Error('satisfied 条件缺少有效的实际观察；写入回执或未知结果不足以证明目标');
  }
  const staged: BoardState = { ...structuredClone(board), facts: allFacts, hypotheses: allHypotheses, intents: allIntents, attackPaths: allPaths };
  staged.runs[run.id].status = 'completed';
  if (assessment && run.goalRevision === board.goalRevision) staged.assessment = { goalRevision: run.goalRevision, value: assessment };
  refreshValidity(staged);
  for (const h of hypotheses) if (h.verification?.runId === run.id && !validVerification(staged, h)) throw new Error('本批 verification 受纠正或路径依赖失效影响，不能提交无效的新验证');
  const changedHypotheses = Object.values(staged.hypotheses).filter((h) => seenHyp.has(h.id) || JSON.stringify(h) !== JSON.stringify(board.hypotheses[h.id]));
  return { runId: run.id, summary: update.summary, facts, hypotheses: changedHypotheses, intents, attackPaths, refs,
    intentState: update.intentState, next_move: update.next_move, reason: update.reason,
    ...(assessment ? { goalAssessment: assessment } : {}), goalRevision: run.goalRevision };
}
