import type { BoardSnapshot } from "../types.js";
import { readVerifiedArchive, originalReadPath } from "../wiki/originals.js";
import { wikiGenerator } from "../wiki/format.js";
import { compareValues, comparisonFields } from "./compare.js";

/** Evidence IDs are task-local, content-addressed originals; no parallel observation store. */
export function compareEvidence(board: BoardSnapshot, dataDir: string, workspace: string, leftId: string, rightId: string, fields: unknown = []) {
  const selected = comparisonFields(fields);
  const evidence = [leftId, rightId].map(id => {
    const record = board.evidence.find(item => item.id === id);
    if (!record) throw new Error(`Unknown comparison Evidence ID: ${id}`);
    return record;
  });
  const loaded = new Map<string, { text?: string; issue?: string }>();
  for (const item of evidence) if (!loaded.has(item.id)) {
    try { loaded.set(item.id, { text: readVerifiedArchive(item, dataDir, workspace) }); }
    catch (error) { loaded.set(item.id, { issue: (error as Error).message }); }
  }
  const sources = evidence.map(item => ({ evidenceId: item.id, sha256: item.sha256, bytes: item.bytes, stepId: item.stepId,
    originalReadPath: originalReadPath({ evidenceId: item.id, sha256: item.sha256, byteOffset: 0 }),
    integrity: loaded.get(item.id)!.issue ? "unavailable" : "verified", issues: loaded.get(item.id)!.issue ? [loaded.get(item.id)!.issue] : [] }));
  const base = { generator: wikiGenerator, type: "observation_comparison", evidence: false, assessment: "comparison_only", boardRevision: board.revision,
    sources: { left: sources[0]!, right: sources[1]! } };
  if (sources.some(source => source.issues.length)) return { ...base, status: "unavailable", gaps: [{ code: "source_unavailable" }] };
  const raw = evidence.map(item => {
    try { return JSON.parse(loaded.get(item.id)!.text!, (_key, value) => {
      if (typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw new Error("Unsupported numeric precision");
      return value;
    }); }
    catch { throw new Error(`Comparison requires a JSON object archive with finite, safe numeric values: ${item.id}. Read unsupported originals directly; encode large identifiers as strings.`); }
  });
  return { ...base, status: "ready", ...compareValues(raw[0], raw[1], selected) };
}
