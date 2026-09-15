import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { ChatSession, PiRunner, RuntimeRunError } from "../src/runtime/index.js";
import type { BoardSnapshot, ProjectConfig, RunRequest, RuntimeEvent, Usage } from "../src/types.js";

type Kind = "chat" | "execute" | "decide";
const model: Model<"openai-completions"> = {
  id: "budget-fixture", name: "budget-fixture", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
};
const directories: string[] = [];
const once: Usage = { input: 13, output: 4, cost: 0.02, cacheRead: 2, cacheInput: 13 };
const twice: Usage = { input: 26, output: 8, cost: 0.04, cacheRead: 4, cacheInput: 26 };
const fixture = "Synthetic local fixture; no external target or network request.";

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    // Recursive cleanup is confined to the exact temporary directories created here.
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^xloom-budget-test-/);
    await rm(directory, { recursive: true, force: true });
  }
});

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 0,
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } } };
}
function write(path = "fixture.txt", content = fixture, id = "fixture-write"): AssistantMessage {
  return message([{ type: "toolCall", id, name: "write", arguments: { path, content } }], "toolUse");
}
function fixtureTool(kind: Kind, path = "fixture.txt", content = fixture, id = "fixture-tool"): AssistantMessage {
  return kind === "decide" ? message([{ type: "toolCall", id, name: "read", arguments: { path: "source.txt" } }], "toolUse") : write(path, content, id);
}
const availableTools = (kind: Kind) => kind === "decide" ? ["read", "submit"] : ["read", "write", "edit", "powershell", "chrome", ...(kind === "execute" ? ["submit"] : [])];
const observedFixture = (kind: Kind, workspace: string, path = "fixture.txt") => join(workspace, kind === "decide" ? "source.txt" : path);
function answer(kind: Kind): AssistantMessage {
  return message([{ type: "text", text: kind === "chat" ? "The local fixture is verified."
    : JSON.stringify({ summary: "The local fixture is verified.", ...(kind === "execute" ? { result: "done" } : {}) }) }]);
}

async function harness(kind: Kind, response: (context: Context, call: number) => AssistantMessage,
  overrides: Partial<ProjectConfig["limits"]> = {}, selectedModel = model) {
  const workspace = await mkdtemp(join(tmpdir(), "xloom-budget-test-"));
  directories.push(workspace);
  if (kind === "decide") await writeFile(join(workspace, "source.txt"), fixture);
  const abort = new AbortController();
  const seen: Context[] = [];
  const events: RuntimeEvent[] = [];
  const config: ProjectConfig = {
    version: 1, title: "Offline budget regression", goal: "Inspect local fixture", scope: "Temporary local files only", context: "Synthetic fixture",
    models: { decide: { provider: "test", model: "budget-fixture" }, execute: { provider: "test", model: "budget-fixture" } },
    limits: { maxNoProgress: 2, maxMinutes: null, maxTokens: null, maxCost: null, maxTurnsPerRun: 2,
      stepTimeoutSeconds: 30, metacogEvery: 3, ...overrides },
  };
  const snapshot: BoardSnapshot = { revision: 1, config, status: "running", outcome: null, reason: "", goals: [], facts: [], steps: [],
    findings: [], evidence: [], hints: [], usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0 };
  const input: RunRequest = { id: "offline-budget", mode: kind === "chat" ? "decide" : kind, snapshot, workspace,
    runDir: join(workspace, "run"), signal: abort.signal, onEvent: event => events.push(event),
    ...(kind === "execute" ? { step: { id: "s1", goalId: "g1", from: [], description: "Write and inspect the local fixture", successSignal: "Fixture preserved",
      evidencePlan: "Local fixture only", priority: 1, status: "claimed" as const, attempts: 1, runId: null, leaseUntil: null } } : {}) };
  const streamFn: StreamFn = (_model, context) => {
    seen.push(JSON.parse(JSON.stringify(context)) as Context);
    const result = response(context, seen.length);
    const output = new AssistantMessageEventStream();
    queueMicrotask(() => {
      output.push({ type: "start", partial: result });
      if (result.stopReason === "error" || result.stopReason === "aborted") output.push({ type: "error", reason: result.stopReason, error: result });
      else output.push({ type: "done", reason: result.stopReason as "stop" | "length" | "toolUse", message: result });
      output.end();
    });
    return output;
  };
  let agentsCreated = 0;
  const options = { resolveModel: async () => ({ model: selectedModel, streamFn }), createAgent: (entry: AgentOptions) => { agentsCreated++; return new Agent(entry); } };
  const session = new ChatSession(options);
  const runner = new PiRunner(options);
  return {
    input, abort, seen, events, workspace, config,
    get agentsCreated() { return agentsCreated; },
    async run(): Promise<Usage> {
      if (kind === "chat") return session.send({ text: "Verify the local fixture.", workspace, model: config.models.decide,
        limits: config.limits, signal: input.signal, onEvent: input.onEvent });
      return (await runner.run(input)).usage;
    },
  };
}

