import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toolScopeDecision } from './tool-scope.js';
import type { AgentRole, BoardState, Intent } from './types.js';

const catalog = [
  { id: 'http', summary: '创建 HTTP 私有对象断言及原生 xloom-http 请求格式' },
  { id: 'path', summary: '创建/修改能力路径、边、目标和纠正依赖' },
  { id: 'aggregation', summary: '候选聚合与 duplicateOf 的范围、补丁和验证限制' },
  { id: 'proof-http', summary: 'Proof 的 HTTP 观察绑定、前提、对照、确认和失败语义' },
  { id: 'proof-path', summary: 'Proof 完整/前缀/反证路径及 Bearer 委派绑定' },
] as const;

export interface ApplicablePromptRules {
  version: 'b2-rules-v1';
  inline: Array<{ id: string; text: string }>;
  deferred: Array<{ id: string; path: string; summary: string }>;
}

/** Rule selection is deterministic metadata, never new knowledge or a model call.
 * Current Proof bindings are always present; unknown future capabilities retain
 * exact read entries. Without read, inline every role-capable rule conservatively.
 */
export function applicablePromptRules(board: BoardState, intent: Intent, role: AgentRole): ApplicablePromptRules {
  const ids = new Set([...intent.basisIds, ...(intent.verifiesHypothesisId ? [intent.verifiesHypothesisId] : []),
    ...(intent.parentId ? board.intents[intent.parentId]?.basisIds ?? [] : [])]);
  const hypotheses = Object.values(board.hypotheses).filter(h => ids.has(h.id));
  const target = intent.verifiesHypothesisId && board.hypotheses[intent.verifiesHypothesisId];
  const linkedPath = Object.values(board.attackPaths).some(path => ids.has(path.id) || ids.has(path.verifiesHypothesisId)
    || path.nodeIds.some(id => ids.has(id)));
  const task = [intent.objective, ...intent.prerequisites, ...board.goal.scope, ...board.goal.successCriteria].join('\n');
  const hasPath = linkedPath || /AttackPath|路径|路线|能力链|委派|capability|delegat|\bchain\b/i.test(task);
  const hasHttp = linkedPath || hypotheses.some(h => h.httpAssertion)
    || /https?:\/\/|\bHTTP\b|私有.*读取|越权|owner-only/i.test(task);
  // HTTP transport can serve an ordinary observation. Only the current bound
  // assertion/path calls for the impact-confirmation contract and its example.
  const proofHttp = role === 'proof' && (!!target && !!target.httpAssertion || linkedPath);
  const hasAggregation = hypotheses.length > 1 || hypotheses.some(h => h.duplicateOf)
    || /聚合|合并|重复候选|duplicateOf|dedup|aggregate/i.test(task);
  const canRead = toolScopeDecision(board, role, 'read').allowed;
  const selected = new Set<string>([
    ...(hasHttp ? ['http'] : []), ...(hasPath ? ['path'] : []), ...(hasAggregation ? ['aggregation'] : []),
    ...(proofHttp ? ['proof-http', ...(hasPath ? ['proof-path'] : [])] : []),
  ]);
  const result: ApplicablePromptRules = { version: 'b2-rules-v1', inline: [], deferred: [] };
  for (const rule of catalog) {
    if (rule.id.startsWith('proof-') && role !== 'proof') continue;
    const path = fileURLToPath(new URL(`../prompts/${rule.id}.md`, import.meta.url));
    // Check assets on each projection too: unchanged board revision cannot hide
    // a missing rule, and a deferred reference must never point to absent text.
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) throw new Error(`必要提示规则 ${rule.id} 为空：${path}`);
    if (selected.has(rule.id) || !canRead) result.inline.push({ id: rule.id, text });
    else result.deferred.push({ id: rule.id, path, summary: rule.summary });
  }
  // This ordinary-observation format has no HTTP/path consumer. Keep it out of
  // the shared catalog so those requests gain neither text nor a deferred URL.
  if (role === 'proof' && target && !target.httpAssertion && !linkedPath) {
    const text = readFileSync(new URL('../prompts/proof-observation.md', import.meta.url), 'utf8');
    if (!text.trim()) throw new Error('必要提示规则 proof-observation 为空');
    result.inline.push({ id: 'proof-observation', text });
  }
  return result;
}
