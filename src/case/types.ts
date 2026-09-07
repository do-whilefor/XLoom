import { createHash } from 'node:crypto';
import type { HttpExchange } from '../tools/http.js';

export type AgentRole = 'probe' | 'proof';
export interface RoleCursor { lastSeenRevision: number; deliveredHintIds: string[]; deliveredMessageIds: string[] }
export interface Goal { request: string; origin: string[]; scope: string[]; successCriteria: string[] }
export interface Hint { id: string; messageId: string; content: string; createdAt: string; delivered: boolean }
export interface Intent {
  id: string; kind: 'explore' | 'verify'; objective: string; basisIds: string[]; prerequisites: string[];
  parentId?: string; verifiesHypothesisId?: string;
  state: 'open' | 'running' | 'done' | 'blocked' | 'cancelled'; createdRevision: number; reason?: string;
}
export interface RunRecord {
  id: string; intentId: string; agent: AgentRole; agentSessionId: string; inputRevision: number; goalRevision: number;
  purpose: 'task' | 'review'; startedAt: string; endedAt?: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed'; toolCallIds: string[]; evidenceIds: string[]; reason?: string;
  toolCallSources?: Record<string, { toolCallId: string; responseRef: string; tool: ToolName }>;
}
export type ToolName = 'read' | 'write' | 'edit' | 'bash' | 'chrome' | 'kali';
export interface ToolScopeRule { tools: ToolName[]; messageId: string; revision: number }
export interface ToolScopeInput { messageId: string; revision: number; status: 'applied' | 'invalid'; roles: AgentRole[]; lines: string[]; error?: string }
export interface ToolScopeState {
  rules: Partial<Record<AgentRole, ToolScopeRule>>;
  inputs: ToolScopeInput[];
  /** Empty roles means the malformed role/statement could not be attributed. */
  error?: { messageId: string; roles: AgentRole[]; reason: string };
}
export type Backend = 'local' | 'chrome' | 'kali';
export const backendForTool = (tool: ToolName): Backend => tool === 'chrome' ? 'chrome' : tool === 'kali' ? 'kali' : 'local';
export type ActionOutcome = 'completed' | 'not_started' | 'unknown';
export interface ExternalDetails {
  backend: 'chrome' | 'kali'; outcome: ActionOutcome; status: Evidence['status'];
  operation?: string; connectionId?: string; pageId?: number; pageUrl?: string; pageTitle?: string;
  requestId?: number; requestUrl?: string; requestTime?: string | null; retrievedAt?: string;
  host?: string; port?: number; username?: string; cwd?: string;
  exitCode?: number | null; signal?: string | null; fatal?: boolean;
  error?: string; [key: string]: unknown;
}
export interface Evidence {
  id: string; runId: string; agent: AgentRole; toolCallId: string; tool: ToolName; backend: Backend;
  /** Local request scope; the provider's toolCallId is preserved separately. */
  responseRef?: string;
  recordedAt: string; artifactPaths: string[]; summary: string; status: 'observed' | 'error' | 'interrupted';
  /** Recorder-owned integrity of saved bytes; absent in legacy events. */
  artifactSha256?: Record<string, string>;
  kind: 'observation' | 'mutation' | 'derived'; targetPath?: string; generatedPath?: string;
  derivedPaths?: string[];
  exitCode?: number; outcomeKnown?: boolean; execution?: ExternalDetails;
  /** Historical request/image lookup can support context, never the new experiment alone. */
  freshObservation?: boolean;
  /** Only the explicit native HTTP executor supplies this, never model stdout. */
  http?: HttpExchange & { requestArtifact: string; responseArtifact: string };
}
export interface Fact { id: string; statement: string; evidenceIds: string[]; supersedes?: string }
export const toolCallRef = (call: { toolCallId: string; responseRef?: string }) => call.responseRef ? JSON.stringify([call.responseRef, call.toolCallId]) : call.toolCallId;
export function hasToolSource(run: RunRecord | undefined, evidence: Evidence): boolean {
  if (!run?.toolCallIds.includes(toolCallRef(evidence))) return false;
  if (!evidence.responseRef) return true; // Existing phase 1–5 event logs.
  const source = run.toolCallSources?.[toolCallRef(evidence)];
  return source?.toolCallId === evidence.toolCallId && source.responseRef === evidence.responseRef && source.tool === evidence.tool;
}
export interface Verification {
  runId: string; verdict: 'supported' | 'rejected' | 'disputed'; factIds: string[];
  controls: string; backendResult: string; impact: string; limitations: string;
  pathCheck?: PathCheck;
  observations?: HttpObservations;
  /** Computed during commit preparation; forbidden in model drafts. */
  checked?: CheckedObservation;
}
export interface HttpAssertion {
  kind: 'http-owner-read'; origin: string; resourcePath: string; conditionsPath: string; identityPath: string;
  object: string; actor: string; owner: string; valuePointer: string;
  backend?: 'local' | 'kali';
}
export interface HttpObservations {
  policy: string; actorIdentity: string; invalidIdentity: string;
  ownerIdentity?: string; allowed?: string; denied?: string; test?: string;
  transfers?: Array<{ edgeId: string; from: string; to: string; outputPointer: string; inputPointer?: string;
    delegation?: { identity: string; invalidIdentity: string } }>;
}
export interface CheckedObservation {
  version: 1; binding: string; evidence: Record<string, { request: string; response: string }>;
  edgeIds: string[]; result: 'match' | 'mismatch' | 'unavailable'; reason?: string;
}
export function verificationBinding(board: BoardState, h: Hypothesis): string {
  const run = h.verification && board.runs[h.verification.runId];
  return createHash('sha256').update(JSON.stringify([h.claim, h.httpAssertion, run?.goalRevision,
    run && board.intents[run.intentId]?.prerequisites, h.verification?.observations, h.verification?.pathCheck])).digest('hex');
}
export function hasCheckedObservation(board: BoardState, h: Hypothesis): boolean {
  const c = h.verification?.checked;
  return !!c && c.version === 1 && c.result === (h.verification?.verdict === 'rejected' ? 'mismatch' : 'match') && !!h.httpAssertion &&
    c.binding === verificationBinding(board, h) && Object.keys(c.evidence).length > 0 &&
    Object.entries(c.evidence).every(([id, hashes]) => {
      const e = board.evidence[id], http = e?.http;
      return !!http && http.complete && http.outcome === 'completed' && e.runId === h.verification?.runId &&
        http.requestBodySha256 === hashes.request && http.responseBodySha256 === hashes.response;
    });
}
export interface PathCheck { pathId: string; pathRevision: number; edgeIds: string[]; complete: boolean; continuity: string }
export type PathCheckDraft = Omit<PathCheck, 'pathRevision'>;
export interface AttackPathEdge {
  id: string; from: string; to: string; relation: 'supports' | 'contradicts' | 'related_to' | 'enables';
  condition: string; evidenceIds: string[]; confirmed: boolean;
}
export interface AttackPath {
  id: string; revision: number; summary: string; nodeIds: string[]; edges: AttackPathEdge[]; gaps: string[]; verifiesHypothesisId: string;
}
export type AttackPathEdgeDraft = ({ ref: string } | { id: string }) & Omit<AttackPathEdge, 'id' | 'confirmed'>;
type PathFields = Omit<AttackPath, 'id' | 'revision' | 'edges'> & { edges: AttackPathEdgeDraft[] };
export type AttackPathDraft = ({ ref: string } & PathFields) | ({ id: string } & Partial<PathFields>);
export type VerificationDraft = Omit<Verification, 'runId' | 'pathCheck' | 'checked'> & { pathCheck?: PathCheckDraft };
export interface Hypothesis {
  id: string; claim: string; status: 'lead' | 'technical_hit' | 'impact_verified' | 'rejected' | 'disputed';
  factIds: string[]; alternatives: string[]; gaps: string[]; needsReview?: boolean; verification?: Verification; duplicateOf?: string;
  httpAssertion?: HttpAssertion;
  reviewReason?: string;
}
export interface GoalAssessment {
  criteria: Array<{ criterion: number; status: 'satisfied' | 'unknown' | 'rejected'; basisIds: string[]; reason: string }>;
}
export type IntentDraft = ({ ref: string } & Omit<Intent, 'id' | 'createdRevision' | 'reason'>)
  | ({ id: string } & Partial<Omit<Intent, 'id' | 'kind' | 'createdRevision' | 'reason'>>);
