import { taskDirectory } from "../src/workspace.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LoopController, type LoopControllerOptions } from "../src/controller.js";
import { projectContext } from "../src/loop/context.js";
import { defaultLoopPolicy } from "../src/loop/policy.js";
import { projectConfigSchema } from "../src/schema.js";
import { BlackboardStore } from "../src/store.js";
import type { Decision, Execution, LoopEvent, ProjectConfig, RunRequest, RunResult, Step, Usage } from "../src/types.js";

const roots: string[] = [];
const stores: BlackboardStore[] = [];
const controllers: LoopController[] = [];
const standardUsage: Usage = { input: 10, output: 5, cost: 0.001 };
const result = (output: unknown, usage = standardUsage): RunResult => ({ output, usage });
const plan = (description = "Compare synthetic fixture identities"): Decision => ({
  summary: "Plan synthetic protocol exercise, not a live security test",
  steps: [{ goalId: "G0", from: [], description, successSignal: "Fixture artifact saved", evidencePlan: "Save synthetic response fixture", priority: 50 }],
});

function setup(handler: (request: RunRequest) => Promise<RunResult> | RunResult, limits: Partial<ProjectConfig["limits"]> & { maxSteps?: number } = {}, options: LoopControllerOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-controller-test-"));
  roots.push(root);
  const defaults = defaultConfig("Exercise local loop protocol with synthetic fixtures only");
  const config = projectConfigSchema.parse({ ...defaults, limits: { ...defaults.limits, ...limits } });
  const store = new BlackboardStore(root, config);
  stores.push(store);
  const requests: RunRequest[] = [];
  const run = vi.fn(async (request: RunRequest) => {
    requests.push(request);
    if (requests.length > 100) throw new Error("Synthetic test exceeded its expected run count");
    return handler(request);
  });
  const controller = new LoopController(store, { run }, options);
  controllers.push(controller);
  const events: LoopEvent[] = [];
  controller.subscribe((event) => { events.push(event); });
  return { root, store, controller, requests, run, events };
}

function fixtureExecution(request: RunRequest): Execution {
  writeFileSync(path.join(request.runDir, "artifacts", "fixture.txt"), "SYNTHETIC TEST FIXTURE ONLY\nidentity=A: expected allowed\nidentity=B: expected denied\n");
  return {
    summary: "Saved synthetic fixture for testing state transitions; not real target evidence",
    result: "done",
    evidence: [{ ref: "fixture-e", path: "fixture.txt", description: "Synthetic unit-test artifact" }],
    facts: [{ ref: "fixture-f", description: "Synthetic fixture contains expected allow/deny labels", evidenceRefs: ["fixture-e"] }],
    findings: [{ key: "synthetic-ownership", title: "Synthetic hypothesis", target: "local fixture", status: "lead", factRefs: ["fixture-f"], evidenceRefs: ["fixture-e"], next: "Close protocol-test hypothesis after synthetic review" }],
  };
}

function seedHistoryStep(store: BlackboardStore, status: "done" | "no_progress" | "blocked" | "failed" | "abandoned"): Step {
  store.setStatus("running", "Seed historical synthetic attempt");
  store.beginRun("seed-plan", "decide");
  const step = store.applyDecision("seed-plan", plan("Historical synthetic attempt"), standardUsage).steps[0]!;
  if (status === "abandoned") {
    store.beginRun("seed-abandon", "decide");
    store.applyDecision("seed-abandon", { summary: "Retire unused fixture plan", updateSteps: [
      { id: step.id, action: "abandon", reason: "Fixture plan was superseded before execution" },
    ] }, standardUsage);
  } else {
    store.beginRun("seed-execute", "execute", step.id);
    if (status === "failed") store.failRun("seed-execute", "Synthetic interrupted attempt", standardUsage);
    else {
      const output: Execution = { summary: `Historical fixture result: ${status}`, result: status };
      if (status === "done") {
        const artifactDir = path.join(store.dataDir, "runs", "seed-execute", "artifacts");
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(path.join(artifactDir, "history.txt"), "Original synthetic observation; must remain unchanged");
        output.evidence = [{ ref: "history-e", path: "history.txt", description: "Original historical fixture" }];
        output.facts = [{ ref: "history-f", description: "Historical fixture observation", evidenceRefs: ["history-e"] }];
      }
      store.applyExecution("seed-execute", output, standardUsage);
    }
  }
  return store.snapshot().steps[0]!;
}

function closure(request: RunRequest): Decision {
  return {
    summary: "Synthetic terminal-state validation, not a real vulnerability conclusion",
    updateGoals: [{ id: "G0", status: "satisfied", factIds: [request.snapshot.facts[0]!.id], reason: "The synthetic fixture goal and its evidence were reviewed" }],
    reviews: [{ findingId: request.snapshot.findings[0]!.id, status: "closed", rating: "unrated", reason: "Fixture only: expected labels match; reopen this synthetic case when fixture expectations change" }],
    conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic protocol test completed; no live target was tested" },
  };
}

