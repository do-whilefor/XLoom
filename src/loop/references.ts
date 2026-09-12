import type { BoardSnapshot, Decision } from "../types.js";
import { inspectGoalDeclarations } from "./goals.js";

/** Check all explicit references against the complete board before the one repair
 * request. Report every bad reference together; never guess replacement IDs. */
export function validateDecisionReferences(board: BoardSnapshot, decision: Decision): void {
  const facts = new Set(board.facts.map(fact => fact.id));
  const { goals, errors } = inspectGoalDeclarations(board.goals, decision.goals);
  const steps = new Map(board.steps.map(step => [step.id, step]));
  const findings = new Map(board.findings.map(finding => [finding.id, finding]));
  const evidence = new Set(board.evidence.map(item => item.id));
  const check = (known: { has(ref: string): boolean }, kind: string, ref: string, field: string) => {
    if (!known.has(ref)) errors.push(`Unknown ${kind} reference: ${field}=${JSON.stringify(ref)}`);
  };
  const checkFacts = (refs: string[], field: string) => refs.forEach((ref, index) => check(facts, "fact", ref, `${field}[${index}]`));
  decision.steps?.forEach((step, index) => {
    check(goals, "Goal", step.goalId, `steps[${index}].goalId`);
    checkFacts(step.from, `steps[${index}].from`);
    if (step.combination) {
      checkFacts(step.combination.requires, `steps[${index}].combination.requires`);
      checkFacts(step.combination.counterEvidence ?? [], `steps[${index}].combination.counterEvidence`);
    }
  });
  decision.updateSteps?.forEach((update, index) => {
    check(steps, "Step", update.id, `updateSteps[${index}].id`);
    if (steps.get(update.id)?.status === "claimed") errors.push(`updateSteps[${index}].id=${JSON.stringify(update.id)} is claimed; only ready Steps may be changed`);
    // Settled updates are intentionally left for the controller's history filter.
  });
  decision.updateGoals?.forEach((goal, index) => {
    check(goals, "Goal", goal.id, `updateGoals[${index}].id`);
    checkFacts(goal.factIds, `updateGoals[${index}].factIds`);
  });
  decision.reviews?.forEach((review, index) => {
    check(findings, "Finding", review.findingId, `reviews[${index}].findingId`);
    if (review.pocEvidenceId) {
      check(evidence, "Evidence", review.pocEvidenceId, `reviews[${index}].pocEvidenceId`);
      const finding = findings.get(review.findingId);
      if (finding && evidence.has(review.pocEvidenceId) && !finding.evidenceIds.includes(review.pocEvidenceId)) {
        errors.push(`reviews[${index}].pocEvidenceId=${JSON.stringify(review.pocEvidenceId)} must belong to Finding ${JSON.stringify(finding.id)}`);
      }
    }
  });
  if (errors.length) throw new Error(`${errors.join("; ")}. Copy exact IDs from the committed blackboard (Fact IDs also appear in factIndex); never change ID prefixes, truncate IDs or guess replacements. Evidence IDs and batch-local refs are not Fact IDs. New Goals may reference an existing or earlier new parent Goal.`);
}