export type HypothesisDraft = ({ ref: string } & Omit<Hypothesis, 'id' | 'needsReview' | 'verification'>)
  | ({ id: string } & Partial<Omit<Hypothesis, 'id' | 'needsReview' | 'verification' | 'duplicateOf'>> & { verification?: VerificationDraft; duplicateOf?: string | null });
export interface XLoomUpdate {
  summary: string; facts: Array<Omit<Fact, 'id'> & { ref: string }>;
  hypotheses: HypothesisDraft[]; intents: IntentDraft[]; attackPaths: AttackPathDraft[];
  intentState: 'open' | 'done' | 'blocked' | 'cancelled'; next_move: 'continue' | 'widen' | 'verify' | 'stop';
  reason: string; goalAssessment?: GoalAssessment; nextIntentId?: string;
}
/** B2 input only: omission means no operations, never replacement of stored collections. */
export type XLoomUpdateDraft = Omit<XLoomUpdate, 'facts' | 'hypotheses' | 'intents' | 'attackPaths'>
  & Partial<Pick<XLoomUpdate, 'facts' | 'hypotheses' | 'intents' | 'attackPaths'>>;
export type IdPrefix = 'I' | 'R' | 'E' | 'F' | 'H' | 'N' | 'P' | 'PE';
export interface Commit {
  runId: string; summary: string; facts: Fact[]; hypotheses: Hypothesis[]; intents: Intent[];
  intentState: XLoomUpdate['intentState']; next_move: XLoomUpdate['next_move']; reason: string;
  refs: Record<string, string>; goalAssessment?: GoalAssessment; goalRevision: number;
  nextIntentId?: string;
  attackPaths?: AttackPath[]; // Optional only for pre-M6 event replay.
}
export interface BoardState {
  /** Derived only from original user Goal/Hint events; absent keeps legacy tools. */
  toolScope?: ToolScopeState;
  changes: Array<{ revision: number; kind: 'changed' | 'superseded' | 'refuted' | 'scope_changed'; objectIds: string[]; summary: string }>;
  revision: number; goal: Goal; originalGoal: Goal; goalRevision: number; goalMessageId: string;
  goalChanges: Array<{ revision: number; messageId: string; goal: Goal }>;
  execution: 'idle' | 'running' | 'paused'; outcome: 'in_progress' | 'satisfied' | 'exhausted' | 'blocked'; reason: string;
  intents: Record<string, Intent>; runs: Record<string, RunRecord>; evidence: Record<string, Evidence>;
  facts: Record<string, Fact>; hypotheses: Record<string, Hypothesis>; hints: Record<string, Hint>;
  attackPaths: Record<string, AttackPath>;
  counters: Record<IdPrefix, number>; knowledgeRevision: number; reviewCursor: number; reviewIntentIds: string[];
  agentSessions: Partial<Record<AgentRole, string>>; agentCursors: Partial<Record<AgentRole, RoleCursor>>;
  lastSeenRevision: number; deliveredMessageIds: string[]; lastSummary: string;
  /** One unconsumed recommendation, reconstructed only from authoritative events. */
  nextIntentId?: string;
  assessment?: { goalRevision: number; value: GoalAssessment };
}
export type EventPayloads = {
  cursor_restored: { agent: AgentRole; cursor: RoleCursor };
  agent_created: { agent: AgentRole; agentSessionId: string };
  case_created: { goal: Goal; messageId: string; intent: Intent };
  hint_added: { hint: Hint };
  goal_changed: { goal: Goal; messageId: string };
  run_started: { run: RunRecord };
  tool_started: { runId: string; toolCallId: string; tool: ToolName; artifactPath: string; responseRef?: string };
  evidence_recorded: { evidence: Evidence };
  inputs_delivered: { messageIds: string[]; inputRevision: number; agent?: AgentRole };
  agent_committed: Commit;
  run_interrupted: { runId: string; reason: string };
  run_failed: { runId: string; reason: string };
  review_scheduled: { intent: Intent; knowledgeRevision: number };
  intent_reopened: { intentId: string; reason: string };
  execution_changed: { execution: BoardState['execution']; outcome: BoardState['outcome']; reason: string };
};
export type BoardEvent = { [K in keyof EventPayloads]: {
  revision: number; timestamp: string; source: 'user' | 'program' | AgentRole; type: K; payload: EventPayloads[K];
} }[keyof EventPayloads];

