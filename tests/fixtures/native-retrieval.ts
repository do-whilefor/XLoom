import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.js";
import { BlackboardStore } from "../../src/store.js";
import type { Execution, ProjectConfig } from "../../src/types.js";
import type { CapabilityProposal } from "../../src/knowledge/schema.js";

export const zero = { input: 0, output: 0, cost: 0 };
export const conditions = { scope: "local report", identity: "alice", environment: "synthetic", stateVersion: "v1" };
export const port = (type: string) => ({ type, aliases: [], description: `Local ${type}` });
export const consumer: CapabilityProposal = { id: "C-download", title: "Local report consumer", status: "candidate", provides: [port("report-content")],
  needs: [port("downloadGrant")], conditions, factRefs: ["setup"], counterFactRefs: [], changeReason: "Synthetic interface contract" };
export function beginFixtureStep(store: BlackboardStore, run: string) {
  store.setStatus("running", "Synthetic native retrieval fixture");
  store.beginRun(`plan-${run}`, "decide");
  store.applyDecision(`plan-${run}`, { summary: "Prepare local sample", steps: [{ goalId: "G0", from: [], description: run,
    successSignal: "Recorded local result", evidencePlan: "Retain synthetic original", priority: 1 }] }, zero);
  const step = store.snapshot().steps.at(-1)!; store.beginRun(run, "execute", step.id); return step;
}
export function fixtureEvidence(store: BlackboardStore, run: string, body: string) {
  const directory = join(store.dataDir, "runs", run, "artifacts"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "sample.txt"), `SYNTHETIC LOCAL FIXTURE ONLY; no target contacted.\n${body}`);
  return [{ ref: "e", path: "sample.txt", description: "Synthetic local observation" }];
}
export function nativeFixture(workspace: string, config: ProjectConfig = defaultConfig("验证本地报表的实际下载结果；已有凭据不等于完成下载", "Only synthetic local fixture files")) {
  const store = new BlackboardStore(workspace, config, { taskId: "task-native-fixture" });
  const step = beginFixtureStep(store, "seed");
  store.applyExecution("seed", { summary: "Local consumer is blocked", result: "blocked",
    evidence: fixtureEvidence(store, "seed", "Local download interface requires a grant. No grant observed; download not attempted."),
    facts: [{ ref: "setup", description: "Local download interface contract", evidenceRefs: ["e"] },
      { ref: "missing", description: "No grant was observed in the initial sample", evidenceRefs: ["e"] }],
    capabilities: [consumer],
    gaps: [{ id: "gap-download", missing: "downloadGrant", why: "Local download cannot proceed", reopenWhen: "A grant with compatible conditions is observed",
      needs: [port("downloadGrant")], conditions, capabilityId: consumer.id }],
    wikiPages: [{ id: "WK-bridge", title: "BridgeNote", blocks: [{ id: "B-boundary", title: "Interpretation",
      text: "BridgeNote: 本地报表仍缺下载授权。即使获得授权，也必须核对 alice / v1 条件并实际验证下载；尚未观察到报表内容。", sources: [{ kind: "fact", id: "missing" }] }] }],
  }, zero);
  const oldFactId = store.snapshot().facts.find(fact => fact.description.startsWith("No grant"))!.id;
  const addProvider = () => {
    beginFixtureStep(store, "provider");
    const output: Execution = { summary: "New local input observed; final download still unverified", result: "done",
      evidence: fixtureEvidence(store, "provider", "downloadGrant=LOCAL_ONLY; identity=alice; stateVersion=v1; download=NOT_ATTEMPTED"),
      facts: [{ ref: "grant", description: "A grant is now observed; actual download remains unverified", evidenceRefs: ["e"], supersedes: oldFactId }],
      capabilities: [{ id: "C-grant", title: "Local grant provider", status: "available", provides: [port("downloadGrant")], needs: [], conditions,
        factRefs: ["grant"], counterFactRefs: [], changeReason: "New synthetic sample" }] };
    store.applyExecution("provider", output, zero);
  };
  return { store, step, oldFactId, addProvider };
}
