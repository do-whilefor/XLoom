import { defaultConfig } from "../../src/config.js";
import type { BoardSnapshot } from "../../src/types.js";
import { wikiBasis } from "../../src/wiki/model.js";

/** Deterministic corpus, no real targets or original-file reads. */
export function observationRetrievalFixture(size = 1000): BoardSnapshot {
  const board: BoardSnapshot = { revision: 1, config: defaultConfig("Synthetic retrieval corpus"), status: "running", outcome: null, reason: "",
    goals: [{ id: "G0", parentId: null, description: "Synthetic retrieval corpus", status: "active", factIds: [] }],
    facts: [], evidence: [], steps: [], findings: [], wikiPages: [], hints: [], usage: { input: 0, output: 0, cost: 0 },
    completedSteps: size, noProgressCount: 0, lastMetaStep: size, lastMetaRevision: 1 };
  for (let i = 0; i < size; i++) {
    board.evidence.push({ id: `E-${i}`, path: `evidence/${i}.bin`, pathBase: "task", bytes: 1, sha256: "0".repeat(64),
      description: `Fixture source ${i}`, runId: "PRIVATE", stepId: `S-${i}` });
    board.steps.push({ id: `S-${i}`, goalId: "G0", from: [], description: `Inspect item ${i}`, successSignal: "Observed fixture", evidencePlan: "Save original",
      priority: 1, status: "done", attempts: 1, runId: null, leaseUntil: null });
    board.facts.push({ id: `F-${i}`, stepId: `S-${i}`, description: `item${i} downloadReport scoped to alice/v1. Cross-tenant access is NOT verified.`, evidenceIds: [`E-${i}`] });
  }
  // The entire graph exists before any basis is sealed.
  for (let i = 0; i < size; i += 20) {
    const sources = [{ kind: "fact" as const, id: `F-${i}` }];
    board.wikiPages!.push({ id: `WK-${i}`, title: `报表权限 item${i}`, revision: 1, boardRevision: 1, history: [], blocks: [{ id: "B-boundary", title: "下载边界",
      text: `item${i} 报表下载仅验证 alice/v1。跨租户访问尚未验证；观察不等于影响。`, sources, basis: wikiBasis(board, sources) }] });
  }
  return board;
}
