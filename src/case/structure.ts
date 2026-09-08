import type { AttackPath } from './types.js';

/** Exact JSON structure: keys are unordered, arrays remain ordered unless the
 * owning field explicitly declares set semantics. No text similarity rules. */
export function structuralKey(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, ordered(entry)]));
    return item;
  };
  return JSON.stringify(ordered(value)) ?? 'undefined';
}

export const stringSet = (values: readonly string[]): string[] => [...new Set(values)].sort();
export const equalStringSets = (a: readonly string[], b: readonly string[]): boolean => structuralKey(stringSet(a)) === structuralKey(stringSet(b));

/** Edge collections/references and gaps are sets; nodeIds are an ordered path.
 * Keep IDs because replacing a referenced edge can invalidate a pathCheck. */
export function pathContent(path: AttackPath): unknown {
  return { summary: path.summary.trim(), nodeIds: path.nodeIds, verifiesHypothesisId: path.verifiesHypothesisId,
    gaps: stringSet(path.gaps.map((gap) => gap.trim())),
    edges: path.edges.map(({ confirmed: _confirmed, ...edge }) => ({ ...edge,
      condition: edge.condition.trim(), evidenceIds: stringSet(edge.evidenceIds) }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
