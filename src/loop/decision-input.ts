import type { BoardSnapshot } from "../types.js";

const combinationFields = ["requires", "missing", "scope", "stateVersion", "expectedCapability", "counterEvidence"] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const mentions = (value: unknown, id: string): boolean => typeof value === "string" ? value.includes(id)
  : Array.isArray(value) ? value.some(item => mentions(item, id)) : object(value) ? Object.values(value).some(item => mentions(item, id)) : false;

/** Narrow wire-format compatibility, before strict schema/reference validation.
 * Preserve every condition; never infer IDs, updates, evidence or missing fields. */
export function normalizeDecisionInput(input: unknown, board: BoardSnapshot): { value: unknown; changes: string[] } {
  if (!object(input) || !Array.isArray(input.steps)) return { value: input, changes: [] };
  const value = structuredClone(input), changes: string[] = [];
  const steps = value.steps as unknown[];
  const referenceView = structuredClone(value);
  for (const step of referenceView.steps as unknown[]) if (object(step)) delete step.id;
  const localIds = steps.filter(object).map(step => step.id);
  for (const [index, step] of steps.entries()) {
    if (!object(step)) continue;
    if (Object.hasOwn(step, "id")) {
      const id = step.id;
      if (typeof id !== "string" || !/^S-[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error(`steps.${index}.id: New Steps omit id; the controller allocates it. Use updateSteps for existing ready Steps.`);
      if (board.steps.some(item => item.id === id) || localIds.filter(item => item === id).length !== 1 || mentions(referenceView, id))
        throw new Error(`steps.${index}.id: Cannot discard an existing, duplicated or referenced Step ID. New Steps omit id; existing Steps belong in updateSteps. Do not relabel or replay a historical Step.`);
      delete step.id;
      changes.push(`steps.${index}.id omitted (unused model label; controller assigns the committed ID)`);
    }
    const misplaced = combinationFields.filter(field => Object.hasOwn(step, field));
    if (!misplaced.length) continue;
    if (step.combination !== undefined && !object(step.combination)) throw new Error(`steps.${index}.combination: Expected one object containing all combination fields.`);
    const combination: Record<string, unknown> = object(step.combination) ? step.combination : {};
    for (const field of misplaced) {
      if (Object.hasOwn(combination, field) && JSON.stringify(combination[field]) !== JSON.stringify(step[field]))
        throw new Error(`steps.${index}.combination.${field}: Conflicting nested and top-level values. Preserve the intended condition explicitly; no value was selected.`);
      combination[field] = step[field];
      delete step[field];
    }
    step.combination = combination;
    changes.push(`steps.${index}: moved ${misplaced.join(", ")} into combination without changing values`);
  }
  return { value, changes };
}

export function decisionRepairGuidance(reason: string): string {
  if (/A revisit must retain/.test(reason)) return " Preserve revisits and copy each original gap's goalId from gaps.items or the original Step. Do not silently drop revisits or relabel the gap. A new child Goal cannot own an existing gap; split Steps across different Goals.";
  if (/steps\.\d+\.combination\.requires: Array must contain at least 1/.test(reason)) return " combination.requires needs at least one required committed Fact ID. If there are no required committed Facts, omit combination and retain every unverified condition, scope, state, expected result and counterevidence in the Step description. Keep from as the actual committed inputs (empty for a first observation with no Facts). Never invent a Fact ID or discard conditions to fill requires. No automatic condition removal was performed.";
  return /steps\.\d+|combination|Unrecognized key/.test(reason)
    ? " New steps contain goalId, from, description, successSignal, evidencePlan, priority, and optional combination/methodIds/revisits. Omit id: the controller allocates new Step IDs. Use updateSteps with exact committed IDs for existing ready Steps. Put requires, missing, scope, stateVersion, expectedCapability and counterEvidence inside combination, never directly on a Step. Preserve all prerequisite and counterevidence values; do not remove conditions to pass validation."
    : "";
}