function abortable(request: RunRequest, usage: Usage = { input: 7, output: 2, cost: 0.0004 }): Promise<RunResult> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Mock provider interrupted"), { usage }));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith("xloom-controller-test-")) throw new Error("Unexpected test cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("LoopController synthetic protocol flow", () => {
  it("hands the next planner only changed committed IDs and does not carry that delta into later runs", async () => {
    const test = setup(request => request.mode === "execute" ? result(fixtureExecution(request))
      : result(request.snapshot.completedSteps ? closure(request) : plan()));
    await test.controller.start();
    const [planning, execution, review, completion] = test.requests;
    expect(planning.handoff).toBeUndefined(); expect(execution.handoff).toBeUndefined();
    expect(review.handoff).toEqual({ sourceStepId: execution.step!.id,
      factIds: review.snapshot.facts.map(item => item.id), evidenceIds: review.snapshot.evidence.map(item => item.id),
      findingIds: review.snapshot.findings.map(item => item.id) });
    expect(completion.handoff).toBeUndefined();
    expect(JSON.stringify(review.handoff)).not.toMatch(/description|summary|messages|runDir|models/);
  });

  it("emits summaries only after commit and does not label a deferred completion proposal as a final outcome", async () => {
    const test = setup(request => request.mode === "execute" ? result(fixtureExecution(request))
      : result(request.snapshot.completedSteps ? closure(request) : plan()));
    const committed: { reason: string; status: string; runStatus: string | undefined }[] = [];
    test.controller.subscribe(event => {
      if (event.type === "result") committed.push({ reason: test.controller.snapshot().reason, status: test.controller.snapshot().status, runStatus: test.store.runs().at(-1)?.status });
    });
    await test.controller.start();
    const summaries = test.events.flatMap(event => event.type === "result" && event.result ? [event.result] : []);
    expect(summaries).toEqual([
      { mode: "decide", summary: plan().summary },
      { mode: "execute", summary: "Saved synthetic fixture for testing state transitions; not real target evidence" },
      { mode: "decide", summary: "Synthetic terminal-state validation, not a real vulnerability conclusion" },
      { mode: "metacog", summary: "Synthetic protocol test completed; no live target was tested", outcome: "NOT_REPRODUCED" },
    ]);
    expect(committed.map(item => item.reason)).toEqual(summaries.map(item => item.summary));
    expect(committed.map(item => item.runStatus)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(committed.map(item => item.status)).toEqual(["running", "running", "running", "completed"]);
    expect(summaries.slice(0, -1).every(item => !Object.hasOwn(item, "outcome"))).toBe(true);
  });

  it.each([false, true])("preserves valid NEED_INPUT without claiming completion (ready plan: %s)", async readyPlan => {
    const test = setup(request => {
      if (request.mode === "execute") {
        const output = fixtureExecution(request);
        output.findings![0]!.next = "Provide a second synthetic account before the next comparison.";
        return result(output);
      }
      if (!request.snapshot.completedSteps) return result(readyPlan ? { ...plan(), steps: [
        { ...plan("First fixture action").steps![0]!, priority: 100 },
        { ...plan("Action requiring the missing fixture account").steps![0]!, priority: 50 },
      ] } : plan());
      return result({ summary: "Input gap review", conclusion: { outcome: "NEED_INPUT", reason: "A second synthetic fixture account is missing." } });
    });
    await test.controller.start();
    const summaries = test.events.flatMap(event => event.type === "result" && event.result ? [event.result] : []);
    expect(summaries.at(-1)).toEqual({ mode: "metacog", summary: "A second synthetic fixture account is missing.", outcome: "NEED_INPUT" });
    expect(summaries.at(-2)).toEqual({ mode: "decide", summary: "Input gap review" });
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: "NEED_INPUT" });
    expect(test.controller.snapshot().goals[0]?.status).toBe("active");
    expect(test.requests.filter(request => request.mode === "execute")).toHaveLength(1);
    expect(test.controller.snapshot().steps.filter(step => step.status === "ready")).toHaveLength(readyPlan ? 1 : 0);
  });

  it("executes a first plan that mistakenly labels its unproduced results as NEED_INPUT", async () => {
    const test = setup(request => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.snapshot.completedSteps) return result(closure(request));
      return result({ ...plan(), conclusion: { outcome: "NEED_INPUT", reason: "The planned fixture output does not exist yet." } });
    });
    await test.controller.start();
    expect(test.requests.map(request => request.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(test.requests[1]!.snapshot).toMatchObject({ outcome: null, completedSteps: 0, findings: [] });
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1 });
    expect(test.events.some(event => event.type === "notice" && event.message?.includes("NEED_INPUT lacks"))).toBe(true);
    expect(test.events.some(event => event.type === "result" && event.result?.outcome === "NEED_INPUT")).toBe(false);
  });

  it("keeps a ready plan when metacognition proposes unsupported NEED_INPUT", async () => {
    const test = setup(request => {
      if (request.mode === "execute") return result(request.snapshot.completedSteps
        ? fixtureExecution(request) : { summary: "First fixture action was unavailable; an independent action remains", result: "blocked" });
      if (!request.snapshot.steps.length) return result({ ...plan(), steps: [
        { ...plan("First fixture action").steps![0]!, priority: 100 },
        { ...plan("Independent fixture action").steps![0]!, priority: 50 },
      ] });
      if (request.snapshot.completedSteps === 1) {
        expect(request.mode).toBe("metacog");
        expect(request.snapshot.findings).toEqual([]);
        return result({ summary: "The remaining action has no output yet", conclusion: { outcome: "NEED_INPUT", reason: "Waiting for the unexecuted action." } });
      }
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.map(request => request.mode)).toEqual(["decide", "execute", "metacog", "execute", "decide", "metacog"]);
    expect(test.requests.filter(request => request.mode === "execute").map(request => request.step!.description)).toEqual(["First fixture action", "Independent fixture action"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 2 });
  });

  it("checks unresolved findings after the proposal's reviews before accepting NEED_INPUT", async () => {
    const test = setup(request => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result({ ...plan(), steps: [
        { ...plan("First fixture comparison").steps![0]!, priority: 100 },
        { ...plan("Second fixture comparison").steps![0]!, priority: 50 },
      ] });
      if (request.snapshot.completedSteps === 1) return result({
        summary: "Close the resolved fixture hypothesis and keep the remaining action",
        reviews: closure(request).reviews,
        conclusion: { outcome: "NEED_INPUT", reason: "The second comparison is not recorded yet." },
      });
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.map(request => request.mode)).toEqual(["decide", "execute", "decide", "execute", "decide", "metacog"]);
    expect(test.requests[3]!.snapshot.findings[0]!.status).toBe("closed");
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 2 });
  });

  it("pauses operationally after reviewing unsupported NEED_INPUT without inventing a missing input", async () => {
    const test = setup(() => result({ summary: "No executable proposal", conclusion: { outcome: "NEED_INPUT", reason: "No results exist yet." } }));
    await test.controller.start();
    expect(test.requests.map(request => request.mode)).toEqual(["decide", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0, findings: [] });
    expect(test.controller.snapshot().reason).toContain("no executable step");
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.some(event => event.type === "result" && event.result?.outcome === "NEED_INPUT")).toBe(false);
  });

  it.each((["done", "no_progress", "blocked", "failed", "abandoned"] as const).flatMap(status =>
    (["abandon", "prioritize"] as const).map(action => ({ status, action }))))(
    "ignores $action of a $status Step while executing the valid new plan once", async ({ status, action }) => {
      const test = setup(request => {
        if (request.mode === "execute") return result(fixtureExecution(request));
        if (request.snapshot.steps.length > 1) return result(closure(request));
        return result({ ...plan("Follow up under changed fixture conditions"), updateSteps: [
          { id: request.snapshot.steps[0]!.id, action, priority: 75, reason: "Erroneous historical cleanup" },
        ] });
      });
      const history = seedHistoryStep(test.store, status);
      const before = test.store.snapshot();
      await test.controller.start();
      const board = test.controller.snapshot();
      expect(board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED" });
      expect(board.steps[0]).toEqual(history);
      expect(board.steps[1]).toMatchObject({ status: "done", attempts: 1 });
      expect(board.evidence.slice(0, before.evidence.length)).toEqual(before.evidence);
      expect(test.requests.map(request => request.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
      expect(test.requests[0]!.snapshot.steps[0]).toEqual(history);
      expect(board.usage.input - before.usage.input).toBe(4 * standardUsage.input);
      expect(board.usage.output - before.usage.output).toBe(4 * standardUsage.output);
      expect(board.usage.cost - before.usage.cost).toBeCloseTo(4 * standardUsage.cost);
      expect(test.events).toContainEqual(expect.objectContaining({ type: "notice",
        message: `Ignored Step ${history.id} ${action}: status is ${status}; history retained.` }));
    });

  it("keeps checkpoint evidence after a yield and commits ready updates and new work despite abandoning the blocked history", async () => {
    let yieldedHistory: Step | undefined;
    let checkpointEvidence: unknown;
    const test = setup(async request => {
      if (request.mode === "execute") {
        if (!request.snapshot.completedSteps) {
          const checkpoint = await request.onCheckpoint!("fixture-batch", fixtureExecution(request), standardUsage);
          checkpointEvidence = checkpoint.evidence[0];
          return { ...result({ summary: "Partial fixture checkpoint handed to Decide", result: "blocked" }), yielded: true };
        }
        return result(fixtureExecution(request));
      }
      if (!request.snapshot.completedSteps) return result({ ...plan(), steps: [
        { ...plan("Initial fixture extraction").steps![0]!, priority: 100 },
        { ...plan("Remaining independent fixture check").steps![0]!, priority: 50 },
      ] });
      if (request.snapshot.completedSteps === 1) {
        expect(request.mode).toBe("decide");
        yieldedHistory = request.snapshot.steps[0]!;
        expect(yieldedHistory.status).toBe("blocked");
        return result({ ...plan("Follow up from the committed partial fixture"), steps: [
          { ...plan("Follow up from the committed partial fixture").steps![0]!, from: [request.snapshot.facts[0]!.id], priority: 90 },
        ], updateSteps: [
          { id: yieldedHistory.id, action: "abandon", reason: "The old partial attempt needs replacement work" },
          { id: request.snapshot.steps[1]!.id, action: "prioritize", priority: 80, reason: "Keep the independent check" },
        ] });
      }
      return result(request.snapshot.completedSteps === 2 ? { summary: "Continue the remaining ready fixture check" } : closure(request));
    }, { metacogEvery: 9 });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "completed", completedSteps: 3, outcome: "NOT_REPRODUCED" });
    expect(board.steps[0]).toEqual(yieldedHistory);
    expect(board.evidence[0]).toEqual(checkpointEvidence);
    expect(board.steps[1]).toMatchObject({ status: "no_progress", priority: 80, attempts: 1 });
    expect(test.requests.filter(request => request.mode === "execute").map(request => request.step!.description)).toEqual([
      "Initial fixture extraction", "Follow up from the committed partial fixture", "Remaining independent fixture check",
    ]);
    expect(test.requests.map(request => request.mode)).toEqual(["decide", "execute", "decide", "execute", "decide", "execute", "decide", "metacog"]);
    expect(board.usage).toEqual({ input: 80, output: 40, cost: 0.008 });
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    const replanning = test.store.events().filter(event => event.kind === "decision").map(event => JSON.parse(event.payload))
      .find(event => event.decision.summary === plan().summary && event.decision.updateSteps?.length);
    expect(replanning.decision.updateSteps).toEqual([
      { id: board.steps[1]!.id, action: "prioritize", priority: 80, reason: "Keep the independent check" },
    ]);
  });

  it.each([true, false])("publishes a checkpoint once on retry and avoids repeating its body at settlement (yield: %s)", yielded => {
    const summary = "One saved synthetic observation; this must appear in the public feed only once.";
    const test = setup(async request => {
      if (request.mode === "execute") {
        const output: Execution = { ...fixtureExecution(request), summary };
        await request.onCheckpoint!("same-checkpoint", output, standardUsage);
        await request.onCheckpoint!("same-checkpoint", output, standardUsage);
        return { ...result({ summary: yielded ? `${summary} Partial checkpoint handed to Decide; Step success remains unverified.` : summary, result: yielded ? "blocked" : "done" }), yielded };
      }
      return request.snapshot.completedSteps ? result({ summary: "Fixture ends without a new plan" }) : result(plan());
    });
    return test.controller.start().then(() => {
      const results = test.events.flatMap(event => event.result ? [event.result] : []);
      expect(results.filter(item => item.summary.includes(summary))).toHaveLength(1);
      expect(results.filter(item => item.kind === "checkpoint")).toHaveLength(1);
      expect(results.find(item => item.kind === "transition")?.summary).toContain(yielded ? "尚未验证完成" : "阶段结果见上方");
      expect(test.store.snapshot().steps[0]!.result).toContain(summary);
      expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
      expect(test.store.snapshot().facts).toHaveLength(1);
    });
  });

  it("processes ready updates in order and ignores duplicate updates after a same-batch abandon", async () => {
    const test = setup(request => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.snapshot.completedSteps) return result(closure(request));
      const [discard, keep] = request.snapshot.steps;
      return result({ summary: "Retire one pending fixture and keep the other", updateSteps: [
        { id: discard!.id, action: "prioritize", priority: 85, reason: "Initial ordering" },
        { id: discard!.id, action: "abandon", reason: "Retire pending fixture" },
        { id: discard!.id, action: "abandon", reason: "Duplicate cleanup must not replace the reason" },
        { id: discard!.id, action: "prioritize", priority: 99, reason: "Stale ordering must not revive the plan" },
        { id: keep!.id, action: "prioritize", priority: 75, reason: "Keep useful pending work" },
      ] });
    });
    test.store.setStatus("running", "Seed pending fixtures");
    test.store.beginRun("seed-plan", "decide");
    test.store.applyDecision("seed-plan", { ...plan(), steps: [
      ...plan("Discard pending fixture").steps!, ...plan("Keep pending fixture").steps!,
    ] }, standardUsage);
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", completedSteps: 1 });
    expect(test.controller.snapshot().steps[0]).toMatchObject({ status: "abandoned", priority: 85, attempts: 0, result: "Retire pending fixture" });
    expect(test.controller.snapshot().steps[1]).toMatchObject({ status: "done", priority: 75, attempts: 1 });
    expect(test.requests[0]!.snapshot.steps.every(step => step.status === "ready" && step.priority === 50)).toBe(true);
    expect(test.events.filter(event => event.type === "notice" && event.message?.includes("history retained"))).toHaveLength(2);
    expect(test.requests.filter(request => request.mode === "execute").map(request => request.step!.description)).toEqual(["Keep pending fixture"]);
  });

  it("still rejects unknown Step updates and rolls back otherwise valid parts of the decision", async () => {
    const test = setup(request => result({ ...plan("Must not be committed"), goals: [
      { id: "G-new", parentId: "G0", description: "Must also roll back" },
    ], updateSteps: [
      { id: request.snapshot.steps[0]!.id, action: "abandon", reason: "Ignore this historical cleanup" },
      { id: "S-unknown", action: "abandon", reason: "Unknown references are still invalid" },
    ] }));
    const history = seedHistoryStep(test.store, "done");
    const before = test.store.snapshot();
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "error", outcome: null, steps: [history], goals: before.goals });
    expect(test.controller.snapshot().reason).toMatch(/Unknown Step reference: S-unknown/);
    expect(test.store.events().filter(event => event.kind === "decision")).toHaveLength(1);
    expect(test.requests).toHaveLength(1);
    expect(test.store.runs().at(-1)?.status).toBe("failed");
    expect(test.events.some(event => event.type === "result")).toBe(false);
  });

  it.each(["decide", "execute", "metacog"] as const)("does not emit a result for an invalid %s proposal", async invalidMode => {
    const test = setup(request => {
      if (request.mode !== invalidMode) return result(invalidMode === "metacog" ? { summary: "No plan yet; request review" } : plan());
      return request.mode === "execute"
        ? result({ summary: "INVALID EXECUTION MUST NOT BE SHOWN", result: "done", facts: [{ ref: "missing-proof", description: "Unsupported", evidenceRefs: ["nonexistent-evidence"] }] })
        : result({ summary: "INVALID DECISION MUST NOT BE SHOWN", steps: [{ ...plan().steps![0]!, from: ["nonexistent-fact"] }] });
    });
    await test.controller.start();
    expect(test.controller.snapshot().status).toBe("error");
    expect(test.store.runs().at(-1)?.status).toBe("failed");
    const summaries = test.events.flatMap(event => event.type === "result" && event.result ? [event.result] : []);
    expect(summaries.map(item => item.mode)).toEqual(invalidMode === "decide" ? [] : ["decide"]);
    expect(JSON.stringify(summaries)).not.toContain("INVALID");
  });

  it.each(["decide", "execute", "metacog"] as const)("does not emit a late %s result after cancellation", async cancelledMode => {
    let release!: () => void;
    const test = setup(request => {
      if (request.mode !== cancelledMode) return result(cancelledMode === "metacog" ? { summary: "No plan yet; request review" } : plan());
      return new Promise(resolve => {
        release = () => resolve(result(request.mode === "execute" ? fixtureExecution(request) : { summary: "Cancelled proposal must not be shown" }));
      });
    });
    const active = test.controller.start();
    await vi.waitFor(() => expect(release).toBeDefined());
    test.controller.pause(); release(); await active;
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0, facts: [], evidence: [] });
    expect(test.store.runs().at(-1)?.status).toBe("cancelled");
    const summaries = test.events.flatMap(event => event.type === "result" && event.result ? [event.result] : []);
    expect(summaries.map(item => item.mode)).toEqual(cancelledMode === "decide" ? [] : ["decide"]);
    expect(JSON.stringify(summaries)).not.toContain("Cancelled proposal");
  });

  it("hands off exactly two logical roles with public context and persists each outer trigger", async () => {
    const test = setup(request => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      return result(request.snapshot.completedSteps ? closure(request) : plan());
    });
    await test.controller.start();
    const handoffs = test.events.flatMap(event => event.handoff ? [event.handoff] : []);
    expect(handoffs.map(event => event.role)).toEqual(["decide", "execute", "decide", "decide"]);
    expect(handoffs.map(event => event.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(handoffs.map(event => event.trigger.kind)).toEqual(["start", "planned", "execution_result", "completion"]);
    expect(test.requests.map(request => request.trigger)).toEqual(handoffs.map(event => event.trigger));
    expect(test.requests.every(request => request.context && !JSON.stringify(request.context).includes('"models"'))).toBe(true);
    expect(test.requests[1]!.context!.steps.map(step => step.id)).toContain(handoffs[1]!.stepId);
    expect(test.store.events().filter(event => event.kind === "run_started").map(event => JSON.parse(event.payload).trigger)).toEqual(handoffs.map(event => event.trigger));
    expect(test.controller.snapshot().status).toBe("completed");
  });

  it("reviews a technical hit before further execution without assigning its impact or rating", async () => {
    const test = setup(request => {
      if (request.mode === "execute") {
        const output = fixtureExecution(request);
        output.findings![0]!.status = "technical_hit";
        return result(output);
      }
      if (!request.snapshot.completedSteps) return result(plan());
      expect(request.mode).toBe("metacog");
      expect(request.trigger?.kind).toBe("technical_hit");
      expect(request.snapshot.findings[0]!).toMatchObject({ status: "technical_hit", rating: "unrated" });
      // A synthetic fixture can be closed, but never becomes a real vulnerability.
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.map(request => request.mode)).toEqual(["decide", "execute", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED" });
  });

  it("supports code-level policy/context replacement without changing the Pi runner contract", async () => {
    const projector = vi.fn(projectContext);
    const selectStep = vi.fn(defaultLoopPolicy.selectStep);
    const reviewAfterExecution = vi.fn(defaultLoopPolicy.reviewAfterExecution);
    const test = setup(request => request.mode === "execute" ? result(fixtureExecution(request))
      : result(request.snapshot.completedSteps ? closure(request) : plan()), {}, { projectContext: projector, policy: { selectStep, reviewAfterExecution } });
    await test.controller.start();
    expect(projector).toHaveBeenCalledTimes(4);
    expect(selectStep).toHaveBeenCalledOnce();
    expect(reviewAfterExecution).toHaveBeenCalledOnce();
    expect(test.controller.snapshot().status).toBe("completed");
  });

  it("does not enter Pi if a handoff subscriber cancels the run", async () => {
    const test = setup(() => result(plan()));
    test.controller.subscribe(event => { if (event.type === "handoff") test.controller.pause(); });
    await test.controller.start();
    expect(test.run).not.toHaveBeenCalled();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null });
    expect(test.store.runs()[0]?.status).toBe("cancelled");
    expect(test.events.some(event => event.type === "result")).toBe(false);
  });

  it("cleans up an active claim when context assembly fails instead of leaving a phantom run", async () => {
    const test = setup(() => result(plan()), {}, { projectContext: () => { throw new Error("Context projection failed"); } });
    await test.controller.start();
    expect(test.run).not.toHaveBeenCalled();
    expect(test.controller.snapshot()).toMatchObject({ status: "error", outcome: null });
    expect(test.store.runs()[0]?.status).toBe("failed");
  });

  it("commits FGS/evidence and requires a fresh metacognitive run before a terminal state", async () => {
    const test = setup((request) => {
      request.onEvent({ type: "text", mode: request.mode, text: `PRIVATE-STREAM-${request.mode}` });
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.mode === "decide") return result({ summary: "Propose synthetic completion", conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic completion proposal" } });
      expect(request.snapshot.findings[0]!.status).toBe("lead");
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1, noProgressCount: 0, usage: { input: 40, output: 20, cost: 0.004 } });
    expect(board.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(board.lastMetaStep).toBe(1);
    expect(readFileSync(path.resolve(taskDirectory(test.root), board.evidence[0]!.path), "utf8")).toContain("SYNTHETIC TEST FIXTURE ONLY");
    expect(new Set(test.requests.map((r) => r.id)).size).toBe(4);
    expect(new Set(test.requests.map((r) => r.snapshot)).size).toBe(4);
    for (const request of test.requests) {
      expect(request).not.toHaveProperty("messages");
      expect(request).not.toHaveProperty("history");
      expect(JSON.stringify(request.snapshot)).not.toContain("PRIVATE-STREAM");
    }
    expect(test.requests[1]!.step?.status).toBe("claimed");
    expect(test.requests[2]!.snapshot.facts).toHaveLength(1);
    expect(test.events.some((e) => e.type === "runtime")).toBe(true);
    await test.controller.start();
    test.controller.stop();
    expect(test.run).toHaveBeenCalledTimes(4);
    expect(test.controller.snapshot().status).toBe("completed");
  });

  it("ignores a legacy 24-Step cap and continues until the model reviews the final goal at Step 27", async () => {
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.mode === "metacog" && request.snapshot.completedSteps === 27) return result(closure(request));
      return result(plan(`Synthetic goal check ${request.snapshot.completedSteps + 1}`));
    }, { maxSteps: 24 });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 27 });
    expect(test.controller.snapshot().config.limits).not.toHaveProperty("maxSteps");
    expect(test.requests.filter((r) => r.mode === "execute")).toHaveLength(27);
    expect(test.requests.find((request) => request.mode === "execute" && request.snapshot.completedSteps === 24)?.snapshot.goals[0]?.status).toBe("active");
    expect(test.requests.at(-1)?.mode).toBe("metacog");
    expect(test.controller.snapshot().goals[0]).toMatchObject({ id: "G0", status: "satisfied" });
  // 27 complete execution cycles now also flush each Wiki generation. This is
  // a lifecycle assertion; retrieval latency is measured by its own benchmark.
  }, 30000);

  it("runs metacognition after repeated no-progress outputs then pauses without NEED_INPUT", async () => {
    const test = setup((request) => {
      if (request.mode === "decide") return result(plan(`Synthetic attempt ${request.snapshot.completedSteps + 1}`));
      if (request.mode === "execute") return result({ summary: "No synthetic state change", result: "done" });
      return result({ summary: "No new evidence; record stagnation and inspect plan" });
    }, { maxNoProgress: 2, metacogEvery: 9 });
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "execute", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, noProgressCount: 2, completedSteps: 2, lastMetaStep: 2 });
    expect(test.controller.snapshot().steps.every((step) => step.status === "no_progress")).toBe(true);
    expect(test.controller.snapshot().reason).toContain("no executable step");
  });

  it("uses stagnation to replan through metacognition and continues when the new plan is executable", async () => {
    const test = setup((request) => {
      if (request.mode === "execute") return result(request.snapshot.completedSteps < 2
        ? { summary: "No synthetic state change", result: "no_progress" }
        : fixtureExecution(request));
      if (request.snapshot.completedSteps >= 3) return result(closure(request));
      if (request.mode === "metacog") {
        expect(request.snapshot.noProgressCount).toBe(2);
        return result(plan("Change the synthetic identity and entry point after stagnation"));
      }
      return result(plan(`Synthetic initial attempt ${request.snapshot.completedSteps + 1}`));
    }, { maxNoProgress: 2, metacogEvery: 9 });
    await test.controller.start();
    expect(test.requests.map((request) => request.mode)).toEqual(["decide", "execute", "decide", "execute", "metacog", "execute", "decide", "metacog"]);
    expect(test.requests[5]?.step?.description).toContain("Change the synthetic identity");
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 3, noProgressCount: 0 });
    expect(test.events.filter((event) => event.snapshot?.status === "paused")).toHaveLength(0);
  });

  it("lets fresh metacognition reject an early goal-completion proposal and execute its replacement plan", async () => {
    let reviews = 0;
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.mode === "decide") return result({
        summary: "Premature synthetic completion proposal",
        updateGoals: closure(request).updateGoals,
        conclusion: closure(request).conclusion,
      });
      expect(request.snapshot.goals[0]?.status).toBe("active");
      if (++reviews === 1) return result(plan("Check a missing synthetic entry point before completing the goal"));
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.map((request) => request.mode)).toEqual(["decide", "execute", "decide", "metacog", "execute", "decide", "metacog"]);
    expect(reviews).toBe(2);
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", completedSteps: 2 });
    expect(test.controller.snapshot().goals[0]?.status).toBe("satisfied");
  });

  it("cannot turn a closed individual finding into completion while the root goal remains active", async () => {
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      const decision = closure(request);
      delete decision.updateGoals;
      return result(decision);
    }, { metacogEvery: 1 });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "error", outcome: null, completedSteps: 1 });
    expect(test.controller.snapshot().goals[0]?.status).toBe("active");
    expect(test.controller.snapshot().findings[0]?.status).toBe("lead");
    expect(test.controller.snapshot().reason).toMatch(/root goal.*G0.*satisfied/i);
  });

  it("defers a root-only completion update from ordinary Decide to a fresh metacognitive review", async () => {
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.mode === "decide") return result({ summary: "Premature root-only proposal", updateGoals: closure(request).updateGoals });
      expect(request.snapshot.goals[0]?.status).toBe("active");
      expect(request.snapshot.outcome).toBeNull();
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.map((request) => request.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED" });
  });

  it("reviews an empty plan once then pauses without inventing missing inputs", async () => {
    const test = setup(() => result({ summary: "No executable proposal" }));
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0, findings: [] });
    expect(test.controller.snapshot().reason).toContain("no executable step");
  });

  it("passes read-only planning memory into fresh contexts after automatic pause and restart", async () => {
    let resumed = false;
    const summary = "Compared fixture JSON and searched its originals; no matches under the recorded conditions. Verification remains open.";
    const test = setup(request => {
      if (resumed) {
        expect(request.snapshot.reason).not.toBe(summary);
        expect(projectContext(request).planningMemory).toMatchObject({ summary, evidenceStatus: "unverified" });
      }
      return result({ summary });
    });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", facts: [], steps: [], planningMemory: { summary } });
    resumed = true;
    await test.controller.start();
    expect(test.requests.length).toBe(4);
    expect(test.controller.snapshot().outcome).toBeNull();
  });

  it.each([false, true])("reviews superseded pending plans without executing or cycling (unsupported NEED_INPUT: %s)", async unsupportedNeedInput => {
    const test = setup(request => {
      if (request.mode === "execute") {
        const output = fixtureExecution(request);
        if (request.snapshot.completedSteps === 1) {
          output.facts![0]!.description = "Corrected synthetic observation under changed fixture conditions";
          output.facts![0]!.supersedes = request.snapshot.facts[0]!.id;
          output.findings = [];
        }
        if (unsupportedNeedInput) output.findings = [];
        return result(output);
      }
      if (request.snapshot.completedSteps === 0) return result(plan("Record initial synthetic condition"));
      if (request.snapshot.completedSteps === 1) return result({ summary: "Schedule correction before the dependent action", steps: [
        { ...plan().steps![0]!, description: "Retest initial condition", priority: 100, from: [request.snapshot.facts[0]!.id] },
        { ...plan().steps![0]!, description: "OLD DEPENDENT PLAN MUST NOT EXECUTE", priority: 90, from: [request.snapshot.facts[0]!.id] },
      ] });
      expect(request.context!.projection.stepReviews).toHaveLength(1);
      return result({ summary: "Review did not resolve the outdated dependency", ...(unsupportedNeedInput
        ? { conclusion: { outcome: "NEED_INPUT", reason: "The stale plan has no output yet." } } : {}) });
    });
    await test.controller.start();
    expect(test.requests.map(request => request.mode)).toEqual(["decide", "execute", "decide", "execute", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 2 });
    expect(test.controller.snapshot().reason).toContain("superseded dependencies");
    expect(test.controller.snapshot().steps.at(-1)).toMatchObject({ status: "ready", attempts: 0 });
    await test.controller.start();
    expect(test.requests.slice(-2).map(request => request.mode)).toEqual(["decide", "metacog"]);
    expect(test.requests.at(-1)?.trigger?.kind).toBe("fact_revision");
    expect(test.requests.filter(request => request.mode === "execute")).toHaveLength(2);
    expect(test.controller.snapshot().status).toBe("paused");
  });

  it("continues after metacognition replaces an outdated plan with current evidence", async () => {
    const test = setup(request => {
      if (request.mode === "execute") {
        const output = fixtureExecution(request);
        if (request.snapshot.completedSteps === 1) {
          output.facts![0]!.description = "Corrected synthetic condition";
          output.facts![0]!.supersedes = request.snapshot.facts[0]!.id;
          output.findings = [];
        }
        return result(output);
      }
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.snapshot.completedSteps === 1) return result({ summary: "Set up a correction and dependent plan", steps: [
        { ...plan().steps![0]!, priority: 100, from: [request.snapshot.facts[0]!.id] },
        { ...plan().steps![0]!, description: "Outdated dependent action", priority: 90, from: [request.snapshot.facts[0]!.id] },
      ] });
      if (request.snapshot.completedSteps === 2) {
        expect(request.mode).toBe("metacog");
        const review = request.context!.projection.stepReviews[0]!;
        return result({ summary: "Use the corrected fact after checking scope and state", updateSteps: [
          { id: review.stepId, action: "abandon", reason: "Original prerequisite was superseded" },
        ], steps: [{ ...plan("Current condition plan").steps![0]!, from: [request.snapshot.facts.at(-1)!.id] }] });
      }
      return result(closure(request));
    });
    await test.controller.start();
    expect(test.requests.filter(request => request.mode === "execute").map(request => request.step!.description)).toEqual([
      plan().steps![0]!.description, plan().steps![0]!.description, "Current condition plan",
    ]);
    expect(test.controller.snapshot()).toMatchObject({ status: "completed", completedSteps: 3 });
    expect(test.controller.snapshot().steps[2]).toMatchObject({ status: "abandoned", attempts: 0 });
    expect(test.events.some(event => event.snapshot?.status === "paused")).toBe(false);
  });

  it("guards against a custom scheduling policy returning a stale plan before claiming or calling Execute", async () => {
    const test = setup(request => {
      if (request.mode === "execute") {
        const output = fixtureExecution(request);
        if (request.snapshot.completedSteps === 1) {
          output.facts![0]!.description = "Corrected synthetic condition";
          output.facts![0]!.supersedes = request.snapshot.facts[0]!.id;
          output.findings = [];
        }
        return result(output);
      }
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.snapshot.completedSteps === 1) return result({ summary: "Prioritize correction before old dependent plan", steps: [
        { ...plan().steps![0]!, priority: 100, from: [request.snapshot.facts[0]!.id] },
        { ...plan().steps![0]!, description: "Stale high priority action", priority: 90, from: [request.snapshot.facts[0]!.id] },
      ] });
      return result({ summary: "Create a valid lower priority alternative", steps: [
        { ...plan().steps![0]!, from: [request.snapshot.facts.at(-1)!.id], priority: 10 },
      ] });
    }, {}, { policy: { ...defaultLoopPolicy, selectStep: board => board.steps.filter(step => step.status === "ready").sort((a, b) => b.priority - a.priority)[0] } });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", completedSteps: 2, outcome: null });
    expect(test.controller.snapshot().reason).toContain("Scheduling policy selected Step");
    expect(test.requests.filter(request => request.mode === "execute")).toHaveLength(2);
    expect(test.controller.snapshot().steps.filter(step => step.status === "ready").map(step => step.attempts)).toEqual([0, 0]);
    expect(test.store.runs().some(run => run.status === "running")).toBe(false);
  });

  it("uses the Decide metacog mode at the configured periodic boundary", async () => {
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.mode === "metacog") return result(closure(request));
      return result(plan());
    }, { metacogEvery: 1 });
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "metacog"]);
    expect(test.controller.snapshot().status).toBe("completed");
  });
});

