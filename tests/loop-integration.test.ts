import { taskDirectory } from "../src/workspace.js";
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
import { loadMethod, methodCatalog, type MethodContext } from "../src/methods.js";
import type { ModelResolver } from "../src/runtime/models.js";
import { BlackboardStore } from "../src/store.js";
import type { Decision, Execution, LoopEvent } from "../src/types.js";
import type { knowledgeContext } from "../src/knowledge/context.js";
import type { retrievalContext } from "../src/wiki/retrieval.js";
import { gapQueue, type gapContext } from "../src/knowledge/gaps.js";

// This suite replaces the provider stream only: Controller, SQLite, Pi Agent and
// Pi's native file tools are real. It makes no network calls or vulnerability claims.
const syntheticArtifact = "SYNTHETIC INTEGRATION FIXTURE ONLY\nidentity=A: expected allowed\nidentity=B: expected denied\n";
const privateTurn = "EXECUTE_PRIVATE_TOOL_TURN_NOT_A_BLACKBOARD_FACT";
const model: Model<"openai-completions"> = {
  id: "offline", name: "offline", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000,
};

interface PromptData {
  blackboard: Pick<BlackboardContext, "goals" | "facts" | "findings" | "evidence" | "steps" | "completedSteps" | "projection" | "findingContext">;
  assignedStep?: ContextStep;
  workspace: string;
  artifacts: string;
  methods?: MethodContext;
  knowledge?: ReturnType<typeof knowledgeContext>;
  rag?: ReturnType<typeof retrievalContext>;
  gaps?: ReturnType<typeof gapContext>;
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

describe("native gap workflow through Pi and Controller", () => {
  it("records a gap, associates new material, revisits with a fresh plan, and independently resolves it", async () => {
    const conditions = { scope: "fixture", identity: "fixture-a", environment: "local", stateVersion: "v1" };
    const next = (description: string) => ({ ...plan().steps![0]!, description });
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        if (input.assignedStep!.description === "Record fixture gap") return json({ summary: "Missing fixture input", result: "blocked",
          gaps: [{ id: "gap-input", missing: "Fixture input", why: "Check cannot proceed", reopenWhen: "A compatible input is observed", needs: [{ type: "fixture-input", aliases: [], description: "Fixture value" }], conditions }] });
        if (run.contexts.length === 1) return message([{ type: "text", text: privateTurn }, { type: "toolCall", id: "write-gap-fixture", name: "write", arguments: { path: join(input.artifacts, "gap.txt"), content: syntheticArtifact + input.assignedStep!.description } }], "toolUse");
        return json({ summary: "Local fixture observation", result: "done", evidence: [{ ref: "e", path: "gap.txt", description: "Synthetic original" }],
          facts: [{ ref: "f", description: input.assignedStep!.description, evidenceRefs: ["e"] }],
          ...(input.assignedStep!.revisits ? {} : { capabilities: [{ id: "C-fixture-input", title: "Fixture input", status: "available" as const, provides: [{ type: "fixture-input", aliases: [], description: "Fixture value" }], needs: [], conditions, factRefs: ["f"], counterFactRefs: [], changeReason: "Fixture" }] }) });
      }
      expect(JSON.stringify(context)).not.toContain(privateTurn);
      const item = input.gaps!.items[0];
      if (!item) return json({ summary: "Plan fixture", steps: [next("Record fixture gap")] });
      if (!item.candidates.length) return json({ summary: "Wait and inspect material", gapReviews: [{ stepId: item.stepId, gapId: item.gapId, action: "defer", reason: "Need new input", factIds: [] }], steps: [next("Observe fixture input")] });
      if (!item.sources.length) return json({ summary: "Review original fixture and choose a new bounded test", steps: [{ ...next("Validate new fixture input"), from: item.candidates[0]!.factIds, priority: 100, revisits: [{ stepId: item.stepId, gapId: item.gapId }] }] });
      return json({ summary: "Fixture gap resolved, whole research task remains open", gapReviews: [{ stepId: item.stepId, gapId: item.gapId, action: "resolve", reason: "The local fixture supplies the missing input", factIds: [item.sources[0]!.source.id] }] });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(test.seen.map(item => item.channel)).toEqual(["offline-decide", "offline-execute", "offline-decide", "offline-execute", "offline-decide", "offline-execute", "offline-decide"]);
    expect(test.events.filter(event => event.handoff?.trigger.kind === "gap_review")).toHaveLength(2);
    expect(gapQueue(board)[0]!.state).toBe("resolved");
    expect(board.steps[0]!.status).toBe("blocked"); expect(board.goals[0]!.status).toBe("active"); expect(board.outcome).toBeNull();
    expect(board.status).toBe("paused");
    for (const run of test.seen) expect(run.contexts[0]!.messages).toHaveLength(1);
  });
});

