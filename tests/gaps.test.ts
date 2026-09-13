import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { gapContext, gapQueue, type GapProposal } from "../src/knowledge/gaps.js";
import { validateKnowledgeSubmission } from "../src/knowledge/model.js";
import { knowledgeContext } from "../src/knowledge/context.js";
import { defaultLoopPolicy } from "../src/loop/policy.js";
import { validateDecisionReferences } from "../src/loop/references.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { runLocal } from "../src/wiki/local.js";
import { wikiFilename } from "../src/wiki/format.js";
import type { Execution, RunRequest, StepProposal } from "../src/types.js";
import type { CapabilityProposal } from "../src/knowledge/schema.js";

const usage = { input: 2, output: 1, cost: 0 };
const opened: { root: string; store: BlackboardStore }[] = [];
const conditions = { scope: "fixture", identity: "user-a", environment: "lab", stateVersion: "v1" };
const port = (type: string) => ({ type, aliases: [], description: `Fixture ${type}` });
const gap: GapProposal = { id: "gap-session", missing: "Fixture session", why: "Old check cannot proceed", reopenWhen: "A compatible fixture session is recorded", needs: [port("session")], conditions };
const proposal = (run: string): StepProposal => ({ goalId: "G0", from: [], description: `Fixture ${run}`, successSignal: "Local recorded result", evidencePlan: "Synthetic text", priority: 1 });
function begin(store: BlackboardStore, run: string) {
  store.beginRun(`plan-${run}`, "decide"); store.applyDecision(`plan-${run}`, { summary: "Plan fixture", steps: [proposal(run)] }, usage);
  const step = store.snapshot().steps.at(-1)!; store.beginRun(run, "execute", step.id);
  return step;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-gaps-"));
  const store = new BlackboardStore(root, defaultConfig("Synthetic gap workflow"), { taskId: "task-gaps" }); opened.push({ root, store });
  store.setStatus("running", "Fixture"); const step = begin(store, "initial");
  return { root, store, step };
}
function observe(store: BlackboardStore, run: string, extra: Partial<Execution> = {}): Execution {
  const directory = join(store.dataDir, "runs", run, "artifacts"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "original.txt"), `SYNTHETIC ONLY ${run}: fixture local observation. No target contacted.`);
  return { summary: "Fixture observation", result: "done", evidence: [{ ref: "e", path: "original.txt", description: "Local fixture" }],
    facts: [{ ref: "f", description: `Fixture ${run} result`, evidenceRefs: ["e"] }], ...extra };
}
function capability(id = "C-session", overrides: Partial<CapabilityProposal> = {}): CapabilityProposal {
  return { id, title: "Fixture session", status: "available", provides: [port("session")], needs: [], conditions, factRefs: ["f"], counterFactRefs: [], changeReason: "Fixture", ...overrides };
}
afterEach(() => { for (const { root, store } of opened.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });

describe("durable gap → material → review → Decide step selection", () => {
  it("persists gaps through checkpoints/restart and exposes original Step pages and a read-only command", () => {
    const { root, store, step } = fixture();
    const output = { summary: "Missing session", result: "blocked", gaps: [gap] };
    store.applyExecutionCheckpoint("initial", "gap", output, usage); const checkpoint = store.snapshot();
    store.applyExecutionCheckpoint("initial", "gap", output, usage); expect(store.snapshot()).toEqual(checkpoint);
    store.applyExecution("initial", { summary: "Still missing", result: "blocked" }, usage);
    expect(store.snapshot().noProgressCount).toBe(1);
    const before = store.snapshot(); store.close();
    const reopened = new BlackboardStore(root, before.config, { taskId: "task-gaps" }); opened[0]!.store = reopened;
    expect(reopened.snapshot().steps[0]!.gaps).toEqual(before.steps[0]!.gaps);
    expect(gapQueue(reopened.snapshot())[0]).toMatchObject({ stepId: step.id, state: "review_required", evidence: false });
    expect(readFileSync(join(reopened.dataDir, "wiki", "pages", wikiFilename("step", step.id)), "utf8")).toContain("gap-session");
    const stable = reopened.snapshot();
    expect(runLocal(["gaps", "--task", reopened.dataDir, "--workspace", root]).output).toMatchObject({ items: [{ gapId: gap.id }] });
    expect(reopened.snapshot()).toEqual(stable);
  });

  it("reopens an old deferred gap on new compatible material, selects a bounded revisit and resolves only after new evidence", () => {
    const { store, step, root } = fixture(); store.applyExecution("initial", { summary: "Missing", result: "blocked", gaps: [gap] }, usage);
    store.beginRun("defer", "decide"); store.applyDecision("defer", { summary: "Wait for input", gapReviews: [{ stepId: step.id, gapId: gap.id, action: "defer", reason: "No fixture session yet", factIds: [] }] }, usage);
    expect(gapQueue(store.snapshot())[0]!.state).toBe("waiting");
    const material = begin(store, "material"), before = store.snapshot();
    store.applyExecution("material", observe(store, "material", { capabilities: [capability()] }), usage);
    const after = store.snapshot(), queue = gapQueue(after);
    expect(queue[0]).toMatchObject({ state: "review_required", reason: "sources_changed", candidateNeedIndices: [0], evidence: false });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, material.id)?.kind).toBe("gap_review");
    const request: RunRequest = { id: "review", mode: "decide", snapshot: after, workspace: root, runDir: join(store.dataDir, "runs", "review"), blackboardPath: store.projectionPath, signal: new AbortController().signal, onEvent() {} };
    expect(JSON.parse(buildRunPrompt(request).userPrompt.split("\n").at(-1)!).gaps.items[0]).toMatchObject({ stepId: step.id, state: "review_required" });
    store.beginRun("review", "decide");
    const plan = { ...proposal("bounded revisit with the new session"), from: [after.facts[0]!.id], priority: 99, revisits: [{ stepId: step.id, gapId: gap.id }] };
    const decision = { summary: "Validate the candidate", steps: [plan] };
    expect(() => validateDecisionReferences(after, decision)).not.toThrow(); store.applyDecision("review", decision, usage);
    const planned = store.snapshot(), selected = defaultLoopPolicy.selectStep(planned)!;
    expect(selected.revisits).toEqual(plan.revisits); expect(gapQueue(planned)[0]!.state).toBe("planned");
    expect(planned.steps[0]!.status).toBe("blocked");
    store.beginRun("verify", "execute", selected.id);
    expect(gapQueue(store.snapshot())[0]!.state).toBe("planned");
    const prior = store.snapshot(); store.applyExecution("verify", observe(store, "verify"), usage);
    const verified = store.snapshot();
    expect(gapQueue(verified)[0]!.sources[0]!.source.id).toBe(verified.facts.at(-1)!.id);
    expect(defaultLoopPolicy.reviewAfterExecution(prior, verified, selected.id)?.kind).toBe("gap_review");
    store.beginRun("resolve", "metacog"); store.applyDecision("resolve", { summary: "Gap checked", gapReviews: [{ stepId: step.id, gapId: gap.id, action: "resolve", reason: "Fixture transcript demonstrates required session", factIds: [verified.facts.at(-1)!.id] }] }, usage);
    expect(gapQueue(store.snapshot())[0]!.state).toBe("resolved");
    expect(store.snapshot().steps[0]!.status).toBe("blocked"); expect(store.snapshot().goals[0]!.status).toBe("active"); expect(store.snapshot().findings).toEqual([]);
    begin(store, "correct"); store.applyExecution("correct", observe(store, "correct", { facts: [{ ref: "f", description: "Earlier fixture result corrected", evidenceRefs: ["e"], supersedes: verified.facts.at(-1)!.id }] }), usage);
    expect(gapQueue(store.snapshot())[0]).toMatchObject({ state: "review_required", reason: "sources_changed" });
  });

  it.each(["no_progress", "blocked"] as const)("reviews a settled %s revisit even when no new Facts were produced", result => {
    const { store, step } = fixture(); store.applyExecution("initial", { summary: "Missing", result: "blocked", gaps: [gap] }, usage);
    store.beginRun("review", "decide"); store.applyDecision("review", { summary: "Inspect input", steps: [{ ...proposal("new variable"), revisits: [{ stepId: step.id, gapId: gap.id }] }] }, usage);
    const next = defaultLoopPolicy.selectStep(store.snapshot())!; store.beginRun("empty", "execute", next.id);
    store.applyExecution("empty", { summary: "No useful fixture input", result }, usage);
    expect(gapQueue(store.snapshot())[0]!.state).toBe("review_required");
  });

  it("associates same-batch source refs explicitly without requiring a type match", () => {
    const { store, step } = fixture(); store.applyExecution("initial", { summary: "Missing", result: "blocked", gaps: [{ ...gap, needs: [] }] }, usage);
    begin(store, "material"); const output = observe(store, "material", { gapLinks: [{ stepId: step.id, gapId: gap.id, sources: [{ kind: "fact", id: "f" }], reason: "New fixture documentation explains the missing input" }] });
    expect(() => validateKnowledgeSubmission(store.snapshot(), output, store.snapshot().steps.at(-1)!.id)).not.toThrow();
    store.applyExecution("material", output, usage);
    expect(gapQueue(store.snapshot())[0]!.sources[0]!.source.id).toBe(store.snapshot().facts[0]!.id);
    expect(gapQueue(store.snapshot())[0]!.candidates).toEqual([]);
  });

  it.each(["conflict", "unknown", "unavailable", "stale"])("retains %s warnings without declaring inputs resolved", kind => {
    const { store } = fixture(); store.applyExecution("initial", { summary: "Missing", result: "blocked", gaps: [gap] }, usage);
    begin(store, "material");
    store.applyExecution("material", observe(store, "material", { capabilities: [capability("C-session", kind === "conflict" ? { conditions: { ...conditions, identity: "other" } } : kind === "unknown" ? { conditions: { ...conditions, identity: null } } : kind === "unavailable" ? { status: "unavailable" } : {})] }), usage);
    if (kind === "stale") { const factId = store.snapshot().facts[0]!.id; begin(store, "revision"); store.applyExecution("revision", observe(store, "revision", { facts: [{ ref: "f", description: "Fixture revision", evidenceRefs: ["e"], supersedes: factId }] }), usage); }
    const item = gapQueue(store.snapshot())[0]!;
    expect(item.state).toBe("review_required"); expect(item.evidence).toBe(false);
    if (kind !== "unknown") expect(item.candidateNeedIndices).toEqual([]);
    else expect(item.candidates[0]!.conditions.status).toBe("unknown");
  });

  it("puts an old gap consumer ahead of recent unrelated consumers", () => {
    const { store, root } = fixture();
    store.applyExecution("initial", observe(store, "initial", { result: "blocked", gaps: [{ ...gap, capabilityId: "C-old" }], capabilities: [capability("C-old", { provides: [port("result")], needs: [port("session")], status: "candidate" }), ...Array.from({ length: 8 }, (_, index) => capability(`C-recent-${index}`, { needs: [port("other")] }))] }), usage);
    const request: RunRequest = { id: "fixture", mode: "decide", snapshot: store.snapshot(), workspace: root, runDir: "fixture", blackboardPath: store.projectionPath, signal: new AbortController().signal, onEvent() {} };
    expect(knowledgeContext(request)!.discovery.items[0]!.consumerId).toBe("C-old");
  });

  it("rejects missing references, unsupported resolution and rewritten gap IDs atomically", () => {
    const { store, step } = fixture(); store.applyExecutionCheckpoint("initial", "gap", { summary: "Missing", result: "blocked", gaps: [gap] }, usage);
    const before = store.snapshot();
    for (const extra of [{ gaps: [{ ...gap, missing: "A different requirement" }] }, { gapLinks: [{ stepId: step.id, gapId: gap.id, sources: [{ kind: "fact", id: "absent" }], reason: "Invalid" }] }]) {
      expect(() => store.applyExecutionCheckpoint("initial", "bad", { summary: "Bad", result: "blocked", ...extra }, usage)).toThrow(); expect(store.snapshot()).toEqual(before);
    }
    store.applyExecution("initial", { summary: "Missing", result: "blocked" }, usage); store.beginRun("bad-review", "decide"); const previous = store.snapshot();
    expect(() => store.applyDecision("bad-review", { summary: "No evidence", gapReviews: [{ stepId: step.id, gapId: gap.id, action: "resolve", reason: "Match only", factIds: [] }] }, usage)).toThrow(/evidence-backed/);
    expect(store.snapshot()).toEqual(previous);
  });

  it("defers whole oversized entries instead of dropping warnings or requirements", () => {
    const { store } = fixture(); store.applyExecution("initial", { summary: "Missing", result: "blocked", gaps: [gap] }, usage);
    const board = store.snapshot(); board.steps[0]!.gaps![0]!.sources = Array.from({ length: 50 }, (_, i) => ({ source: { kind: "fact", id: `absent-${i}` }, reason: "explanation ".repeat(50) }));
    const context = gapContext(board); expect(context.items).toEqual([]); expect(context.deferred).toEqual([{ stepId: board.steps[0]!.id, gapId: gap.id }]);
  });
});