describe("LoopController interruption and fresh boundaries", () => {
  it("returns the same active promise during synchronous state-listener reentry", async () => {
    const test = setup(() => result({ summary: "Empty synthetic review" }));
    let reentered = false;
    let nested: Promise<void> | undefined;
    test.controller.subscribe((event) => {
      if (event.type === "state" && event.snapshot?.status === "running" && !reentered) {
        reentered = true;
        nested = test.controller.start();
      }
    });
    const active = test.controller.start();
    expect(nested).toBe(active);
    expect(test.controller.waitForIdle()).toBe(active);
    await active;
    expect(test.requests.map((request) => request.mode)).toEqual(["decide", "metacog"]);
    expect(test.controller.snapshot().status).toBe("paused");
    expect(test.store.events().filter((event) => event.kind === "status" && JSON.parse(event.payload).status === "running")).toHaveLength(1);
  });

  it("aborts a user-paused Execute, accounts partial usage and never blindly replays it", async () => {
    let markExecuting!: () => void;
    const executing = new Promise<void>((resolve) => { markExecuting = resolve; });
    const test = setup((request) => {
      if (request.mode === "execute") { markExecuting(); return abortable(request); }
      return result(request.snapshot.steps.length ? { summary: "Review failed step before creating another action" } : plan());
    });
    const active = test.controller.start();
    expect(test.controller.start()).toBe(active);
    await executing;
    test.controller.pause();
    await active;
    expect(test.requests[1]!.signal.aborted).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, usage: { input: 17, output: 7, cost: 0.0014 } });
    expect(test.controller.snapshot().steps[0]).toMatchObject({ status: "failed", attempts: 1, leaseUntil: null });
    expect(test.store.runs().at(-1)?.status).toBe("cancelled");
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(test.controller.snapshot().steps[0]!.attempts).toBe(1);
  });

  it("pauses on a run timeout and preserves the provider's partial usage", async () => {
    const test = setup((request) => request.mode === "execute" ? abortable(request, { input: 23, output: 4, cost: 0.002 }) : result(plan()), { stepTimeoutSeconds: 0.03 });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, usage: { input: 33, output: 9, cost: 0.003 } });
    expect(test.controller.snapshot().reason).toContain("time limit");
    expect(test.controller.snapshot().steps[0]!.status).toBe("failed");
    expect(test.store.runs().at(-1)?.status).toBe("cancelled");
  });

  it("keeps an unlimited run active beyond the former timeout without installing a timer, until the user pauses", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    let markExecuting!: () => void;
    const executing = new Promise<void>(resolve => { markExecuting = resolve; });
    const test = setup(request => {
      if (request.mode === "execute") { markExecuting(); return abortable(request); }
      return result(plan());
    }, { stepTimeoutSeconds: null, maxMinutes: null });
    const active = test.controller.start();
    try {
      await executing;
      expect(timer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(test.controller.snapshot()).toMatchObject({ status: "running", outcome: null });
      expect(test.requests[1]!.signal.aborted).toBe(false);
      expect(test.controller.snapshot().steps[0]).toMatchObject({ status: "claimed", leaseUntil: null });
      test.controller.pause();
      await active;
      expect(test.controller.snapshot()).toMatchObject({ status: "paused", usage: { input: 17, output: 7, cost: 0.0014 } });
      expect(test.requests[1]!.signal.aborted).toBe(true);
    } finally {
      test.controller.stop();
      await active;
      timer.mockRestore();
      vi.useRealTimers();
    }
  });

  it("defers a conclusion when hints arrive during Decide and gives the next review a fresh snapshot", async () => {
    let controller!: LoopController;
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (!request.snapshot.completedSteps) return result(plan());
      if (request.mode === "decide") {
        controller.hint("New synthetic fixture expectation arrived during Decide");
        expect(request.snapshot.hints).toHaveLength(0);
        return result(closure(request));
      }
      expect(request.snapshot.hints[0]!.content).toContain("New synthetic");
      expect(request.snapshot.goals[0]?.status).toBe("active");
      expect(request.snapshot.outcome).toBeNull();
      return result(closure(request));
    });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(test.events.some((event) => event.message?.includes("New hint arrived"))).toBe(true);
    expect(controller.snapshot().status).toBe("completed");
  });

  it("repeats fresh metacognition when a hint invalidates an in-flight completion review", async () => {
    let controller!: LoopController;
    let reviews = 0;
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.mode === "decide") return result(plan());
      if (++reviews === 1) controller.hint("Fixture changed while metacognition was in flight");
      else {
        expect(request.snapshot.hints).toHaveLength(1);
        expect(request.snapshot.goals[0]?.status).toBe("active");
        expect(request.snapshot.outcome).toBeNull();
      }
      return result(closure(request));
    }, { metacogEvery: 1 });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "metacog", "metacog"]);
    const reviewsWithResults = test.events.flatMap(event => event.type === "result" && event.result?.mode === "metacog" ? [event.result] : []);
    expect(reviewsWithResults[0]).toEqual({ mode: "metacog", summary: "Synthetic terminal-state validation, not a real vulnerability conclusion" });
    expect(reviewsWithResults[1]).toEqual({ mode: "metacog", summary: "Synthetic protocol test completed; no live target was tested", outcome: "NOT_REPRODUCED" });
    expect(controller.snapshot().status).toBe("completed");
  });

  it("starts an idle manual meta request on the Decide review channel", async () => {
    const test = setup(() => result({ summary: "Manual review, no actionable proposal" }));
    test.controller.requestMetacog();
    await test.controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null });
  });

  it("queues a manual meta request until the current run's committed boundary", async () => {
    let controller!: LoopController;
    const test = setup((request) => {
      if (request.mode === "decide") { controller.requestMetacog(); return result(plan()); }
      if (request.mode === "execute") return result({ summary: "No fixture change", result: "no_progress" });
      return result({ summary: "Manual/threshold review" });
    }, { maxNoProgress: 1 });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "metacog", "execute", "metacog"]);
    expect(new Set(test.requests.map((r) => r.snapshot.revision)).size).toBe(4);
  });

  it("honors a queued manual review and continues the pending plan without a Step cap", async () => {
    let controller!: LoopController;
    const test = setup((request) => {
      if (request.mode === "execute") return result(fixtureExecution(request));
      if (request.snapshot.completedSteps === 2) return result(closure(request));
      if (request.mode === "metacog") return result({ summary: "Manual review accepts the pending synthetic plan" });
      if (request.snapshot.completedSteps) controller.requestMetacog();
      return result(plan(`Synthetic attempt ${request.snapshot.completedSteps + 1}`));
    }, { maxNoProgress: 5, metacogEvery: 9 });
    controller = test.controller;
    await controller.start();
    expect(test.requests.map((r) => r.mode)).toEqual(["decide", "execute", "decide", "metacog", "execute", "decide", "metacog"]);
    expect(controller.snapshot()).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 2 });
  });
});

