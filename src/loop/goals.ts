import type { Decision, Goal } from "../types.js";

/** Resolve declarations without mutating the board or reopening existing Goals.
 * Both preflight and Store use this rule so harmless repeats need no model repair. */
export function inspectGoalDeclarations(existing: Goal[], declarations: Decision["goals"]) {
  const goals = new Map(existing.map(goal => [goal.id, goal]));
  const additions: Goal[] = [];
  const errors: string[] = [];
  for (const [index, proposal] of (declarations ?? []).entries()) {
    const prior = goals.get(proposal.id);
    if (prior) {
      if (prior.description !== proposal.description || prior.parentId !== proposal.parentId) {
        errors.push(`Goal ${proposal.id} already exists with a different description or parent: goals[${index}].id=${JSON.stringify(proposal.id)}. For the existing Goal, omit its declaration and reference its ID; for a distinct Goal, choose an unused ID and update its references`);
      }
      continue;
    }
    const parent = goals.get(proposal.parentId);
    if (!parent) {
      errors.push(`Unknown Goal reference: goals[${index}].parentId=${JSON.stringify(proposal.parentId)}. Create parents before children`);
      continue;
    }
    if (parent.status !== "active") {
      errors.push(`Inactive parent Goal: goals[${index}].parentId=${JSON.stringify(proposal.parentId)} has status ${parent.status}. New Goals require an active parent`);
      continue;
    }
    const goal: Goal = { ...proposal, status: "active", factIds: [] };
    goals.set(goal.id, goal);
    additions.push(goal);
  }
  return { goals, additions, errors };
}
