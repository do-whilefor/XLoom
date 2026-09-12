import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.js";
import { LoopController } from "../src/controller.js";
import type { BlackboardContext, ContextStep } from "../src/loop/context.js";
import { PiRunner } from "../src/runtime/pi-runner.js";
import type { ModelResolver } from "../src/runtime/models.js";
import { BlackboardStore } from "../src/store.js";
import type { Decision, Execution, LoopEvent } from "../src/types.js";

// This suite replaces the provider stream only: Controller, SQLite, Pi Agent and
// Pi's native file tools are real. It makes no network calls or vulnerability claims.
const syntheticArtifact = "SYNTHETIC INTEGRATION FIXTURE ONLY\nidentity=A: expected allowed\nidentity=B: expected denied\n";
const privateTurn = "EXECUTE_PRIVATE_TOOL_TURN_NOT_A_BLACKBOARD_FACT";
const model: Model<"openai-completions"> = {
  id: "offline", name: "offline", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000,
};

interface PromptData {
  blackboard: Pick<BlackboardContext, "goals" | "facts" | "findings" | "evidence" | "steps" | "completedSteps" | "projection">;
  assignedStep?: ContextStep;
  workspace: string;
  artifacts: string;
}
interface SeenRun { channel: string; contexts: Context[] }
const opened: { root: string; store: BlackboardStore; controller: LoopController }[] = [];

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.controller.waitForIdle();
    entry.store.close();
    rmSync(entry.root, { recursive: true, force: true });
  }
});

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 0,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(stopReason === "error" ? { errorMessage: "Synthetic provider failure after successful file write" } : {}),
  };
}

function json(output: Decision | Execution): AssistantMessage {
  return message([{ type: "text", text: JSON.stringify(output) }]);
}

function promptData(context: Context): PromptData {
  const user = context.messages[0];
  if (user?.role !== "user") throw new Error("Fresh run must start with its own user prompt");
  const text = typeof user.content === "string" ? user.content : user.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  return JSON.parse(text.split("\n").at(-1)!) as PromptData;
}

function setup(respond: (run: SeenRun, context: Context, input: PromptData) => AssistantMessage) {
  const root = mkdtempSync(join(tmpdir(), "xloom-pi-loop-integration-"));
  const config = defaultConfig("Exercise synthetic local file roundtrip and blackboard completion only; no live target");
  config.models = { decide: { provider: "test", model: "offline-decide" }, execute: { provider: "test", model: "offline-execute" } };
  config.limits.metacogEvery = 10;
  const store = new BlackboardStore(root, config);
  const seen: SeenRun[] = [];
  const resolveModel: ModelResolver = async config => {
    const run: SeenRun = { channel: config.model, contexts: [] };
    seen.push(run);
    if (seen.length > 10) throw new Error("Synthetic integration loop exceeded expected run count");
    return {
      model: { ...model, id: config.model },
      streamFn: (_model, context) => {
        run.contexts.push(JSON.parse(JSON.stringify(context)) as Context);
        const response = respond(run, context, promptData(context));
        const events = new AssistantMessageEventStream();
        queueMicrotask(() => {
          events.push({ type: "start", partial: response });
          if (response.stopReason === "error" || response.stopReason === "aborted") {
            events.push({ type: "error", reason: response.stopReason, error: response });
          } else {
            events.push({ type: "done", reason: response.stopReason, message: response });
          }
          events.end();
        });
        return events;
      },
    };
  };
  const controller = new LoopController(store, new PiRunner({ resolveModel }));
  const events: LoopEvent[] = [];
  controller.subscribe(event => events.push(event));
  opened.push({ root, store, controller });
  return { root, store, controller, seen, events };
}

function plan(): Decision {
  return {
    summary: "Plan a synthetic file roundtrip, not target research",
    steps: [{ goalId: "G0", from: [], description: "Write and read back the synthetic identity fixture", successSignal: "Pi read returns the written fixture", evidencePlan: "Retain synthetic fixture in the assigned artifact directory", priority: 50 }],
  };
}

