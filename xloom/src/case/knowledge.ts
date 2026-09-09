import { activeFacts, hasToolSource, pathDependenciesValid, pathState, toolCallRef, validConfirmation,
  validVerification, type BoardState, type Fact, type Hypothesis } from './types.js';
import { pathContent, stringSet, structuralKey } from './structure.js';

/** Ephemeral keys over this Case's current effective objects, never a history
 * blacklist. Equality affects review eligibility only; stored IDs stay exact. */
export function knowledgeProjection(board: BoardState): string {
  const factKeys = new Map<string, string>();
  const factKey = (fact: Fact): string => {
    const sources = fact.evidenceIds.map((id) => {
      const evidence = board.evidence[id], run = evidence && board.runs[evidence.runId];
      if (!evidence || !hasToolSource(run, evidence) || !run!.evidenceIds.includes(id) || evidence.agent !== run!.agent)
        return { invalidEvidence: id, factId: fact.id };
      // Same bytes/URL/toolCallId from another Run are a different experiment.
      return { id, runId: run!.id, agent: evidence.agent, source: toolCallRef(evidence),
        tool: evidence.tool, backend: evidence.backend, status: evidence.status, kind: evidence.kind,
        freshObservation: evidence.freshObservation, outcomeKnown: evidence.outcomeKnown };
    });
    return structuralKey({ statement: fact.statement, sources: stringSet(sources.map(structuralKey)), supersedes: fact.supersedes });
  };
  for (const fact of activeFacts(board)) factKeys.set(fact.id, factKey(fact));
  const facts = (ids: string[]) => stringSet(ids.map((id) => factKeys.get(id) ?? `inactive:${id}`));
  const hypothesisKey = (hypothesis: Hypothesis): string => {
    const { id: _id, factIds, gaps, alternatives, needsReview, reviewReason: _reason, verification, ...fields } = hypothesis;
    return structuralKey({ ...fields, factIds: facts(factIds), gaps: stringSet(gaps), alternatives: stringSet(alternatives),
      needsReview: !!needsReview,
      verification: verification && { ...verification, factIds: facts(verification.factIds),
        ...(verification.pathCheck ? { pathCheck: { ...verification.pathCheck, edgeIds: stringSet(verification.pathCheck.edgeIds) } } : {}),
        ...(verification.checked ? { checked: { ...verification.checked, edgeIds: stringSet(verification.checked.edgeIds) } } : {}) },
      // Unverified candidates cannot pass this gate. Avoid rescanning every
      // active Fact for each background lead in a large board.
      verificationValid: !!verification && validVerification(board, hypothesis), confirmationValid: validConfirmation(board, hypothesis) });
  };
  return structuralKey({ facts: stringSet([...factKeys.values()]), hypotheses: stringSet(Object.values(board.hypotheses).map(hypothesisKey)),
    paths: Object.values(board.attackPaths).map((path) => ({ id: path.id, content: pathContent(path),
      dependenciesValid: pathDependenciesValid(board, path), state: pathState(board, path),
      confirmedEdges: stringSet(path.edges.filter((edge) => edge.confirmed).map((edge) => edge.id)) }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
}
