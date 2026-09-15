import type { BoardSnapshot, RunRequest } from "../types.js";

/** Exact committed deltas, not a summary or private transcript. Navigation never
 * implies that the changed records are sufficient to complete the whole Goal. */
export function executionHandoff(before: BoardSnapshot, after: BoardSnapshot, sourceStepId: string): NonNullable<RunRequest["handoff"]> {
  const changed = (prior: { id: string }[], current: { id: string }[]) => {
    const versions = new Map(prior.map(item => [item.id, JSON.stringify(item)]));
    return current.filter(item => versions.get(item.id) !== JSON.stringify(item)).map(item => item.id);
  };
  return { sourceStepId, factIds: changed(before.facts, after.facts), evidenceIds: changed(before.evidence, after.evidence), findingIds: changed(before.findings, after.findings) };
}
