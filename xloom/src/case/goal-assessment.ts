import { activeFacts, validConfirmation, hasPendingVerification, type BoardState } from './types.js';

export function requiresProof(board: BoardState): boolean {
  // Explicit exclusions are scope, not success conditions. Keep all affirmative
  // clauses (including requirements elsewhere in the same Goal) for the existing
  // conservative check. This is not a general natural-language permission parser.
  // A conditional prohibition on protocol fields describes submission rules,
  // not a request to establish security impact. Match the whole clause and only
  // known field names so a following positive requirement is never discarded.
  const protocolExclusion = /^\s*(?:在)?(?:无|没有|缺少)(?:有效的?)?安全(?:影响)?确认合同(?:时|的情况下)(?:不得|不要|不|不能)(?:填写|提交)\s*(?:verification|impact_verified|rejected)(?:\s*(?:\/|、|和|或|以及)\s*(?:verification|impact_verified|rejected))*\s*$/i;
  // Remove only complete, explicit scope declarations. Keep the conservative
  // cross-clause check: a positive verb may precede its object in a comma or
  // newline-delimited list. This does not exclude a claim like "确认这不是漏洞".
  const investigationExclusion = /^\s*(?:(?:这|本次|本任务|当前任务|此任务)(?:也)?)?(?:不是|并非)(?:安全)?漏洞(?:调查|扫描|验证|确认)\s*$|^\s*(?:(?:this|it|this task|the task)\s+is\s+)?not\s+(?:a\s+)?(?:security(?:\s+vulnerability)?|vulnerability)\s+investigation\s*$/i;
  const nounExclusion = /^\s*(?:显式|明确)?(?:无需|无须|不必|不需要|不要求)(?:\s*HTTP\s*契约(?:或|和|及)\s*)?(?:额外|独立)?(?:安全影响|漏洞)(?:验证|确认|证明)\s*$/i;
  const labelExclusion = /^\s*(?:不|不要)(?:把|将)[^。！？；;\n，,]{1,80}(?:称为|当作|标为|视为)(?:安全漏洞|漏洞|impact_verified)(?:\s*(?:或|和|、)\s*(?:安全漏洞|漏洞|impact_verified))*\s*$/i;
  const affirmative = [board.goal.request, ...board.goal.successCriteria].join('\n')
    .split(/(?:[。！？；;\n，,]|[.!?](?=\s|$))/)
    .filter(clause => !protocolExclusion.test(clause) && !investigationExclusion.test(clause) && !nounExclusion.test(clause) && !labelExclusion.test(clause))
    .filter(clause => /(?:但|而|仍|\bhowever\b|\bbut\b|\balso\b)/i.test(clause) ||
      !/^\s*(?:显式|明确)?(?:(?:不要|无需|无须|不必|不需要|不要求|禁止|不)(?:再|额外|独立|进一步)?(?:进行|创建|做|推断|确认|证明|验证|利用|评估|扫描)|(?:do not|don't|no need to)\s+(?:verify|confirm|prove|assess|exploit)\b|(?:无需|无须|不必|不需要|不要求)(?:额外|独立)?安全影响(?:验证|确认|证明)\s*$)/i.test(clause));
  const securityConfirmation = /(?:确认|验证).{0,24}(?:要求|必须|需要).{0,24}\bProof\b|(?:确认|证明|验证|利用|可利用|影响|危害).{0,24}(?:漏洞|安全|越权|注入|执行代码)|(?:漏洞|安全|越权|注入).{0,24}(?:确认|证明|验证|影响|危害)|(?:confirm|prove|verify|exploit).{0,35}(?:vulnerab|security|impact)|(?:vulnerab|security).{0,35}(?:confirm|impact|exploit)/is;
  return securityConfirmation.test(affirmative.join('\n'));
}
export interface GoalCriterionSupport {
  criterion: number; status: 'satisfied' | 'unknown' | 'rejected'; supported: boolean; reason?: string;
}

/** The display and completion gate inspect the same current evidence. This is
 * a diagnostic of the submitted assessment, never a replacement assessment. */
export function goalAssessmentSupport(board: BoardState): { supported: boolean; criteria: GoalCriterionSupport[]; reason?: string } {
  const assessment = board.assessment?.goalRevision === board.goalRevision ? board.assessment.value : undefined;
  const inputReason = board.toolScope?.error ? '用户工具范围无效'
    : !assessment ? '尚无当前 Goal 版本的评估'
    : Object.values(board.hints).some((h) => !h.delivered) ? '最新用户输入尚未送达' : undefined;
  const globalReason = inputReason ?? (requiresProof(board) && !assessment?.criteria.some((c) => c.status === 'satisfied' && c.basisIds.some((id) => board.hypotheses[id] && validConfirmation(board, board.hypotheses[id])))
      ? '安全 Goal 的 satisfied 依据尚未引用当前有效的 Proof Hypothesis；Fact 不能替代确认' : undefined);
  const active = new Set(activeFacts(board).map((f) => f.id));
  const validFact = (id: string) => active.has(id) && board.facts[id].evidenceIds.every((eid) => {
    const e = board.evidence[eid]; return e && e.kind !== 'derived' && (e.status === 'observed' || (e.kind === 'observation' && e.status === 'error' && e.outcomeKnown === true));
  });
  const criteria = board.goal.successCriteria.map((text, index): GoalCriterionSupport => {
    const criterion = index + 1, c = assessment?.criteria.find((c) => c.criterion === criterion);
    const status = c?.status ?? 'unknown';
    const unsupported = (reason: string): GoalCriterionSupport => ({ criterion, status, supported: false, reason });
    if (!c || status !== 'satisfied') return unsupported(c?.reason ?? '尚未提交该成功条件的实际观察评估');
    if (inputReason) return unsupported(inputReason);
    if (hasPendingVerification(board, c.basisIds)) return unsupported('当前依据仍有关联的未决独立验证');
    if (!c.basisIds.some((id) => (board.facts[id] ? [id] : board.hypotheses[id]?.factIds ?? []).some((fid) =>
      validFact(fid) && board.facts[fid].evidenceIds.some((eid) => board.evidence[eid].kind === 'observation')))) {
      return unsupported('该条件缺少有效的实际观察；动作回执或派生材料不能单独证明完成');
    }
    const safetyCriterion = requiresProof({ ...board, goal: { ...board.goal, request: text, successCriteria: [text] } });
    if (safetyCriterion && !c.basisIds.some((id) => board.hypotheses[id] && validConfirmation(board, board.hypotheses[id]))) {
      return unsupported('该安全条件的依据未引用当前有效的 Proof Hypothesis');
    }
    if (!c.basisIds.length || !c.basisIds.every((id) => {
      if (board.facts[id]) return validFact(id);
      const h = board.hypotheses[id];
      return h && !h.duplicateOf && (h.status !== 'impact_verified' || validConfirmation(board, h)) && !h.needsReview && !['rejected', 'disputed'].includes(h.status) && h.factIds.length > 0 && h.factIds.every(validFact);
    })) return unsupported('条件依据包含缺失、已纠正、未确认或已失效的对象');
    return { criterion, status, supported: true };
  });
  return { supported: !globalReason && criteria.every((c) => c.supported), criteria, ...(globalReason ? { reason: globalReason } : {}) };
}

export function goalGaps(board: BoardState) {
  return goalAssessmentSupport(board).criteria.filter((c) => !c.supported).map((c) => ({
    criterion: c.criterion, status: c.status === 'satisfied' ? 'unknown' as const : c.status,
    ...(c.status === 'satisfied' ? { reportedStatus: c.status, reason: c.reason } : {}),
  }));
}

export function hasSupportedGoalCompletion(board: BoardState): boolean {
  return goalAssessmentSupport(board).supported;
}