describe.each(["chat", "execute", "decide"] as const)("reserved reporting turn in %s", kind => {
  it("counts context summaries in the request cap and preserves the final tool-free report", async () => {
    let summaries = 0;
    const test = await harness(kind, (context, call) => {
      if (context.systemPrompt?.startsWith("Summarize the older conversation")) {
        summaries++;
        return message([{ type: "text", text: "Previous reads completed; use source.txt for original evidence." }]);
      }
      if (!context.tools?.length) return answer(kind);
      return message([{ type: "toolCall", id: `read-${call}`, name: "read", arguments: { path: "source.txt" } }], "toolUse");
    }, { maxTurnsPerRun: 8 }, { ...model, contextWindow: 64000 });
    await writeFile(join(test.workspace, "source.txt"), "synthetic observation ".repeat(2000));
    const usage = await test.run();
    expect(summaries).toBeGreaterThan(0);
    expect(test.seen).toHaveLength(8);
    expect(test.seen.at(-1)?.tools).toEqual([]);
    expect(test.seen.at(-1)?.systemPrompt).not.toContain("Summarize the older conversation");
    expect(usage.input).toBe(8 * once.input);
    expect(usage.output).toBe(8 * once.output);
    expect(test.events.filter(event => event.type === "tool_start")).toHaveLength(7 - summaries);
  });

  it("keeps tools available beyond the old twelve-turn cap with unlimited input/output usage", async () => {
    const test = await harness(kind, (context, call) => {
      expect(context.tools?.map(tool => tool.name)).toEqual(availableTools(kind));
      expect(context.systemPrompt).not.toContain("final allowed model turn");
      return call <= 14 ? fixtureTool(kind, `fixture-${call}.txt`, fixture, `fixture-${call}`) : answer(kind);
    }, { maxTurnsPerRun: null, maxTokens: null, maxCost: null });
    test.input.snapshot.usage = { input: 1_000_000_000, output: 1_000_000_000, cost: 0 };
    expect(await test.run()).toEqual({ input: once.input * 15, output: once.output * 15, cost: expect.closeTo(once.cost * 15), cacheRead: 30, cacheInput: 195 });
    expect(test.seen).toHaveLength(15);
    expect(test.events.filter(event => event.type === "tool_end" && !event.isError)).toHaveLength(14);
    expect(await readFile(observedFixture(kind, test.workspace, "fixture-14.txt"), "utf8")).toBe(fixture);
  });

  it("still honors cancellation when the model-turn cap is disabled", async () => {
    const test = await harness(kind, () => fixtureTool(kind), { maxTurnsPerRun: null, maxTokens: null });
    test.input.onEvent = event => { if (event.type === "tool_end") test.abort.abort(); };
    const error = await test.run().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.usage).toEqual(once);
    expect(test.seen).toHaveLength(1);
    expect(await readFile(observedFixture(kind, test.workspace), "utf8")).toBe(fixture);
  });

  it("preserves the first role-appropriate tool result before the final tool-free turn", async () => {
    const test = await harness(kind, (context, call) => {
      if (call === 1) {
        expect(context.tools?.map(tool => tool.name)).toEqual(availableTools(kind));
        return fixtureTool(kind);
      }
      expect(context.tools).toEqual([]);
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: kind === "decide" ? "read" : "write", toolCallId: "fixture-tool", isError: false });
      expect(context.systemPrompt).toContain("final allowed model turn");
      return answer(kind);
    });
    expect(await test.run()).toEqual(twice);
    expect(test.seen).toHaveLength(2);
    expect(test.agentsCreated).toBe(1);
    expect(test.events.filter(event => event.type === "tool_start")).toHaveLength(1);
    expect(test.events.filter(event => event.type === "tool_end")).toMatchObject([{ toolName: kind === "decide" ? "read" : "write", isError: false }]);
    expect(await readFile(observedFixture(kind, test.workspace), "utf8")).toBe(fixture);
  });

  it("uses no tools when only one model turn is allowed", async () => {
    const test = await harness(kind, context => {
      expect(context.tools).toEqual([]);
      expect(context.systemPrompt).toContain("final allowed model turn");
      return answer(kind);
    }, { maxTurnsPerRun: 1 });
    expect(await test.run()).toEqual(once);
    expect(test.seen).toHaveLength(1);
    expect(test.events.filter(event => event.type === "tool_start")).toEqual([]);
    await expect(readFile(join(test.workspace, "fixture.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a hallucinated tool at a one-turn limit without writing anything", async () => {
    const test = await harness(kind, () => write(), { maxTurnsPerRun: 1 });
    const error = await test.run().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("maxTurnsPerRun=1");
    expect(error.usage).toEqual(once);
    expect(test.seen).toHaveLength(1);
    expect(test.events.filter(event => event.type === "tool_end")).toMatchObject([{ isError: true }]);
    await expect(readFile(join(test.workspace, "fixture.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a hallucinated final write without replaying or overwriting the prior side effect", async () => {
    const test = await harness(kind, (context, call) => {
      if (call === 1) return fixtureTool(kind);
      expect(context.tools).toEqual([]);
      return write("fixture.txt", "MUST NOT OVERWRITE THE EXISTING FIXTURE", "forbidden-final-write");
    });
    const error = await test.run().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("maxTurnsPerRun=2");
    expect(error.usage).toEqual(twice);
    expect(test.seen).toHaveLength(2);
    expect(test.events.filter(event => event.type === "tool_end")).toMatchObject([{ isError: false }, { isError: true }]);
    expect(await readFile(observedFixture(kind, test.workspace), "utf8")).toBe(fixture);
    if (kind === "decide") await expect(readFile(join(test.workspace, "fixture.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["tokens", "cost"] as const)("does not enter the reporting turn after reaching the %s limit", async resource => {
    const test = await harness(kind, () => fixtureTool(kind), resource === "tokens" ? { maxTokens: 15 } : { maxCost: 0.01 });
    const error = await test.run().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain(resource === "tokens" ? "maxTokens=15" : "maxCost=0.01");
    expect(error.usage).toEqual(once);
    expect(test.seen).toHaveLength(1);
    expect(await readFile(observedFixture(kind, test.workspace), "utf8")).toBe(fixture);
  });

  it("keeps both turns' usage and the existing fixture when the final provider response fails", async () => {
    const test = await harness(kind, (_context, call) => call === 1 ? fixtureTool(kind)
      : { ...message([], "error"), errorMessage: "Synthetic final provider failure" });
    const error = await test.run().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("Synthetic final provider failure");
    expect(error.usage).toEqual(twice);
    expect(test.seen).toHaveLength(2);
    expect(await readFile(observedFixture(kind, test.workspace), "utf8")).toBe(fixture);
  });

  it("does not spend a reserved turn after an early normal final response", async () => {
    const test = await harness(kind, () => answer(kind));
    expect(await test.run()).toEqual(once);
    expect(test.seen).toHaveLength(1);
    expect(test.events.filter(event => event.type === "tool_start")).toEqual([]);
  });

  it("honors cancellation after the completed tool without entering the reporting turn", async () => {
    const test = await harness(kind, () => fixtureTool(kind));
    test.input.onEvent = event => {
      test.events.push(event);
      if (event.type === "tool_end") test.abort.abort(new Error("Synthetic cancellation after local write"));
    };
    const error = await test.run().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.usage).toEqual(once);
    expect(test.seen).toHaveLength(1);
    expect(await readFile(observedFixture(kind, test.workspace), "utf8")).toBe(fixture);
  });
});

describe.each(["execute", "decide"] as const)("invalid final protocol in %s", kind => {
  it("retains both turns' usage and artifacts when the final response is not JSON", async () => {
    const test = await harness(kind, (_context, call) => call === 1 ? fixtureTool(kind) : message([{ type: "text", text: "Not the required JSON object." }]));
    const error = await test.run().catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("single JSON object");
    expect(error.usage).toEqual(twice);
    expect(test.seen).toHaveLength(2);
    expect(await readFile(observedFixture(kind, test.workspace), "utf8")).toBe(fixture);
    await expect(readFile(join(test.input.runDir, "output.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("chat budget state across replies", () => {
  it.each([1, 2])("restores tools and the turn counter after a reply limited to %i turns", async firstLimit => {
    let secondReply = false;
    let secondCalls = 0;
    const test = await harness("chat", (context, call) => {
      if (!secondReply) return firstLimit === 2 && call === 1 ? write("first.txt") : answer("chat");
      if (++secondCalls === 1) {
        expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell", "chrome"]);
        expect(context.systemPrompt).not.toContain("This is the final allowed model turn");
        return write("second.txt", fixture, "second-reply-write");
      }
      expect(context.tools).toEqual([]);
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "second-reply-write", isError: false });
      return answer("chat");
    }, { maxTurnsPerRun: firstLimit });
    expect(await test.run()).toEqual(firstLimit === 1 ? once : twice);
    secondReply = true;
    test.config.limits.maxTurnsPerRun = 2;
    expect(await test.run()).toEqual(twice);
    expect(test.agentsCreated).toBe(1);
    expect(secondCalls).toBe(2);
    expect(test.seen).toHaveLength(firstLimit + 2);
    expect(await readFile(join(test.workspace, "second.txt"), "utf8")).toBe(fixture);
  });
});
