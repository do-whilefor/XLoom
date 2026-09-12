import type { BoardSnapshot, Decision } from "../types.js";

/** Check against the complete committed board, not its partial prompt projection.
 * A plausible-looking ID is never a substitute for an actual Fact. */
export function validateDecisionFactReferences(board: BoardSnapshot, decision: Decision): void {
  const known = new Set(board.facts.map(fact => fact.id));
  const missing: string[] = [];
  const check = (refs: string[], field: string) => refs.forEach((ref, index) => {
    if (!known.has(ref)) missing.push(`${field}[${index}]=${JSON.stringify(ref)}`);
  });
  decision.steps?.forEach((step, index) => {
    check(step.from, `steps[${index}].from`);
    if (step.combination) {
      check(step.combination.requires, `steps[${index}].combination.requires`);
      check(step.combination.counterEvidence ?? [], `steps[${index}].combination.counterEvidence`);
    }
  });
  decision.updateGoals?.forEach((goal, index) => check(goal.factIds, `updateGoals[${index}].factIds`));
  if (missing.length) throw new Error(`Unknown fact reference: ${missing.join("; ")}. Copy exact committed Fact IDs from blackboard.facts or factIndex. Evidence IDs and batch-local refs are not Fact IDs; never change ID prefixes. Recheck the referenced observation before choosing its Fact.`);
}