function proposal(input: PromptData): Decision {
  return {
    summary: "Propose review of the synthetic protocol goal",
    updateGoals: [{ id: "G0", status: "satisfied", factIds: [input.blackboard.facts[0]!.id], reason: "The synthetic file was written and read back; this is not live target evidence" }],
    conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic protocol fixture exercise complete; no live security boundary was tested" },
  };
}

describe("real Pi inner loop with the two-Agent outer loop", () => {
  it("commits native tool evidence, replans through the blackboard and completes only after fresh Decide metacognition", async () => {
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        expect(input.assignedStep).toMatchObject({ goalId: "G0", status: "claimed", attempts: 1 });
        const artifact = join(input.artifacts, "synthetic-roundtrip.txt");
        if (run.contexts.length === 1) {
          return message([
            { type: "text", text: privateTurn },
            { type: "toolCall", id: "fixture-write", name: "write", arguments: { path: artifact, content: syntheticArtifact } },
          ], "toolUse");
        }
        const result = context.messages.at(-1);
        expect(result?.role).toBe("toolResult");
        if (run.contexts.length === 2) {
          expect(result).toMatchObject({ toolCallId: "fixture-write", toolName: "write", isError: false });
          expect(readFileSync(artifact, "utf8")).toBe(syntheticArtifact);
          return message([{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: artifact } }], "toolUse");
        }
        expect(result).toMatchObject({ toolCallId: "fixture-read", toolName: "read", isError: false });
        expect(JSON.stringify(result)).toContain("identity=B: expected denied");
        return json({
          summary: "Pi read returned the synthetic fixture written in this Step",
          result: "done",
          evidence: [{ ref: "roundtrip-e", path: artifact, description: "Synthetic integration artifact, not a request or response from a live target" }],
          facts: [{ ref: "roundtrip-f", description: "The synthetic file roundtrip returned both expected identity labels", evidenceRefs: ["roundtrip-e"] }],
          findings: [{ key: "synthetic-fixture-only", title: "Synthetic integration hypothesis", target: "local generated fixture only", status: "lead", factRefs: ["roundtrip-f"], evidenceRefs: ["roundtrip-e"], next: "Review synthetic protocol fixture; no vulnerability claim" }],
        });
      }
      if (!input.blackboard.completedSteps) return json(plan());
      expect(input.blackboard.evidence[0]?.excerpt).toBe(syntheticArtifact);
      expect(input.blackboard.facts[0]?.evidenceIds).toEqual([input.blackboard.evidence[0]!.id]);
      expect(input.blackboard.goals[0]?.status).toBe("active");
      expect(input.blackboard.findings[0]?.status).toBe("lead");
      if (!context.systemPrompt?.includes("fresh metacognitive review")) return json(proposal(input));
      return json({
        ...proposal(input),
        summary: "Fresh review confirms only the synthetic protocol goal is complete",
        reviews: [{ findingId: input.blackboard.findings[0]!.id, status: "closed", rating: "unrated", reason: "Synthetic expected labels read back correctly; reopen if fixture expectations change. This does not validate a live security target." }],
      });
    });

    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1, usage: { input: 60, output: 30, cost: 0 } });
    expect(board.goals[0]).toMatchObject({ id: "G0", status: "satisfied", factIds: [board.facts[0]!.id] });
    expect(board.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(board.evidence).toHaveLength(1);
    const archived = readFileSync(join(test.root, board.evidence[0]!.path), "utf8");
    expect(archived).toBe(syntheticArtifact);
    expect(board.evidence[0]!.sha256).toBe(createHash("sha256").update(syntheticArtifact).digest("hex"));
    expect(test.store.runs().map(run => [run.mode, run.status])).toEqual([
      ["decide", "completed"], ["execute", "completed"], ["decide", "completed"], ["metacog", "completed"],
    ]);
    expect(test.seen.map(run => run.channel)).toEqual(["offline-decide", "offline-execute", "offline-decide", "offline-decide"]);
    expect(new Set(test.seen.map(run => run.channel)).size).toBe(2);
    expect(test.seen.map(run => run.contexts.length)).toEqual([1, 3, 1, 1]);
    for (const run of test.seen) {
      expect(run.contexts[0]?.messages).toHaveLength(1);
      expect(run.contexts[0]?.messages[0]?.role).toBe("user");
      expect(run.contexts[0]?.tools?.map(tool => tool.name) ?? []).toEqual(run.channel === "offline-execute" ? ["read", "write", "edit", "powershell"] : ["read"]);
      expect(JSON.stringify(run.contexts[0])).not.toContain(privateTurn);
      expect(JSON.stringify(run.contexts[0])).not.toContain("fixture-write");
    }
    expect(JSON.stringify(test.seen[1]!.contexts[2])).toContain(privateTurn);
    expect(test.events.filter(event => event.runtime?.type === "tool_end").map(event => [event.runtime?.mode, event.runtime?.toolName, event.runtime?.isError])).toEqual([
      ["execute", "write", false], ["execute", "read", false],
    ]);
    const decisions = test.store.events().filter(event => event.kind === "decision").map(event => JSON.parse(event.payload).decision as Decision);
    expect(decisions.slice(0, -1).every(decision => !decision.conclusion && !decision.updateGoals?.some(goal => goal.id === "G0"))).toBe(true);
    expect(decisions.at(-1)?.conclusion?.outcome).toBe("NOT_REPRODUCED");
    const callsBeforeRestart = test.seen.length;
    await test.controller.start();
    expect(test.seen).toHaveLength(callsBeforeRestart);
  });

  it("retains successful tool side effects after a provider failure, without false completion or automatic replay", async () => {
    let artifact = "";
    const test = setup((run, _context, input) => {
      if (run.channel !== "offline-execute") {
        if (!input.blackboard.steps.length) return json(plan());
        expect(input.blackboard.steps[0]).toMatchObject({ status: "failed", attempts: 1 });
        return json({ summary: "No retry proposed until the partial synthetic operation is inspected" });
      }
      if (run.contexts.length === 1) {
        artifact = join(input.artifacts, "partial-synthetic-write.txt");
        return message([{ type: "toolCall", id: "partial-write", name: "write", arguments: { path: artifact, content: syntheticArtifact } }], "toolUse");
      }
      expect(readFileSync(artifact, "utf8")).toBe(syntheticArtifact);
      return message([], "error");
    });

    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "error", outcome: null, completedSteps: 0, facts: [], findings: [], evidence: [], usage: { input: 30, output: 15, cost: 0 } });
    expect(test.controller.snapshot().goals[0]?.status).toBe("active");
    expect(test.controller.snapshot().steps[0]).toMatchObject({ status: "failed", attempts: 1, leaseUntil: null });
    expect(test.controller.snapshot().reason).toContain("Synthetic provider failure");
    expect(test.store.runs().at(-1)).toMatchObject({ mode: "execute", status: "failed" });
    expect(readFileSync(artifact, "utf8")).toBe(syntheticArtifact);

    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "paused", outcome: null, completedSteps: 0, facts: [], findings: [], evidence: [] });
    expect(test.controller.snapshot().steps[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(test.seen.map(run => run.channel)).toEqual(["offline-decide", "offline-execute", "offline-decide", "offline-decide"]);
    expect(test.store.runs().map(run => run.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    expect(test.events.filter(event => event.runtime?.type === "tool_start" && event.runtime.toolName === "write")).toHaveLength(1);
    expect(test.seen.slice(2).every(run => run.contexts[0]?.messages.length === 1)).toBe(true);
    expect(readFileSync(artifact, "utf8")).toBe(syntheticArtifact);
  });

  it("recovers a failed run's artifact through a fresh blackboard plan without sharing chats or replaying its write", async () => {
    const recoveryPrefix = "Read existing artifact without replaying its write: ";
    let writtenArtifact = "";
    let inspectedArtifact = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (!input.blackboard.steps.length) return json(plan());
        expect(input.blackboard.evidence).toEqual([]);
        expect(input.blackboard.facts).toEqual([]);
        const failed = input.blackboard.steps.find(step => step.status === "failed")!;
        expect(failed.recovery).toMatchObject({ evidenceStatus: "unverified" });
        expect(input.blackboard.projection.notice).toContain("not committed Evidence or Facts");
        if (!input.blackboard.completedSteps) {
          const existingArtifact = join(failed.recovery!.artifacts, "partial-synthetic-write.txt");
          return json({
            summary: "Inspect the previous write before any retry; the recovery pointer is not evidence",
            steps: [{
              goalId: "G0", from: [], description: `${recoveryPrefix}${JSON.stringify(existingArtifact)}`,
              successSignal: "The native read tool returns the existing artifact bytes without another write",
              evidencePlan: "Inspect only. Do not fabricate an evidence record or claim verified impact from the recovery pointer.", priority: 50,
            }],
          });
        }
        return json({ summary: "Recovery inspection finished; no evidence-backed conclusion proposed" });
      }
      if (input.assignedStep?.description.startsWith(recoveryPrefix)) {
        // The recovery Agent learns the file from the newly committed Step,
        // never this test's captured old artifact path or the old transcript.
        inspectedArtifact = JSON.parse(input.assignedStep.description.slice(recoveryPrefix.length)) as string;
        if (run.contexts.length === 1) {
          expect(JSON.stringify(context)).not.toContain(privateTurn);
          expect(input.blackboard.steps).toHaveLength(1);
          return message([{ type: "toolCall", id: "recovery-read", name: "read", arguments: { path: inspectedArtifact } }], "toolUse");
        }
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "recovery-read", toolName: "read", isError: false });
        expect(JSON.stringify(context.messages.at(-1))).toContain("identity=B: expected denied");
        return json({ summary: "Read the uncommitted synthetic file without repeating the write; no evidence submitted", result: "no_progress" });
      }
      if (run.contexts.length === 1) {
        writtenArtifact = join(input.artifacts, "partial-synthetic-write.txt");
        return message([
          { type: "text", text: privateTurn },
          { type: "toolCall", id: "failed-run-write", name: "write", arguments: { path: writtenArtifact, content: syntheticArtifact } },
        ], "toolUse");
      }
      expect(readFileSync(writtenArtifact, "utf8")).toBe(syntheticArtifact);
      return message([], "error");
    });

    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({ status: "error", outcome: null, completedSteps: 0, facts: [], evidence: [] });
    const failedStepId = test.controller.snapshot().steps[0]!.id;
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(inspectedArtifact).toBe(writtenArtifact);
    expect(readFileSync(writtenArtifact, "utf8")).toBe(syntheticArtifact);
    expect(board).toMatchObject({ status: "paused", outcome: null, completedSteps: 1, facts: [], findings: [], evidence: [] });
    expect(board.steps.find(step => step.id === failedStepId)).toMatchObject({ status: "failed", attempts: 1 });
    expect(board.steps.find(step => step.id !== failedStepId)).toMatchObject({ status: "no_progress", attempts: 1 });
    expect(test.seen.map(run => run.channel)).toEqual(["offline-decide", "offline-execute", "offline-decide", "offline-execute", "offline-decide", "offline-decide"]);
    expect(test.events.filter(event => event.runtime?.type === "tool_start").map(event => event.runtime!.toolName)).toEqual(["write", "read"]);
    for (const run of test.seen.slice(2)) {
      expect(run.contexts[0]?.messages).toHaveLength(1);
      const serialized = JSON.stringify(run.contexts[0]);
      for (const privateDetail of [privateTurn, "failed-run-write", "input.json", "events.jsonl", "output.json"]) expect(serialized).not.toContain(privateDetail);
    }
  });
});
