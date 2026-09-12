import type { BoardSnapshot, OuterLoopTrigger, Step } from "../types.js";

/** Scheduling only: the Decide Agent, never this policy, judges evidence and Goal completion. */
export interface LoopPolicy {
  selectStep(board: BoardSnapshot): Step | undefined;
  reviewAfterExecution(before: BoardSnapshot, after: BoardSnapshot, stepId: string): OuterLoopTrigger | undefined;
}

function sameIds(left: string[], right: string[]): boolean {
  const previous = new Set(left);
  const current = new Set(right);
  return previous.size === current.size && [...previous].every(id => current.has(id));
}

/** Replaceable outer scheduling strategy; Pi's model/tool loop is unaffected. */
export const defaultLoopPolicy: LoopPolicy = {
  selectStep(board) {
    return board.steps.filter(step => step.status === "ready")
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
  },

  reviewAfterExecution(before, after, stepId) {
    const completed = after.steps.find(step => step.id === stepId);
    if (after.completedSteps <= before.completedSteps || !completed || !["done", "no_progress", "blocked"].includes(completed.status)) return undefined;

    if (completed.status === "blocked") return {
      kind: "blocked",
      reason: `Step ${stepId} is blocked. Inspect the missing prerequisite and available alternatives before choosing the next action.`,
    };

    const priorFindings = new Map(before.findings.map(finding => [finding.id, finding]));
    const changedHit = after.findings.find(finding => {
      if (finding.status !== "technical_hit") return false;
      const prior = priorFindings.get(finding.id);
      return !prior || prior.status !== finding.status || !sameIds(prior.evidenceIds, finding.evidenceIds) || !sameIds(prior.factIds, finding.factIds);
    });
    if (changedHit) return {
      kind: "technical_hit",
      reason: `Technical hit ${changedHit.id} has new support. Review its impact chain: capability, affected object, observable result, scope and prerequisites; a hit alone does not complete the Goal.`,
    };

    const priorFacts = new Set(before.facts.map(fact => fact.id));
    const replacement = after.facts.find(fact => fact.supersedes && !priorFacts.has(fact.id));
    if (replacement) return {
      kind: "fact_revision",
      reason: `Fact ${replacement.id} supersedes ${replacement.supersedes}. Compare their evidence and revisit dependent assumptions and Steps.`,
    };

    if (after.noProgressCount >= after.config.limits.maxNoProgress) return {
      kind: "stagnation",
      reason: `${after.noProgressCount} consecutive Steps produced no new support. Recheck blind spots and change an identity, object, entry point, state or request shape instead of repeating the same attempt.`,
    };

    const interval = after.config.limits.metacogEvery;
    if (interval > 0 && after.completedSteps - after.lastMetaStep >= interval) return {
      kind: "periodic",
      reason: `Review after ${after.completedSteps - after.lastMetaStep} Steps: compare current facts with the Goal, unresolved impact chains and unexplored boundaries.`,
    };
    return undefined;
  },
};