describe("LoopController budgets and errors", () => {
  it("leaves optional budgets disabled by default and can complete beyond the former time, token and cost defaults", async () => {
    let time = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => time);
    try {
      const test = setup((request) => {
        time += 31 * 60_000;
        const usage = { input: 300_000, output: 20_000, cost: 6 };
        if (request.mode === "execute") return result(fixtureExecution(request), usage);
        return result(request.snapshot.completedSteps ? closure(request) : plan(), usage);
      });
      expect(test.controller.snapshot().config.limits).toMatchObject({ maxMinutes: null, maxTokens: null, maxCost: null, stepTimeoutSeconds: null });
      await test.controller.start();
      const board = test.controller.snapshot();
      expect(test.requests.map((request) => request.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
      expect(board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1, usage: { input: 1_200_000, output: 80_000, cost: 24 } });
      expect(board.elapsedMs).toBeGreaterThan(30 * 60_000);
    } finally {
      now.mockRestore();
    }
  });

  it.each(["decide", "execute"] as const)("cleans up malformed usage from %s without committing proposals and can resume in-process", async (invalidMode) => {
    let invalidSent = false;
    const invalidUsage = { input: 4, output: 1, cost: "unknown" } as unknown as Usage;
    const test = setup((request) => {
      if (invalidSent) return result({ summary: "Fresh review after the malformed provider result" });
      if (request.mode !== invalidMode) return result(plan());
      invalidSent = true;
      return result(request.mode === "execute" ? fixtureExecution(request) : plan("This proposal must not commit"), invalidUsage);
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "error", outcome: null, completedSteps: 0, facts: [], findings: [], evidence: [] });
    expect(board.usage).toEqual(invalidMode === "decide" ? { input: 0, output: 0, cost: 0 } : standardUsage);
    if (invalidMode === "decide") expect(board.steps).toEqual([]);
    else expect(board.steps[0]).toMatchObject({ status: "failed", attempts: 1, leaseUntil: null });
    expect(test.store.runs().at(-1)?.status).toBe("failed");
    expect(test.store.runs().some((run) => run.status === "running")).toBe(false);
    expect(test.events.some(event => event.type === "result" && event.result?.mode === invalidMode)).toBe(false);
    expect(test.events.some((event) => event.type === "notice" && /usage/i.test(event.message ?? ""))).toBe(true);
    const beforeResume = test.requests.length;
    await test.controller.start();
    expect(test.requests.slice(beforeResume).map((request) => request.mode)).toEqual(["decide", "metacog"]);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0, facts: [], findings: [], evidence: [] });
    expect(test.store.runs().some((run) => run.status === "running")).toBe(false);
  });

  it.each([
    [{ maxTokens: 15 }, "Token budget"],
    [{ maxCost: 0.001 }, "cost budget"],
  ] as const)("halts before another call when accumulated budget is exhausted (%j)", async (limits, reason) => {
    const test = setup(() => result(plan()), limits);
    await test.controller.start();
    expect(test.run).toHaveBeenCalledOnce();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0 });
    expect(test.controller.snapshot().reason).toContain(reason);
    expect(test.controller.snapshot().goals[0]?.status).toBe("active");
    expect(test.controller.snapshot().steps[0]!.attempts).toBe(0);
  });

  it.each([null, 100])("enforces the remaining wall-time budget during an in-flight call with run timeout %s", async stepTimeoutSeconds => {
    const test = setup((request) => abortable(request), { maxMinutes: 0.0005, stepTimeoutSeconds });
    await test.controller.start();
    expect(test.run).toHaveBeenCalledOnce();
    expect(test.requests[0]!.signal.aborted).toBe(true);
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, usage: { input: 7, output: 2, cost: 0.0004 } });
    expect(test.controller.snapshot().goals[0]?.status).toBe("active");
    expect(test.controller.snapshot().reason).toContain("Time budget exhausted");
  });

  it("records schema failures without leaking partial proposals or fabricating a result", async () => {
    const test = setup(() => result({ summary: "Invalid proposal", steps: [{ ...plan().steps![0], from: ["nonexistent-fact"] }] }));
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "error", outcome: null, steps: [], usage: standardUsage });
    expect(test.store.runs()[0]!.status).toBe("failed");
    expect(test.run).toHaveBeenCalledOnce();
  });

  it("isolates renderer exceptions and lets unsubscribed listeners stay silent", async () => {
    const test = setup(() => result({ summary: "Empty synthetic review" }));
    const listener = vi.fn();
    test.controller.subscribe(() => { throw new Error("Broken renderer"); });
    const unsubscribe = test.controller.subscribe(listener);
    unsubscribe();
    await test.controller.start();
    expect(test.controller.snapshot().status).toBe("paused");
    expect(listener).not.toHaveBeenCalled();
  });
});
