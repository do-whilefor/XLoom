import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.js";
import { LoopController } from "../src/controller.js";
import type { BlackboardContext, ContextStep } from "../src/loop/context.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import type { ModelResolver } from "../src/runtime/models.js";
import { BlackboardStore } from "../src/store.js";
import type { Decision, Execution, LoopEvent } from "../src/types.js";

// Only the provider stream is synthetic. Pi Agent, native tools, controller,
// checkpoint submission, evidence archiving and SQLite transactions are real.
const artifactBody = "SYNTHETIC LOCAL CHECKPOINT FIXTURE\naccount=alice; state=v1; control=allowed; changed-object=denied\n";
const privateNarration = "PRIVATE_EXECUTE_TOOL_HISTORY_DO_NOT_SHARE";
const model: Model<"openai-completions"> = {
  id: "offline", name: "offline", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 2_000,
};
interface PromptData { blackboard: BlackboardContext; assignedStep?: ContextStep; workspace: string; artifacts: string; checkpointFile?: string }
interface SeenRun { channel: string; contexts: Context[] }
const opened: { root: string; store: BlackboardStore; controller: LoopController }[] = [];

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.controller.waitForIdle();
    entry.store.close();
    const target = resolve(entry.root);
    if (!target.startsWith(resolve(tmpdir())) || !target.includes("xloom-runtime-stage-")) throw new Error("Unexpected checkpoint fixture cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 0,
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(stopReason === "error" ? { errorMessage: "Synthetic non-transient fixture failure after checkpoint" } : {}),
  };
}
const json = (output: Decision | Execution): AssistantMessage => message([{ type: "text", text: JSON.stringify(output) }]);
const write = (id: string, path: string, content: string): AssistantMessage => message([{ type: "toolCall", id, name: "write", arguments: { path, content } }], "toolUse");

function promptData(context: Context): PromptData {
  const user = context.messages[0];
  if (user?.role !== "user") throw new Error("Each role must start with its own user prompt");
  const text = typeof user.content === "string" ? user.content : user.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  return JSON.parse(text.split("\n").at(-1)!) as PromptData;
}

function setup(respond: (run: SeenRun, context: Context, input: PromptData) => AssistantMessage, secrets: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "xloom-runtime-stage-"));
  const config = defaultConfig("Validate synthetic local checkpoint preservation and handoff; no network target");
  config.models = { decide: { provider: "test", model: "offline-decide" }, execute: { provider: "test", model: "offline-execute" } };
  config.limits.metacogEvery = 10;
  const store = new BlackboardStore(root, config);
  const seen: SeenRun[] = [];
  const resolveModel: ModelResolver = async config => {
    const run = { channel: config.model, contexts: [] as Context[] };
    seen.push(run);
    if (seen.length > 10) throw new Error("Stage integration exceeded expected run count");
    return { model: { ...model, id: config.model }, secrets, streamFn: (_model, context) => {
      run.contexts.push(JSON.parse(JSON.stringify(context)) as Context);
      if (run.contexts.length > 10) throw new Error("Stage integration exceeded expected model turns");
      const response = respond(run, context, promptData(context));
      const events = new AssistantMessageEventStream();
      queueMicrotask(() => {
        events.push({ type: "start", partial: response });
        if (response.stopReason === "error" || response.stopReason === "aborted") events.push({ type: "error", reason: response.stopReason, error: response });
        else events.push({ type: "done", reason: response.stopReason, message: response });
        events.end();
      });
      return events;
    } };
  };
  const controller = new LoopController(store, new PiRunner({ resolveModel }));
  const events: LoopEvent[] = [];
  controller.subscribe(event => events.push(event));
  opened.push({ root, store, controller });
  return { root, store, controller, seen, events };
}

function planning(input: PromptData): AssistantMessage {
  if (input.blackboard.steps.length) return json({ summary: "Inspect committed synthetic observations before planning further work" });
  return json({ summary: "Assign one synthetic file comparison", steps: [{ goalId: "G0", from: [], description: "Write fixture and submit a partial observation",
    successSignal: "Finish all requested synthetic comparisons", evidencePlan: "Preserve the generated fixture", priority: 50 }] });
}