export function emptyBoard(): BoardState {
  const goal: Goal = { request: '', origin: [], scope: [], successCriteria: [] };
  return { changes: [], revision: 0, goal, originalGoal: goal, goalRevision: 0, goalMessageId: '', goalChanges: [],
    execution: 'idle', outcome: 'in_progress', reason: '', intents: {}, runs: {}, evidence: {}, facts: {}, hypotheses: {}, hints: {},
    attackPaths: {}, counters: { I: 0, R: 0, E: 0, F: 0, H: 0, N: 0, P: 0, PE: 0 }, knowledgeRevision: 0, reviewCursor: 0,
    reviewIntentIds: [], agentSessions: {}, agentCursors: {}, lastSeenRevision: 0, deliveredMessageIds: [], lastSummary: '' };
}
export function activeFacts(board: BoardState): Fact[] {
  const replaced = new Set(Object.values(board.facts).flatMap((f) => f.supersedes ? [f.supersedes] : []));
  return Object.values(board.facts).filter((f) => !replaced.has(f.id));
}
export function parseGoal(request: string): Goal {
  const fields = { origin: [] as string[], scope: [] as string[], successCriteria: [] as string[] };
  let current: keyof typeof fields | undefined;
  for (const line of request.split('\n')) {
    const match = /^\s*(?:[-*]\s*)?(起点|Origin|范围|Scope|成功条件|验收条件|Criteria)\s*[:：]\s*(.*)$/i.exec(line);
    if (match) {
      current = /起点|origin/i.test(match[1]) ? 'origin' : /范围|scope/i.test(match[1]) ? 'scope' : 'successCriteria';
      if (match[2].trim()) fields[current].push(match[2].trim());
    } else if (current && /^\s*(?:[-*]|\d+[.)、])\s+/.test(line)) {
      fields[current].push(line.replace(/^\s*(?:[-*]|\d+[.)、])\s+/, '').trim());
    } else if (line.trim()) current = undefined;
  }
  return { request, ...fields, successCriteria: fields.successCriteria.length ? fields.successCriteria : [request] };
}