function proposal(input: PromptData): Decision {
  return {
    summary: "Propose review of the synthetic protocol goal",
    updateGoals: [{ id: "G0", status: "satisfied", factIds: [input.blackboard.facts[0]!.id], reason: "The synthetic file was written and read back; this is not live target evidence" }],
    conclusion: { outcome: "NOT_REPRODUCED", reason: "Synthetic protocol fixture exercise complete; no live security boundary was tested" },
  };
}

describe("real Pi inner loop with the two-Agent outer loop", () => {
  it("hands committed native capability connections to a fresh Decide via Wiki/RAG and keeps the private execution transcript out", async () => {
    let readKnowledge = false;
    const test = setup((run, context, input) => {
      expect(input.knowledge?.authoringGuide).toContain("authoring.md");
      if (run.channel !== "offline-execute") {
        if (!input.blackboard.completedSteps) return json(plan());
        expect(context.tools?.map(tool => tool.name)).toEqual(["read"]);
        expect(JSON.stringify(input)).not.toContain(privateTurn);
        expect(input.knowledge?.discovery.items.find(item => item.consumerId === "C-download")?.plan?.capabilityIds).toEqual(["C-export", "C-download"]);
        expect(input.knowledge?.chains[0]?.reviewIssues).toEqual([]);
        expect(input.rag).toBeDefined();
        if (run.contexts.length === 1) return message([{ type: "toolCall", id: "read-knowledge", name: "read", arguments: { path: input.knowledge!.chains[0]!.pageFile } }], "toolUse");
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
        expect(JSON.stringify(context.messages.at(-1))).toContain("CH-flow"); readKnowledge = true;
        return json({ summary: "Synthetic knowledge handoff inspected; no target conclusion or next experiment is proposed by this fixture." });
      }
      if (run.contexts.length === 1) return message([{ type: "text", text: privateTurn }, { type: "toolCall", id: "write-knowledge", name: "write", arguments: { path: join(input.artifacts, "knowledge.txt"), content: syntheticArtifact } }], "toolUse");
      const conditions = { scope: "local synthetic fixture", identity: "A", environment: "fixture", stateVersion: "1" };
      const port = (type: string) => ({ type, aliases: [], description: `Synthetic ${type}` });
      return json({ summary: "Record native capabilities and their synthetic connection", result: "done", evidence: [{ ref: "e", path: "knowledge.txt", description: "Synthetic source" }],
        facts: [{ ref: "f", description: "Synthetic job-id was consumed and the final local result was read back", evidenceRefs: ["e"] }],
        capabilities: [
          { id: "C-export", title: "Synthetic export", status: "available", provides: [port("job-id")], needs: [], conditions, factRefs: ["f"], counterFactRefs: [], changeReason: "Synthetic source" },
          { id: "C-download", title: "Synthetic download", status: "available", provides: [port("download")], needs: [port("job-id")], conditions, factRefs: ["f"], counterFactRefs: [], changeReason: "Synthetic consumer" },
        ], chains: [{ id: "CH-flow", title: "Synthetic connection", status: "verified", capabilityIds: ["C-export", "C-download"], conditions,
          links: [{ producerId: "C-export", consumerId: "C-download", provideIndex: 0, needIndex: 0, status: "verified", factRefs: ["f"], conditions, note: "Fixture consumption observation" }],
          result: "Local fixture result", resultFactRefs: ["f"], counterFactRefs: [], changeReason: "Synthetic result" }],
        wikiPages: [{ id: "WK-native", title: "Synthetic native connection", blocks: [{ id: "B-native", title: "Synthetic result", text: "Synthetic contract exercise only; no real vulnerability claim.", sources: [{ kind: "chain", id: "CH-flow" }] }] }],
      });
    });
    await test.controller.start();
    expect(readKnowledge).toBe(true); expect(test.store.snapshot().status, test.store.snapshot().reason).toBe("paused");
    expect(test.store.snapshot().outcome).toBeNull();
    expect(test.events.some(event => event.handoff?.trigger.kind === "knowledge_change")).toBe(true);
    expect(test.store.snapshot().findings).toEqual([]);
    const executionRun = test.store.runs().find(run => run.mode === "execute")!;
    const savedInput = JSON.parse(readFileSync(join(test.store.dataDir, "runs", executionRun.id, "input.json"), "utf8"));
    expect(savedInput.userPrompt).toContain('"knowledge"'); expect(savedInput.userPrompt).toContain('"rag"');
  });

  it("reads an unlinked candidate through existing tools without changing Finding support or SQLite records", async () => {
    const inspect = "Inspect one related synthetic artifact";
    let candidateId = "";
    const test = setup((run, context, input) => {
      if (run.channel !== "offline-execute") {
        if (!input.blackboard.completedSteps) return json(plan());
        if (input.blackboard.completedSteps === 1) return json({ summary: "Inspect the related candidate before deciding support", steps: [
          { goalId: "G0", from: [input.blackboard.facts[0]!.id], description: inspect, successSignal: "Candidate read", evidencePlan: "Inspect saved fixture only", priority: 1 },
        ] });
        return json({ summary: "Related material inspected; no new evidence or conclusion submitted" });
      }
      expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell"]);
      if (input.assignedStep?.description === inspect) {
        expect(input.blackboard.findings.map(finding => finding.key)).toEqual(["focus"]);
        const focus = input.blackboard.findings[0]!;
        const data = input.blackboard.findingContext!;
        const related = data.items.find(item => item.findingId === focus.id)!.related.find(item => item.kind === "shared_finding")!;
        candidateId = related.candidateEvidenceIds[0]!;
        expect(focus.evidenceIds).not.toContain(candidateId);
        const source = data.evidence.find(item => item.id === candidateId)!;
        if (run.contexts.length === 1) return message([
          { type: "toolCall", id: "read-candidate", name: "read", arguments: { path: source.path } },
        ], "toolUse");
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
        expect(JSON.stringify(context.messages.at(-1))).toContain("synthetic=2");
        return json({ summary: "Read existing candidate; support remains unassessed", result: "no_progress" });
      }
      if (run.contexts.length === 1) return message([0, 1, 2, 3].map(i => ({
        type: "toolCall", id: `write-view-${i}`, name: "write", arguments: { path: join(input.artifacts, `${i}.txt`), content: `${syntheticArtifact}synthetic=${i}` },
      })), "toolUse");
      return json({ summary: "Synthetic source material saved", result: "done",
        evidence: [0, 1, 2, 3].map(i => ({ ref: `e${i}`, path: join(input.artifacts, `${i}.txt`), description: "Synthetic local fixture" })),
        facts: [0, 1, 2, 3].map(i => ({ ref: `f${i}`, description: `Synthetic observation ${i}`, evidenceRefs: [`e${i}`] })),
        findings: [{ key: "focus", factRefs: ["f0", "f1"], evidenceRefs: ["e0", "e1"] },
          { key: "peer", factRefs: ["f1", "f2"], evidenceRefs: ["e1", "e2"] }, { key: "other", factRefs: ["f3"], evidenceRefs: ["e3"] }]
          .map(finding => ({ ...finding, title: "Synthetic hypothesis", target: finding.key, status: "lead", next: "Inspect source" })),
      });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "paused", completedSteps: 2, outcome: null });
    expect(board.facts).toHaveLength(4);
    expect(board.evidence).toHaveLength(4);
    expect(board.findings.find(finding => finding.key === "focus")!.evidenceIds).not.toContain(candidateId);
    expect(board.findings.every(finding => finding.status === "lead" && !finding.pocEvidenceId)).toBe(true);
    expect(board).not.toHaveProperty("findingContext");
    expect(test.store.runs().every(run => run.status === "completed")).toBe(true);
    expect(test.events.filter(event => event.runtime?.type === "tool_start").map(event => event.runtime!.toolName))
      .toEqual(["write", "write", "write", "write", "read"]);
    expect(readFileSync(test.store.projectionPath, "utf8")).toContain('"kind":"finding"');
    expect(readFileSync(test.store.projectionPath, "utf8")).toContain(candidateId);
    const before = test.store.events();
    test.store.close();
    const reopened = new BlackboardStore(test.root, board.config);
    try {
      expect(reopened.snapshot().findings).toEqual(board.findings);
      expect(reopened.snapshot()).not.toHaveProperty("findingContext");
      expect(reopened.events()).toEqual(before);
    } finally { reopened.close(); }
  });

  it("carries built-in methods from planning through execution and fresh review with existing tools", async () => {
    const test = setup((run, context, input) => {
      if (run.channel === "offline-execute") {
        expect(input.assignedStep?.methodIds).toEqual(["baseline-authz"]);
        expect(input.methods?.catalog).toBeUndefined();
        expect(Object.keys(input.methods!.cards)).toEqual(["baseline-authz"]);
        expect(input.methods!.cards["baseline-authz"]).toContain(loadMethod("baseline-authz").execute);
        const artifact = join(input.artifacts, "method-fixture.txt");
        if (run.contexts.length === 1) return message([
          { type: "toolCall", id: "method-write", name: "write", arguments: { path: artifact, content: syntheticArtifact } },
        ], "toolUse");
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "write", isError: false });
        return json({ summary: "Saved synthetic controls", result: "done",
          evidence: [{ ref: "e", path: artifact, description: "Synthetic integration fixture only" }],
          facts: [{ ref: "f", description: "Synthetic fixture was written", evidenceRefs: ["e"] }],
          findings: [{ key: "method-fixture", title: "Synthetic fixture hypothesis", target: "local fixture only",
            status: "lead", factRefs: ["f"], evidenceRefs: ["e"], next: "Review synthetic controls" }] });
      }
      expect(input.methods?.catalog).toEqual(methodCatalog());
      if (!input.blackboard.completedSteps) {
        expect(input.methods?.cards).toEqual({});
        if (run.contexts.length === 1) return message([
          { type: "toolCall", id: "method-read", name: "read", arguments: { path: join(input.methods!.directory!, "baseline-authz.json") } },
        ], "toolUse");
        expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
        expect(JSON.stringify(context.messages.at(-1))).toContain(loadMethod("baseline-authz").execute);
        const planned = plan();
        planned.steps![0]!.methodIds = ["baseline-authz"];
        return json(planned);
      }
      expect(input.methods?.cards).toEqual({ "baseline-authz": loadMethod("baseline-authz").review });
      if (run.contexts.length === 1) return message([
        { type: "toolCall", id: "method-evidence-read", name: "read", arguments: { path: input.blackboard.evidence[0]!.path } },
      ], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
      expect(JSON.stringify(context.messages.at(-1))).toContain("identity=B: expected denied");
      return json({ ...proposal(input), ...(input.blackboard.projection.mode === "metacog" ? {
        reviews: [{ findingId: input.blackboard.findings[0]!.id, status: "closed" as const, rating: "unrated" as const,
          reason: "Synthetic labels match; reopen if fixture expectations change. No live target was tested." }],
      } : {}) });
    });
    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board, board.reason).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1 });
    expect(board.steps[0]!.methodIds).toEqual(["baseline-authz"]);
    expect(board.facts).toHaveLength(1);
    expect(board.evidence).toHaveLength(1);
    expect(board.findings).toHaveLength(1);
    expect(board.findings[0]).toMatchObject({ key: "method-fixture", status: "closed", rating: "unrated" });
    expect(test.store.runs().map(run => run.mode)).toEqual(["decide", "execute", "decide", "metacog"]);
    for (const run of test.seen) {
      expect(run.contexts[0]?.messages).toHaveLength(1);
      expect(run.contexts[0]?.tools?.map(tool => tool.name)).toEqual(
        run.channel === "offline-execute" ? ["read", "write", "edit", "powershell"] : ["read"]);
    }
    for (const run of test.store.runs()) {
      const saved = JSON.parse(readFileSync(join(test.store.dataDir, "runs", run.id, "input.json"), "utf8"));
      const savedMethods = JSON.parse(saved.userPrompt.split("\n").at(-1)!).methods;
      expect(savedMethods).toBeDefined();
      if (run.mode === "execute") expect(savedMethods.cards["baseline-authz"]).toContain(loadMethod("baseline-authz").execute);
    }
  });

  it.each([false, true])("commits real tool evidence and completes after review, with premature NEED_INPUT and directory read: %s", async prematureInput => {
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
      if (!input.blackboard.completedSteps) {
        expect(input).not.toHaveProperty("artifacts");
        if (prematureInput && run.contexts.length === 1) {
          return message([{ type: "toolCall", id: "inspect-directory", name: "read", arguments: { path: input.workspace } }], "toolUse");
        }
        if (prematureInput) {
          expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
          expect(JSON.stringify(context.messages.at(-1))).not.toContain(".xloom");
        }
        return json({ ...plan(), ...(prematureInput ? { conclusion: {
          outcome: "NEED_INPUT" as const, reason: "The planned fixture file has not been written by Execute yet.",
        } } : {}) });
      }
      expect(input.blackboard.evidence[0]?.excerpt).toBe(syntheticArtifact);
      expect(input.blackboard.facts[0]?.evidenceIds).toEqual([input.blackboard.evidence[0]!.id]);
      expect(input.blackboard.goals[0]?.status).toBe("active");
      expect(input.blackboard.findings[0]?.status).toBe("lead");
      if (input.blackboard.projection.mode !== "metacog") return json(proposal(input));
      return json({
        ...proposal(input),
        summary: "Fresh review confirms only the synthetic protocol goal is complete",
        reviews: [{ findingId: input.blackboard.findings[0]!.id, status: "closed", rating: "unrated", reason: "Synthetic expected labels read back correctly; reopen if fixture expectations change. This does not validate a live security target." }],
      });
    });

    await test.controller.start();
    const board = test.controller.snapshot();
    expect(board).toMatchObject({ status: "completed", outcome: "NOT_REPRODUCED", completedSteps: 1, usage: { input: prematureInput ? 70 : 60, output: prematureInput ? 35 : 30, cost: 0 } });
    expect(board.goals[0]).toMatchObject({ id: "G0", status: "satisfied", factIds: [board.facts[0]!.id] });
    expect(board.findings[0]).toMatchObject({ status: "closed", rating: "unrated" });
    expect(board.evidence).toHaveLength(1);
    const archived = readFileSync(join(taskDirectory(test.root), board.evidence[0]!.path), "utf8");
    expect(archived).toBe(syntheticArtifact);
    expect(board.evidence[0]!.sha256).toBe(createHash("sha256").update(syntheticArtifact).digest("hex"));
    expect(test.store.runs().map(run => [run.mode, run.status])).toEqual([
      ["decide", "completed"], ["execute", "completed"], ["decide", "completed"], ["metacog", "completed"],
    ]);
    expect(test.seen.map(run => run.channel)).toEqual(["offline-decide", "offline-execute", "offline-decide", "offline-decide"]);
    expect(new Set(test.seen.map(run => run.channel)).size).toBe(2);
    expect(test.seen.map(run => run.contexts.length)).toEqual([prematureInput ? 2 : 1, 3, 1, 1]);
    for (const run of test.seen) {
      expect(run.contexts[0]?.messages).toHaveLength(1);
      expect(run.contexts[0]?.messages[0]?.role).toBe("user");
      expect(run.contexts[0]?.tools?.map(tool => tool.name) ?? []).toEqual(run.channel === "offline-execute" ? ["read", "write", "edit", "powershell"] : ["read"]);
      expect(JSON.stringify(run.contexts[0])).not.toContain(privateTurn);
      expect(JSON.stringify(run.contexts[0])).not.toContain("fixture-write");
    }
    expect(JSON.stringify(test.seen[1]!.contexts[2])).toContain(privateTurn);
    expect(test.events.filter(event => event.runtime?.type === "tool_end").map(event => [event.runtime?.mode, event.runtime?.toolName, event.runtime?.isError])).toEqual([
      ...(prematureInput ? [["decide", "read", false]] : []),
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
