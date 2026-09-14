import { terms } from "./catalog.js";

/** Retrieval alternatives only. Separate needs remain AND prerequisites in the
 * knowledge solver; matching expressions does not establish compatibility. */
export interface QueryGroup { id: string; alternatives: string[] }
export function compileQueryGroups(query: string, groups?: QueryGroup[]) {
  if (groups === undefined) return [{ id: "query", alternatives: [{ expression: query, tokens: [...new Set(terms(query))] }] }];
  const selected = groups;
  if (!selected.length || selected.length > 9 || new Set(selected.map(group => group.id)).size !== selected.length
    || selected.some(group => !group.id || group.id.length > 64 || !group.alternatives.length || group.alternatives.length > 10
      || group.alternatives.some(value => typeof value !== "string" || value.length > 4000))
    || selected.reduce((sum, group) => sum + group.alternatives.reduce((n, value) => n + value.length, 0), 0) > 32000) throw new Error("Invalid retrieval query groups");
  return selected.map(group => ({ id: group.id, alternatives: [...new Set(group.alternatives)].map(expression => ({ expression, tokens: [...new Set(terms(expression))] })) }));
}

/** Round-robin ranked candidates reserve space for each declared need. A record
 * can appear only once; source packages are still assembled atomically later. */
export function interleaveCandidates<T>(groups: T[][], key: (value: T) => string, first: T[] = []): T[] {
  const out: T[] = [], seen = new Set<string>(), cursors = groups.map(() => 0);
  const add = (value: T) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); out.push(value); return true; };
  first.forEach(add);
  let progress = true;
  while (progress) {
    progress = false;
    groups.forEach((group, i) => {
      while (cursors[i]! < group.length) {
        const value = group[cursors[i]!]!; cursors[i] = cursors[i]! + 1;
        if (add(value)) { progress = true; break; }
      }
    });
  }
  return out;
}