function checkpoint(input: PromptData, id = "batch-1", yieldToDecide = false): string {
  return JSON.stringify({ id, yieldToDecide, execution: {
    summary: "Partial fixture comparison committed; remaining conditions are still unverified", result: "done",
    evidence: [{ ref: "fixture-e", path: join(input.artifacts, "fixture.txt"), description: "Synthetic checkpoint unit-test artifact" }],
    facts: [{ ref: "fixture-f", description: "Synthetic changed object was denied for alice in state v1", evidenceRefs: ["fixture-e"] }],
  } });
}

function toolText(context: Context): string {
  const last = context.messages.at(-1);
  if (last?.role !== "toolResult") throw new Error("Expected the completed native tool result");
  return last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

function assertExactUsage(test: ReturnType<typeof setup>): void {
  const calls = test.seen.reduce((sum, run) => sum + run.contexts.length, 0);
  expect(test.controller.snapshot().usage).toEqual({ input: calls * 15, output: calls * 5, cost: 0 });
}

const fixtureGoals: NonNullable<Decision["goals"]> = [
  { id: "G2", parentId: "G0", description: "Compare independent synthetic fixture conditions" },
  { id: "G3", parentId: "G2", description: "Compare the first synthetic fixture label" },
  { id: "G4", parentId: "G2", description: "Compare the second synthetic fixture label" },
];

function seedFixtureGoals(test: ReturnType<typeof setup>): void {
  test.store.setStatus("running", "Seed existing fixture goals without model requests");
  test.store.beginRun("seed-goals", "decide");
  test.store.applyDecision("seed-goals", { summary: "Seed synthetic goals", goals: fixtureGoals }, { input: 0, output: 0, cost: 0 });
}

describe("durable Execute checkpoints through the real Pi tool loop", () => {
  it.each([false, true])("recovers an Anthropic stream EOF after a completed write without committing its failed JSON tail (complete JSON: %s)", async completeJson => {
    const interruptedMarker = "UNCOMMITTED_INTERRUPTED_FIXTURE_RECORD";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("artifact-once", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "artifact-once", isError: false });
        return { ...message([
          { type: "thinking", thinking: "Synthetic interrupted private reasoning fixture" },
          { type: "text", text: completeJson ? JSON.stringify({ summary: interruptedMarker, result: "no_progress" })
            : `{"summary":"${interruptedMarker}","result":"done","facts":[` },
        ], "error"), errorMessage: "Anthropic stream ended before message_stop" };
      }
      expect(run.contexts).toHaveLength(3);
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "artifact-once", isError: false });
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell"]);
      expect(JSON.stringify(context.messages)).not.toContain(interruptedMarker);
      expect(JSON.stringify(context.messages)).not.toContain("Anthropic stream ended before message_stop");
      expect(context.messages.filter(entry => entry.role === "toolResult" && entry.toolCallId === "artifact-once")).toHaveLength(1);
      return json({ summary: "Retain the completed synthetic artifact after stream recovery", result: "done",
        evidence: [{ ref: "fixture-e", path: join(input.artifacts, "fixture.txt"), description: "Synthetic artifact written before the interrupted stream" }],
        facts: [{ ref: "fixture-f", description: "Synthetic fixture records allowed control and denied changed-object labels", evidenceRefs: ["fixture-e"] }],
      });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.steps[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(readFileSync(join(test.root, board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    expect(JSON.stringify(board)).not.toContain(interruptedMarker);
    expect(test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : [])).toEqual(["artifact-once"]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("Transient model failure"))).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(0);
    expect(test.store.events().filter(event => event.kind === "execution")).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("continues metacog after a thinking-only length stop using its completed read, then executes the new plan", async () => {
    let factId = "";
    let recoveredPlans = 0;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1 && context.systemPrompt?.includes("Fresh metacognitive review")) {
          factId = input.blackboard.facts[0]!.id;
          if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-before-length", name: "read",
            arguments: { path: join(input.workspace, input.blackboard.evidence[0]!.path) } }], "toolUse");
          if (run.contexts.length === 2) {
            expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "read-before-length", isError: false });
            return message([{ type: "thinking", thinking: "Synthetic interrupted reasoning fixture; final plan not yet emitted" }], "length");
          }
          expect(run.contexts).toHaveLength(3);
          expect(context.tools?.map(tool => tool.name)).toEqual(["read"]);
          expect(context.messages.at(-1)?.role).toBe("user");
          expect(context.messages.filter(entry => entry.role === "toolResult" && entry.toolCallId === "read-before-length")).toHaveLength(1);
          recoveredPlans++;
          return json({ summary: "Continue from the completed synthetic comparison", steps: [{ goalId: "G0", from: [factId],
            description: "Inspect the remaining synthetic state", successSignal: "Remaining label observed", evidencePlan: "Use the archived fixture", priority: 1 }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) {
        expect(input.assignedStep).toMatchObject({ from: [factId], description: "Inspect the remaining synthetic state" });
        return json({ summary: "Remaining synthetic condition still unverified", result: "no_progress" });
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      return write("fixture-checkpoint", input.checkpointFile!, checkpoint(input, "before-review-length", true));
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 2 });
    expect(board.steps[1]).toMatchObject({ from: [factId], attempts: 1, status: "no_progress" });
    expect(recoveredPlans).toBe(1);
    expect(test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : [])).toEqual([
      "fixture-write", "fixture-checkpoint", "read-before-length",
    ]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("length"))).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("continues Execute after a committed checkpoint and length stop without repeating tools, records or usage", async () => {
    let evidenceId = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("fixture-checkpoint", input.checkpointFile!, checkpoint(input, "before-execute-length"));
      if (run.contexts.length === 3) {
        const accepted = JSON.parse(toolText(context));
        expect(accepted).toMatchObject({ checkpoint: "before-execute-length", committed: true });
        evidenceId = accepted.evidence[0].id;
        return message([{ type: "thinking", thinking: "Synthetic interrupted reasoning fixture after accepted checkpoint" }], "length");
      }
      expect(run.contexts).toHaveLength(4);
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell"]);
      expect(context.messages.at(-1)?.role).toBe("user");
      expect(context.messages.filter(entry => entry.role === "toolResult" && entry.toolCallId === "fixture-checkpoint")).toHaveLength(1);
      return json({ summary: "Checkpoint retained; submit only the additional synthetic observation", result: "done", facts: [
        { ref: "additional-fact", description: "Synthetic fixture retains both the control and changed-object labels", evidenceRefs: [evidenceId] },
      ] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.steps[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(board.evidence).toHaveLength(1);
    expect(board.facts).toHaveLength(2);
    expect(board.facts[1]!.evidenceIds).toEqual([evidenceId]);
    expect(readFileSync(join(test.root, board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    expect(test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : [])).toEqual(["fixture-write", "fixture-checkpoint"]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("length"))).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution")).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("joins a length-truncated JSON plan with a tool-free suffix before committing and executing it", async () => {
    const prefix = '{"summary":"Assign a synthetic comparison","steps":[{"goalId":"G0","from":[],"description":"Inspect';
    const suffix = ' the split synthetic condition","successSignal":"Compare labels","evidencePlan":"Save fixture","priority":1}]}';
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        expect(input.assignedStep!.description).toBe("Inspect the split synthetic condition");
        return json({ summary: "Split plan executed; comparison remains unverified", result: "no_progress" });
      }
      if (!input.blackboard.steps.length) {
        if (run.contexts.length === 1) return message([{ type: "text", text: prefix }], "length");
        expect(run.contexts).toHaveLength(2);
        expect(context.tools).toEqual([]);
        return message([{ type: "text", text: suffix }]);
      }
      return planning(input);
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1 });
    expect(board.steps[0]).toMatchObject({ description: "Inspect the split synthetic condition", attempts: 1, status: "no_progress" });
    expect(test.seen[0]!.contexts).toHaveLength(2);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("length"))).toHaveLength(1);
    expect(test.events.filter(event => event.runtime?.type === "tool_start")).toHaveLength(0);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it.each(["decide", "metacog"] as const)("accepts an identical existing Goal in %s and executes its new Steps without a repair request", async mode => {
    let planned = false;
    let planningRequests = 0;
    const executed: string[] = [];
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        executed.push(input.assignedStep!.goalId);
        return json({ summary: "Synthetic comparison remains unverified", result: "no_progress" });
      }
      const meta = context.systemPrompt?.includes("Fresh metacognitive review") ?? false;
      if (!planned && meta === (mode === "metacog")) {
        planned = true;
        planningRequests++;
        expect(input.blackboard.goals.find(goal => goal.id === "G2")).toMatchObject({ ...fixtureGoals[0], status: "active" });
        return json({ summary: "Keep the same parent goal while assigning three fixture checks", goals: [fixtureGoals[0]!],
          steps: fixtureGoals.map((goal, index) => ({ goalId: goal.id, from: [], description: `Inspect synthetic condition ${index + 1}`,
            successSignal: "Fixture comparison observed", evidencePlan: "Preserve the synthetic comparison", priority: 50 - index })) });
      }
      return json({ summary: "Review current fixture results; no further synthetic plan" });
    });
    seedFixtureGoals(test);
    const originalGoals = test.store.snapshot().goals;
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 3, goals: originalGoals });
    expect(board.steps).toHaveLength(3);
    expect(board.steps.every(step => step.attempts === 1 && step.status === "no_progress")).toBe(true);
    expect(executed).toEqual(["G2", "G3", "G4"]);
    expect(planningRequests).toBe(1);
    expect(test.seen.every(run => run.contexts.length === 1)).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(0);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it("repairs a conflicting Goal and wrong Fact together after one read, then commits and executes without overwriting the old Goal", async () => {
    let factId = "";
    let repairRequests = 0;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1) {
          factId = input.blackboard.facts[0]!.id;
          if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-before-repair", name: "read",
            arguments: { path: join(input.workspace, input.blackboard.evidence[0]!.path) } }], "toolUse");
          const repaired = run.contexts.length === 3;
          if (repaired) {
            repairRequests++;
            expect(context.tools).toEqual([]);
            const diagnostic = JSON.stringify(context.messages.at(-1));
            expect(diagnostic).toContain("G2");
            expect(diagnostic).toContain("goals[0].id");
            expect(diagnostic).toContain("steps[0].from[0]");
            expect(diagnostic).toContain("committed IDs");
            expect(diagnostic).toContain("New Goal IDs must be unused");
            expect(JSON.stringify(context.messages)).toContain("account=alice; state=v1; control=allowed; changed-object=denied");
          } else {
            expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "read-before-repair", isError: false });
          }
          const goalId = repaired ? "G5" : "G2";
          return json({ summary: "Plan a distinct fixture observation without replacing its existing parent", goals: [
            { id: goalId, parentId: "G0", description: "A different synthetic observation goal" },
          ], steps: [{ goalId, from: [repaired ? factId : "F-missing"], description: "Inspect a new synthetic fixture condition",
            successSignal: "New label comparison observed", evidencePlan: "Use the archived synthetic artifact", priority: 1 }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) {
        expect(input.assignedStep).toMatchObject({ goalId: "G5", from: [factId] });
        return json({ summary: "New synthetic condition remains unverified", result: "no_progress" });
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      return write("fixture-checkpoint", input.checkpointFile!, checkpoint(input, "fact-before-conflict", true));
    });
    seedFixtureGoals(test);
    const originalGoals = test.store.snapshot().goals;
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 2 });
    expect(board.goals.slice(0, originalGoals.length)).toEqual(originalGoals);
    expect(board.goals).toHaveLength(originalGoals.length + 1);
    expect(board.goals.at(-1)).toMatchObject({ id: "G5", description: "A different synthetic observation goal", parentId: "G0", status: "active" });
    expect(board.steps[1]).toMatchObject({ goalId: "G5", from: [factId], attempts: 1 });
    expect(repairRequests).toBe(1);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    const toolStarts = test.events.flatMap(event => event.runtime?.type === "tool_start" ? [event.runtime.toolCallId] : []);
    expect(toolStarts).toEqual(["fixture-write", "fixture-checkpoint", "read-before-repair"]);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("returns finding identities and recovers a conflicting target by omitting it without duplicating findings", async () => {
    let findingId = "";
    let factId = "";
    const target = "local synthetic fixture";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) {
        const submission = JSON.parse(checkpoint(input));
        submission.execution.findings = [{ key: "fixture-lead", title: "Synthetic hypothesis", target, status: "lead",
          factRefs: ["fixture-f"], evidenceRefs: [], next: "Inspect remaining fixture state" }];
        return write("first-checkpoint", input.checkpointFile!, JSON.stringify(submission));
      }
      if (run.contexts.length === 3) {
        const accepted = JSON.parse(toolText(context));
        expect(accepted.findings).toEqual([{ id: expect.any(String), key: "fixture-lead", target }]);
        findingId = accepted.findings[0].id;
        factId = accepted.facts[0].id;
      }
      const finding = { key: "fixture-lead", title: "Synthetic hypothesis", status: "lead" as const,
        factRefs: [factId], evidenceRefs: [], next: "Review the observed fixture state" };
      if (run.contexts.length === 4) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
        expect(toolText(context)).toContain(`committed target=${JSON.stringify(target)}`);
        expect(toolText(context)).toContain("omit target");
        expect(test.store.snapshot().findings).toHaveLength(1);
      }
      if (run.contexts.length <= 4) return write(`update-${run.contexts.length}`, input.checkpointFile!, JSON.stringify({
        id: "batch-2", execution: { summary: "Clarify the same fixture hypothesis", result: "done",
          findings: [{ ...finding, ...(run.contexts.length === 3 ? { target: `${target} with expanded observation prose` } : {}) }] },
      }));
      expect(JSON.parse(toolText(context))).toMatchObject({ committed: true, checkpoint: "batch-2",
        findings: [{ id: findingId, key: "fixture-lead", target }] });
      return json({ summary: "Fixture updates committed; no duplicate records", result: "done",
        findings: [{ ...finding, next: "Review final fixture observations" }] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board.status).toBe("paused");
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ id: findingId, target, factIds: [factId], next: "Review final fixture observations" });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(2);
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    assertExactUsage(test);
  });

  it.each(["decide", "metacog"] as const)("retains a %s combination dependency omitted from from after a Fact spelling repair", async mode => {
    let expectedFacts: string[] = [];
    let planningRequests = 0;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        const meta = context.systemPrompt?.includes("Fresh metacognitive review");
        if (input.blackboard.completedSteps === 1 && meta === (mode === "metacog")) {
          expectedFacts = input.blackboard.facts.map(fact => fact.id);
          expect(expectedFacts).toHaveLength(2);
          planningRequests++;
          if (run.contexts.length === 2) expect(context.tools).toEqual([]);
          return json({ summary: "Check two recorded fixture conditions together", steps: [{ goalId: "G0",
            from: [run.contexts.length === 1 ? "F-misspelled" : expectedFacts[0]!],
            description: "Compare the joint fixture conditions", successSignal: "Joint label comparison observed", evidencePlan: "Use archived fixture", priority: 1,
            combination: { requires: expectedFacts, missing: ["same identity compatibility"], scope: "local fixture", stateVersion: "v1", expectedCapability: "joint fixture comparison" },
          }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) {
        expect(input.assignedStep!.from).toEqual(expectedFacts);
        expect(input.assignedStep!.combination!.requires).toEqual(expectedFacts);
        return json({ summary: "Joint fixture condition remains unverified", result: "no_progress" });
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      const submission = JSON.parse(checkpoint(input, "two-facts", true));
      submission.execution.facts.push({ ref: "fixture-control", description: "Synthetic control label is allowed for alice in state v1", evidenceRefs: ["fixture-e"] });
      return write("two-fact-checkpoint", input.checkpointFile!, JSON.stringify(submission));
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 2 });
    expect(board.steps[1]!.from).toEqual(expectedFacts);
    expect(planningRequests).toBe(2); // Only the ID spelling needed a model correction.
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_start")).toHaveLength(2);
    assertExactUsage(test);
  });

  it("inherits a checkpoint finding's Fact evidence and repairs a later metacog reference before SQLite commit", async () => {
    let factId = "";
    let evidenceId = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1 && context.systemPrompt?.includes("Fresh metacognitive review")) {
          factId = input.blackboard.facts[0]!.id;
          evidenceId = input.blackboard.evidence[0]!.id;
          const mistakenId = evidenceId.replace(/^E-/, "F-");
          if (run.contexts.length === 2) {
            expect(context.tools).toEqual([]);
            expect(JSON.stringify(context.messages.at(-1))).toContain(mistakenId);
          }
          return json({ summary: "Review another synthetic condition", steps: [{ goalId: "G0",
            from: [run.contexts.length === 1 ? mistakenId : factId], description: "Inspect the remaining fixture condition",
            successSignal: "Remaining label observed", evidencePlan: "Use archived fixture", priority: 1 }] });
        }
        return planning(input);
      }
      if (input.blackboard.completedSteps) return json({ summary: "Remaining fixture condition still unverified", result: "no_progress" });
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      const submission = JSON.parse(checkpoint(input, "inherited-finding", true));
      submission.execution.findings = [{ key: "fixture-lead", title: "Synthetic fixture hypothesis", target: "local fixture",
        status: "lead", factRefs: ["fixture-f"], evidenceRefs: [], next: "Inspect the remaining fixture condition" }];
      return write("checkpoint-write", input.checkpointFile!, JSON.stringify(submission));
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board.status).toBe("paused");
    expect(board.completedSteps).toBe(2);
    expect(board.findings[0]).toMatchObject({ factIds: [factId], evidenceIds: [evidenceId] });
    expect(board.steps[1]!.from).toEqual([factId]);
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_end" && event.runtime.isError)).toEqual([]);
    expect(test.events.filter(event => event.runtime?.type === "notice" && event.runtime.text.includes("tool-free repair"))).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("keeps accepted facts and evidence after a later model error without counting checkpoint usage twice", async () => {
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      expect(input.checkpointFile).toBe(join(input.artifacts, "checkpoint.json"));
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("stage-write", input.checkpointFile!, checkpoint(input));
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "stage-write", isError: false });
      expect(JSON.parse(toolText(context))).toMatchObject({ checkpoint: "batch-1", committed: true, yielded: false });
      expect(test.controller.snapshot()).toMatchObject({ completedSteps: 0, usage: { input: 45, output: 15, cost: 0 } });
      expect(test.controller.snapshot().steps[0]?.status).toBe("claimed");
      return message([], "error");
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "error", outcome: null, completedSteps: 0 });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(board.steps[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(board.goals[0]?.status).toBe("active");
    expect(readFileSync(join(test.root, board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.store.runs().at(-1)).toMatchObject({ mode: "execute", status: "failed" });
    assertExactUsage(test);
  });

  it.each([false, true])("finishes after an accepted checkpoint with exact cumulative usage (repeat submission: %s)", async repeated => {
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2 || (repeated && run.contexts.length === 3)) return write(`stage-write-${run.contexts.length}`, input.checkpointFile!, checkpoint(input));
      const accepted = JSON.parse(toolText(context));
      expect(accepted).toMatchObject({ committed: true, yielded: false });
      expect(accepted.facts).toHaveLength(1);
      expect(accepted.evidence).toHaveLength(1);
      return json({ summary: "Remaining synthetic comparison inspected; use previously committed evidence", result: "done", facts: [
        { ref: "additional-fact", description: "Synthetic control and changed-object labels are both present", evidenceRefs: [accepted.evidence[0].id] },
      ] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", completedSteps: 1, noProgressCount: 0, outcome: null });
    expect(board.facts).toHaveLength(2);
    expect(board.evidence).toHaveLength(1);
    expect(board.steps[0]?.status).toBe("done");
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.store.events().filter(event => event.kind === "execution")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("blocks later tools in a yielding batch and sends only committed state to fresh Decide", async () => {
    let forbiddenArtifact = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps) {
          expect(input.blackboard.facts).toHaveLength(1);
          expect(input.blackboard.evidence[0]?.excerpt).toBe(artifactBody);
          expect(input.blackboard.steps[0]?.status).toBe("blocked");
          expect(JSON.stringify(context)).not.toContain(privateNarration);
          expect(context.messages).toHaveLength(1);
        }
        return planning(input);
      }
      if (run.contexts.length === 1) return message([{ type: "text", text: privateNarration },
        { type: "toolCall", id: "fixture-write", name: "write", arguments: { path: join(input.artifacts, "fixture.txt"), content: artifactBody } }], "toolUse");
      expect(run.contexts.length).toBe(2);
      forbiddenArtifact = join(input.artifacts, "must-not-write.txt");
      return message([
        { type: "toolCall", id: "yield-checkpoint", name: "write", arguments: { path: input.checkpointFile!, content: checkpoint(input, "yield-batch", true) } },
        { type: "toolCall", id: "forbidden-after-yield", name: "write", arguments: { path: forbiddenArtifact, content: "MUST NOT EXECUTE" } },
      ], "toolUse");
    });
    await test.controller.start();
    expect(existsSync(forbiddenArtifact)).toBe(false);
    expect(test.seen.map(run => [run.channel, run.contexts.length])).toEqual([
      ["offline-decide", 1], ["offline-execute", 2], ["offline-decide", 1], ["offline-decide", 1],
    ]);
    const handoffs = test.events.flatMap(event => event.handoff ? [event.handoff] : []);
    expect(handoffs[2]).toMatchObject({ mode: "decide", trigger: { kind: "execution_result" } });
    expect(handoffs[2]?.trigger.reason).toContain("partial checkpoint");
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 1, noProgressCount: 0 });
    expect(test.controller.snapshot().steps[0]?.status).toBe("blocked");
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    expect(test.events.some(event => event.runtime?.toolCallId === "forbidden-after-yield" && event.runtime.type === "tool_end" && event.runtime.isError)).toBe(true);
    assertExactUsage(test);
  });

  it("returns invalid checkpoints as tool errors without committing records, then accepts a corrected submission", async () => {
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) {
        const invalid = JSON.parse(checkpoint(input));
        invalid.execution.facts[0].evidenceRefs = ["missing-evidence"];
        return write("invalid-stage", input.checkpointFile!, JSON.stringify(invalid));
      }
      if (run.contexts.length === 3) {
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "invalid-stage", isError: true });
        expect(toolText(context)).toContain("Unknown evidence reference");
        expect(test.controller.snapshot()).toMatchObject({ completedSteps: 0, facts: [], evidence: [] });
        expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(0);
        return write("corrected-stage", input.checkpointFile!, checkpoint(input));
      }
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "corrected-stage", isError: false });
      expect(JSON.parse(toolText(context))).toMatchObject({ committed: true, checkpoint: "batch-1" });
      return json({ summary: "Corrected checkpoint accepted; remaining synthetic work complete", result: "done" });
    });
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", completedSteps: 1, outcome: null, noProgressCount: 0 });
    expect(test.controller.snapshot().facts).toHaveLength(1);
    expect(test.controller.snapshot().evidence).toHaveLength(1);
    expect(test.controller.snapshot().steps[0]?.status).toBe("done");
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(1);
    assertExactUsage(test);
  });

  it("redacts resolver credentials in checkpoint fields and yielded output while preserving original evidence", async () => {
    const secret = 'stage-model-"credential\\value"';
    const test = setup((run, _context, input) => {
      if (run.channel !== "offline-execute") return planning(input);
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      const submission = JSON.parse(checkpoint(input, "redacted-yield", true));
      submission.execution.summary = `Synthetic model accidentally echoed ${secret} in its partial summary`;
      submission.execution.facts[0].description = `Synthetic observation with accidental credential echo: ${secret}`;
      submission.execution.evidence[0].description = `Synthetic evidence metadata accidentally echoed ${secret}`;
      return write("redacted-checkpoint", input.checkpointFile!, JSON.stringify(submission));
    }, [secret]);
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", outcome: null, completedSteps: 1 });
    expect(board.facts).toHaveLength(1);
    expect(board.facts[0]!.description).toContain("[MODEL_CREDENTIAL_REDACTED]");
    expect(board.steps[0]?.result).toContain("[MODEL_CREDENTIAL_REDACTED]");
    expect(board.evidence[0]!.description).toContain("[MODEL_CREDENTIAL_REDACTED]");
    for (const [label, publicData] of [["board", board], ["public events", test.events], ["store events", test.store.events()]] as const) {
      expect(JSON.stringify(publicData).includes("stage-model-"), `${label} must not contain an echoed model credential`).toBe(false);
    }
    const executionRun = test.store.runs().find(run => run.mode === "execute")!;
    const output = readFileSync(join(test.store.dataDir, "runs", executionRun.id, "output.json"), "utf8");
    expect(output).not.toContain("stage-model-");
    expect(output).toContain("[MODEL_CREDENTIAL_REDACTED]");
    expect(readFileSync(join(test.root, board.evidence[0]!.path), "utf8")).toBe(artifactBody);
    for (const run of test.seen.slice(2)) expect(JSON.stringify(run.contexts[0])).not.toContain("stage-model-");
    assertExactUsage(test);
  });

  it("returns reusable committed IDs when a checkpoint deduplicates evidence and facts from another run", async () => {
    let firstIds: { fact: string; evidence: string } | undefined;
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (input.blackboard.completedSteps === 1) return json({ summary: "Recheck the same synthetic fixture in another Execute run", steps: [{
          goalId: "G0", from: [input.blackboard.facts[0]!.id], description: "Read the same condition and attach a new hypothesis",
          successSignal: "Reuse verified artifact identities without duplicating them", evidencePlan: "Save identical fixture bytes for deduplication", priority: 50,
        }] });
        return planning(input);
      }
      if (run.contexts.length === 1) return write("fixture-write", join(input.artifacts, "fixture.txt"), artifactBody);
      if (run.contexts.length === 2) return write("stage-write", input.checkpointFile!, checkpoint(input));
      const accepted = JSON.parse(toolText(context));
      expect(accepted).toMatchObject({ committed: true, checkpoint: "batch-1" });
      expect(accepted.facts).toHaveLength(1);
      expect(accepted.evidence).toHaveLength(1);
      const ids = { fact: accepted.facts[0].id, evidence: accepted.evidence[0].id };
      if (!input.blackboard.completedSteps) {
        firstIds = ids;
        return json({ summary: "First synthetic observation has been committed", result: "done" });
      }
      expect(ids).toEqual(firstIds);
      expect(test.controller.snapshot().facts).toHaveLength(1);
      expect(test.controller.snapshot().evidence).toHaveLength(1);
      return json({ summary: "Attach a new synthetic hypothesis using acknowledged IDs from the earlier run", result: "done", findings: [{
        key: "cross-run-synthetic-fixture", title: "Synthetic fixture hypothesis only", target: "generated local fixture", status: "lead",
        factRefs: [ids.fact], evidenceRefs: [ids.evidence], next: "Review fixture conditions before drawing any conclusion",
      }] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "paused", outcome: null, completedSteps: 2 });
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ factIds: [firstIds!.fact], evidenceIds: [firstIds!.evidence] });
    const executionRuns = test.store.runs().filter(run => run.mode === "execute");
    expect(executionRuns).toHaveLength(2);
    expect(board.evidence[0]!.runId).toBe(executionRuns[0]!.id);
    expect(board.facts[0]!.stepId).toBe(executionRuns[0]!.stepId);
    expect(test.store.events().filter(event => event.kind === "execution_checkpoint")).toHaveLength(2);
    assertExactUsage(test);
  });
});