/** Derived current confirmation; append history remains untouched. */
export function validVerification(board: BoardState, h: Hypothesis): boolean {
  const active = new Set(activeFacts(board).map((f) => f.id));
  const v = h.verification, run = v && board.runs[v.runId];
  return !h.needsReview && !!v && !!run && run.status === 'completed' && run.agent === 'proof' &&
    (!(h.status === 'impact_verified' || v.pathCheck || v.verdict === 'rejected') || hasCheckedObservation(board, h)) &&
    (!(v.verdict === 'rejected' && Object.values(board.attackPaths).some((p) => p.verifiesHypothesisId === h.id)) || rejectedPathBinding(board, h)) &&
    board.intents[run.intentId]?.verifiesHypothesisId === h.id &&
    run.agentSessionId === board.agentSessions.proof && run.agentSessionId !== board.agentSessions.probe &&
    !!h.factIds.length && !!v.factIds.length && [...h.factIds, ...v.factIds].every((id) => active.has(id)) &&
    v.factIds.some((id) => board.facts[id].evidenceIds.some((eid) => {
      const e = board.evidence[eid]; return e && e.runId === run.id && e.agent === 'proof' && e.freshObservation !== false && hasToolSource(run, e) && run.evidenceIds.includes(e.id);
    })) && v.factIds.every((id) => board.facts[id].evidenceIds.every((eid) => {
      const e = board.evidence[eid], origin = e && board.runs[e.runId];
      return e && e.status === 'observed' && e.kind === 'observation' && origin?.status === 'completed' && hasToolSource(origin, e) && origin.evidenceIds.includes(e.id);
    }));
}

