import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.js";
import { BlackboardStore } from "../../src/store.js";
import type { ProjectConfig, Execution } from "../../src/types.js";

export const wikiZero = { input: 0, output: 0, cost: 0 };
/** Synthetic observations only; also used by the opt-in live authoring replay. */
export function wikiStructureFixture(root: string, config: ProjectConfig = defaultConfig("Synthetic Wiki structure")) {
  const store = new BlackboardStore(root, config);
  let sequence = 0;
  function claim(description = "Maintain the synthetic research Wiki") {
    const id = ++sequence, runId = `wiki-execute-${id}`;
    store.setStatus("running", "Synthetic fixture"); store.beginRun(`wiki-decide-${id}`, "decide");
    const board = store.applyDecision(`wiki-decide-${id}`, { summary: "Synthetic fixture", steps: [{ goalId: "G0", from: [], description: `${description} (synthetic batch ${id})`,
      successSignal: "Wiki references and unchanged review baselines verified", evidencePlan: "Synthetic local observations only", priority: 1 }] }, wikiZero);
    const step = board.steps.find(item => item.status === "ready")!;
    store.beginRun(runId, "execute", step.id);
    const artifacts = join(store.dataDir, "runs", runId, "artifacts"); mkdirSync(artifacts, { recursive: true });
    return { runId, step, artifacts };
  }
  function submit(wikiPages: Execution["wikiPages"]) {
    const run = claim();
    return store.applyExecution(run.runId, { summary: "Maintain sourced explanation", result: "no_progress", wikiPages }, wikiZero);
  }
  const run = claim();
  writeFileSync(join(run.artifacts, "observation.txt"), "SYNTHETIC LOCAL ONLY: submission returned a label, no download executed.");
  writeFileSync(join(run.artifacts, "scope.txt"), "SYNTHETIC LOCAL ONLY: only alice / v1 was observed. Cross-account use is unverified.");
  const initial = store.applyExecution(run.runId, { summary: "Record synthetic boundary", result: "done",
    evidence: [{ ref: "e", path: "observation.txt", description: "Synthetic submission" }, { ref: "scope", path: "scope.txt", description: "Synthetic scope" }],
    facts: [{ ref: "f", description: "A label was returned", evidenceRefs: ["e"] }, { ref: "scope", description: "Observation limited to alice / v1", evidenceRefs: ["scope"] }],
    wikiPages: [
      { id: "WK-flow", title: "Submission", parentPageId: "WK-index", summary: "Synthetic workflow explanation", questions: ["为什么标识符不能证明下载成功？"], aliases: ["BridgeAlias"],
        blocks: [{ id: "B-judgment", title: "Observed result", text: "A label was returned. Successful downloading is unverified.", sources: [{ kind: "fact", id: "f" }],
          keywords: ["LabelBridge"], requiredBlockRefs: [{ pageId: "WK-context", blockId: "B-limit" }] }] },
      { id: "WK-context", title: "Boundary", blocks: [
        { id: "B-limit", title: "Limitation", text: "Cross-account consumption is unverified; preserve the identity and version conditions.", sources: [{ kind: "fact", id: "scope" }],
          requiredBlockRefs: [{ pageId: "WK-context", blockId: "B-scope" }] },
        { id: "B-scope", title: "Conditions", text: "Only alice / v1 was observed. This is not transferable to bob / v2.", sources: [{ kind: "fact", id: "scope" }], aliases: ["ScopeAlias"] },
      ] },
      { id: "WK-index", title: "Local reports", blocks: [{ id: "B-directory", title: "Navigation", text: "DIRECTORY_ONLY. This page organizes local synthetic notes.", sources: [{ kind: "goal", id: "G0" }] }] },
    ],
  }, wikiZero);
  const factId = initial.facts[0]!.id, scopeId = initial.facts[1]!.id;
  function correct() {
    const run = claim(); writeFileSync(join(run.artifacts, "correction.txt"), "SYNTHETIC CORRECTION: v1 observation withdrawn. Only alice / v2 denial was observed; no success.");
    return store.applyExecution(run.runId, { summary: "Correct synthetic scope", result: "done",
      evidence: [{ ref: "new-scope", path: "correction.txt", description: "Synthetic correction" }],
      facts: [{ ref: "new-scope", description: "Old observation withdrawn; alice / v2 denial only", evidenceRefs: ["new-scope"], supersedes: scopeId }],
    }, wikiZero);
  }
  return { store, initial, factId, scopeId, claim, submit, correct };
}
