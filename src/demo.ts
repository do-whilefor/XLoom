import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner, RunRequest, RunResult } from "./types.js";

/** Deterministic offline wiring fixture, deliberately not a security test or a model. */
export class DemoRunner implements AgentRunner {
  async run(request: RunRequest): Promise<RunResult> {
    request.signal.throwIfAborted();
    const usage = { input: 0, output: 0, cost: 0 };
    const board = request.snapshot;
    request.onEvent({ type: "notice", mode: request.mode, text: "DEMO: deterministic synthetic fixture; no model or external target is contacted." });
    if (request.mode === "execute") {
      await writeFile(path.join(request.runDir, "artifacts", "fixture.json"), JSON.stringify({
        synthetic: true, purpose: "Exercise the xloom protocol; this is NOT a network response or vulnerability evidence.",
        cases: [{ subject: "fixture-owner", object: "fixture-A", expected: "allow", observed: "allow" }, { subject: "fixture-other", object: "fixture-A", expected: "deny", observed: "deny" }],
      }, null, 2), { flag: "wx" });
      return { usage, output: { summary: "DEMO: fixture comparison recorded", result: "done",
        evidence: [{ ref: "e1", path: "fixture.json", description: "Synthetic offline protocol fixture, not real target evidence" }],
        facts: [{ ref: "f1", description: "DEMO: both synthetic comparison cases match their fixture expectations", evidenceRefs: ["e1"] }],
        findings: [{ key: "demo-only", title: "DEMO synthetic hypothesis", target: "fixture subject × local fixture × fixture object × read × two fixture identities", status: "lead", factRefs: ["f1"], evidenceRefs: ["e1"], next: "Close the synthetic fixture only; no security conclusion about a real target is possible." }] } };
    }
    if (!board.steps.length) return { usage, output: { summary: "DEMO: schedule the local synthetic comparison",
      steps: [{ goalId: "G0", from: [], description: "Record the offline fixture comparison", successSignal: "A synthetic artifact exists", evidencePlan: "Retain two explicitly synthetic cases", priority: 1 }] } };
    const finding = board.findings[0];
    if (!finding) throw new Error("Demo fixture graph is incomplete.");
    return { usage, output: { summary: "DEMO: synthetic fixture finished",
      reviews: [{ findingId: finding.id, status: "closed", rating: "unrated", reason: "DEMO fixture cases matched; reopen if the fixture changes. This does not assess any real security boundary." }],
      ...(board.goals[0].status === "active" ? { updateGoals: [{ id: "G0", status: "satisfied", factIds: [board.facts[0].id], reason: "Offline wiring fixture completed" }] } : {}),
      conclusion: { outcome: "NOT_REPRODUCED", reason: "DEMO ONLY: synthetic fixture concluded; no live target or model was tested." } } };
  }
}