export function pathDependenciesValid(board: BoardState, path: AttackPath): boolean {
  const active = new Set(activeFacts(board).map((f) => f.id));
  const target = board.hypotheses[path.verifiesHypothesisId];
  return !!target && path.nodeIds.every((id) => board.facts[id] ? active.has(id) && target.factIds.includes(id) :
    !!board.hypotheses[id] && (id === target.id || (!board.hypotheses[id].needsReview && !board.hypotheses[id].duplicateOf && !['disputed', 'rejected'].includes(board.hypotheses[id].status) && board.hypotheses[id].factIds.every((fid) => active.has(fid) && target.factIds.includes(fid))))) &&
    path.edges.every((edge) => edge.evidenceIds.every((id) => {
      const e = board.evidence[id];
      return e && e.status === 'observed' && e.kind === 'observation' && board.runs[e.runId]?.status === 'completed' &&
        target.factIds.some((fid) => active.has(fid) && board.facts[fid].evidenceIds.includes(id));
    }));
}
export function coversMainPath(path: AttackPath, check: PathCheck): boolean {
  return path.nodeIds.length >= 2 && new Set(path.nodeIds).size === path.nodeIds.length &&
    path.nodeIds.slice(1).every((to, index) => {
      const edges = path.edges.filter((e) => e.from === path.nodeIds[index] && e.to === to && e.relation === 'enables');
      return edges.length === 1 && check.edgeIds.includes(edges[0].id);
    });
}
/** A failed endpoint cannot refute a capability path unless this same check
 * establishes the actual inputs and prerequisites of all its main connections.
 * complete stays false: no successful terminal path is being confirmed.
 */
function rejectedPathBinding(board: BoardState, h: Hypothesis): boolean {
  const c = h.verification?.pathCheck, p = c && board.attackPaths[c.pathId];
  return !!c && !!p && p.verifiesHypothesisId === h.id && c.pathRevision === p.revision && !c.complete &&
    !!c.continuity.trim() && coversMainPath(p, c) &&
    c.edgeIds.every((id) => p.edges.some((e) => e.id === id && e.relation === 'enables')) && pathDependenciesValid(board, p);
}
export function validPathCheck(board: BoardState, path: AttackPath): PathCheck | undefined {
  const h = board.hypotheses[path.verifiesHypothesisId], v = h?.verification, c = v?.pathCheck;
  if (h && !h.duplicateOf && ['technical_hit', 'impact_verified'].includes(h.status) && validVerification(board, h) && v?.verdict === 'supported' &&
    c?.pathId === path.id && c.pathRevision === path.revision && pathDependenciesValid(board, path) && c.continuity.trim() &&
    c.edgeIds.length && c.edgeIds.every((id) => path.edges.some((e) => e.id === id && e.relation === 'enables'))) return c;
}
/** Current findings and path coverage share the same validity rules. */
export function validConfirmation(board: BoardState, h: Hypothesis): boolean {
  if (h.duplicateOf || h.status !== 'impact_verified' || h.gaps.length || h.alternatives.length || h.verification?.verdict !== 'supported' || !validVerification(board, h)) return false;
  const c = h.verification.pathCheck;
  if (!c) return !Object.values(board.attackPaths).some((p) => p.verifiesHypothesisId === h.id);
  const p = board.attackPaths[c.pathId];
  return !!p && !!validPathCheck(board, p) && c.complete && !p.gaps.length && coversMainPath(p, c);
}
export function pathState(board: BoardState, path: AttackPath): string {
  const h = board.hypotheses[path.verifiesHypothesisId];
  if (h?.status === 'rejected' && h.verification?.verdict === 'rejected' && h.verification.pathCheck?.pathId === path.id &&
    rejectedPathBinding(board, h) && validVerification(board, h)) return '路径断言被反驳';
  const c = validPathCheck(board, path);
  if (c) return c.complete && coversMainPath(path, c) && validConfirmation(board, h) ? '完整路径已验证' : '部分连接已验证';
  return h?.needsReview || (h?.verification?.pathCheck?.pathId === path.id) || !pathDependenciesValid(board, path) ? '需要复核' : '候选路径';
}

/** Dependency-based relevance, shared by scheduling and persisted projections. */
export function hasPendingVerification(board: BoardState, basisIds: string[]): boolean {
  const basisFacts = new Set(basisIds.flatMap((id) => board.facts[id] ? [id] : board.hypotheses[id]?.factIds ?? []));
  return Object.values(board.intents).some((i) => {
    if (i.kind !== 'verify' || !['open', 'running', 'blocked'].includes(i.state)) return false;
    const h = board.hypotheses[i.verifiesHypothesisId ?? ''];
    return h && !h.duplicateOf && (basisIds.includes(h.id) || h.factIds.some((id) => basisFacts.has(id)));
  });
}

/** Finite monotone invalidation; history is retained, never promoted by a projection. */
export function refreshValidity(board: BoardState): void {
  const active = new Set(activeFacts(board).map((f) => f.id));
  const marked = new Set<string>();
  const dispute = (h: Hypothesis) => { marked.add(h.id); h.needsReview = true; h.status = 'disputed'; };
  for (const h of Object.values(board.hypotheses)) {
    if (h.status === 'rejected' && h.verification?.verdict === 'rejected' && Object.values(board.attackPaths).some((p) => p.verifiesHypothesisId === h.id) && !rejectedPathBinding(board, h)) {
      h.reviewReason = '旧路径反驳缺少当前主连接的完整前提/输入绑定，或绑定已失效；保留历史，需要独立复核';
      dispute(h);
    }
    if ((h.status === 'impact_verified' || h.status === 'rejected' || h.verification?.pathCheck || h.verification?.verdict === 'rejected') && !hasCheckedObservation(board, h)) {
      h.reviewReason = '旧确认或反证缺少可核对的原始请求/响应绑定，或绑定已失效；保留历史，需要独立复核';
      dispute(h);
    }
    const c = h.verification?.pathCheck, p = c && board.attackPaths[c.pathId];
    if ([...h.factIds, ...(h.verification?.factIds ?? [])].some((id) => !active.has(id)) ||
      (c && (!p || p.verifiesHypothesisId !== h.id || p.revision !== c.pathRevision))) dispute(h);
  }
  let added: boolean;
  do {
    added = false;
    for (const p of Object.values(board.attackPaths)) {
      const h = board.hypotheses[p.verifiesHypothesisId], c = h?.verification?.pathCheck;
      if (h && !marked.has(h.id) && ((!pathDependenciesValid(board, p)) || (c?.pathId === p.id && c.pathRevision !== p.revision) ||
        (h.status === 'impact_verified' && !c))) { dispute(h); added = true; }
    }
  } while (added);
  for (const p of Object.values(board.attackPaths)) {
    const c = validPathCheck(board, p);
    for (const e of p.edges) e.confirmed = e.relation === 'enables' && !!c?.edgeIds.includes(e.id);
  }
  for (const i of Object.values(board.intents)) if (i.kind === 'verify' && ['open', 'blocked'].includes(i.state) && board.hypotheses[i.verifiesHypothesisId!]?.duplicateOf) {
    i.state = 'blocked'; i.reason = `候选 ${i.verifiesHypothesisId} 已并入 ${board.hypotheses[i.verifiesHypothesisId!].duplicateOf}；保留原目标，如需验证请明确创建主候选任务`;
  }
  for (const c of board.assessment?.value.criteria ?? []) if (c.basisIds.some((id) => board.facts[id] ? !active.has(id) :
    !board.hypotheses[id] || board.hypotheses[id].needsReview || !!board.hypotheses[id].duplicateOf || ['disputed', 'rejected'].includes(board.hypotheses[id].status) ||
    (board.hypotheses[id].status === 'impact_verified' && !validConfirmation(board, board.hypotheses[id])))) {
    c.status = 'unknown'; c.reason = '依据已失效或需要复核；保留原引用供追溯';
  }
  for (const c of board.assessment?.value.criteria ?? []) if (c.status === 'satisfied' && hasPendingVerification(board, c.basisIds)) {
    c.status = 'unknown'; c.reason = '依据关联的独立验证尚未完成；保留原引用等待验证';
  }
  if (board.outcome === 'satisfied' && (!board.assessment || board.assessment.value.criteria.some((c) => c.status !== 'satisfied'))) board.outcome = 'in_progress';
}
