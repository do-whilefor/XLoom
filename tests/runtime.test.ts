import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { PiRunner, RuntimeRunError, executeTools, parseFinalJson } from "../src/runtime/index.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { ChatSession, type ChatRequest } from "../src/runtime/chat.js";
import type { BoardSnapshot, ModelConfig, RunRequest, RuntimeEvent } from "../src/types.js";

const model: Model<"openai-completions"> = {
  id: "mock", name: "mock", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
};
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function request(mode: RunRequest["mode"] = "decide"): Promise<RunRequest> {
  const directory = await mkdtemp(join(tmpdir(), "xloom-runtime-test-"));
  dirs.push(directory);
  const snapshot: BoardSnapshot = {
    revision: 1, config: {
      version: 1, title: "Test", goal: "Inspect fixture", scope: "fixture", context: "Known context",
      models: { decide: { provider: "test", model: "decide", apiKeyEnv: "DO_NOT_EXPOSE_ENV_NAME" }, execute: { provider: "test", model: "execute" } },
      limits: { maxNoProgress: 2, maxMinutes: 5, maxTokens: 10000, maxCost: 10, maxTurnsPerRun: 3, stepTimeoutSeconds: 60, metacogEvery: 3 },
    }, status: "running", outcome: null, reason: "", goals: [], facts: [], steps: [], findings: [], evidence: [], hints: [],
    usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0,
  };
  return { id: `test-${directory}`, mode, snapshot, workspace: directory, runDir: join(directory, "run"), signal: new AbortController().signal, onEvent() {},
    step: mode === "execute" ? { id: "s1", goalId: "g1", from: [], description: "read fixture", successSignal: "read", evidencePlan: "save", priority: 1, status: "claimed", attempts: 1, runId: null, leaseUntil: null } : undefined };
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 0,
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } } };
}

function stream(response: string | ((context: Context) => AssistantMessage), seen: Context[] = []): StreamFn {
  return (_model, context) => {
    seen.push(JSON.parse(JSON.stringify(context)) as Context);
    const events = new AssistantMessageEventStream();
    const result = typeof response === "string" ? message([{ type: "text", text: response }]) : response(context);
    queueMicrotask(() => {
      events.push({ type: "start", partial: result });
      if (result.stopReason === "error" || result.stopReason === "aborted") events.push({ type: "error", reason: result.stopReason, error: result });
      else events.push({ type: "done", reason: result.stopReason as "stop" | "length" | "toolUse", message: result });
      events.end();
    });
    return events;
  };
}

describe("Pi runtime isolation", () => {
  it("creates fresh independent Agents with exact tool capabilities and uses Decide for metacog", async () => {
    const seen: Context[] = [];
    const options: AgentOptions[] = [];
    const selected: ModelConfig[] = [];
    const runner = new PiRunner({
      resolveModel: async (config) => { selected.push(config); return { model, streamFn: stream('{"summary":"only this run"}', seen) }; },
      createAgent: (entry) => { options.push(entry); return new Agent(entry); },
    });
    for (const mode of ["decide", "execute", "metacog"] as const) await runner.run(await request(mode));
    expect(selected.map((config) => config.model)).toEqual(["decide", "execute", "decide"]);
    expect(options.map((entry) => entry.initialState?.messages)).toEqual([[], [], []]);
    expect(options.map((entry) => entry.initialState?.tools?.map((tool) => tool.name))).toEqual(Array.from({ length: 3 }, () => ["read", "write", "edit", "powershell"]));
    expect(options.every((entry) => entry.toolExecution === "sequential" && !entry.beforeToolCall && !entry.afterToolCall)).toBe(true);
    expect(seen.every((context) => context.messages.length === 1 && context.messages[0].role === "user")).toBe(true);
    expect(seen.every((context) => !JSON.stringify(context).includes("only this run") && !JSON.stringify(context).includes("DO_NOT_EXPOSE_ENV_NAME"))).toBe(true);
  });

  it("only projects blackboard fields and keeps evidence excerpts", async () => {
    const input = await request();
    input.blackboardPath = join(input.workspace, "task-state", "blackboard.md");
    Object.assign(input.snapshot, { messages: [{ text: "SECRET_PRIOR_CHAT" }] });
    input.snapshot.evidence.push({ id: "e1", path: "artifact", sha256: "hash", bytes: 1, description: "brief", runId: "r0", stepId: "s0", excerpt: "original result" });
    const prompt = buildRunPrompt(input);
    expect(prompt.userPrompt).not.toContain("SECRET_PRIOR_CHAT");
    expect(prompt.userPrompt).not.toContain("DO_NOT_EXPOSE_ENV_NAME");
    expect(prompt.userPrompt).toContain("original result");
    expect(prompt.userPrompt).toContain("Resolve pending Steps");
    expect(prompt.userPrompt).toContain("synthetic narrative");
    expect(prompt.userPrompt).toContain("Priority is an integer 0–1000");
    expect(prompt.userPrompt).toContain("Never abandon the root Goal");
    expect(prompt.userPrompt).toContain("whole Goal is met");
    expect(JSON.parse(prompt.userPrompt.split("\n").at(-1)!)).toMatchObject({ blackboardFile: input.blackboardPath });
  });

  it.each(["decide", "metacog"] as const)("lets %s use Pi's native read without changing its JSON output contract", async mode => {
    const input = await request(mode);
    await writeFile(join(input.workspace, "public-evidence.txt"), "existing public evidence");
    let calls = 0;
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "decide-read", name: "read", arguments: { path: "public-evidence.txt" } }], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
      expect(JSON.stringify(context.messages.at(-1))).toContain("existing public evidence");
      return message([{ type: "text", text: '{"summary":"Inspected existing evidence; no new fact IDs invented"}' }]);
    }) }) });
    expect((await runner.run(input)).output).toEqual({ summary: "Inspected existing evidence; no new fact IDs invented" });
    expect(calls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", mode, toolName: "read", isError: false }));
  });

  it("also redacts the other channel's explicitly configured model key", async () => {
    vi.stubEnv("XLOOM_OTHER_CHANNEL_KEY", "other-channel-credential");
    const input = await request("decide");
    input.snapshot.config.models.execute.apiKeyEnv = "XLOOM_OTHER_CHANNEL_KEY";
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream('{"summary":"other-channel-credential"}') }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED]" });
    expect(await readFile(join(input.runDir, "events.jsonl"), "utf8")).not.toContain("other-channel-credential");
  });

  it("saves local transcript and output, counts cached tokens, and redacts known model credentials", async () => {
    const input = await request();
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream('{"summary":"credential-secret"}'), secrets: ["credential-secret"] }) });
    const result = await runner.run(input);
    expect(result.usage).toEqual({ input: 13, output: 4, cost: 0.02 });
    expect(result.output).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED]" });
    expect(await readFile(join(input.runDir, "events.jsonl"), "utf8")).not.toContain("credential-secret");
    expect(await readFile(join(input.runDir, "output.json"), "utf8")).toContain("MODEL_CREDENTIAL_REDACTED");
  });

  it("preserves consumed usage for invalid output errors", async () => {
    const input = await request();
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream("not json") }) });
    const error = await runner.run(input).catch((failure) => failure);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.usage.input).toBe(13);
    expect(error.message).toContain("single JSON object");
  });

  it("forwards message/tool order before awaiting transcript writes, even for a non-awaited event source", async () => {
    const input = await request();
    const observed: RuntimeEvent[] = [];
    input.onEvent = event => observed.push(event);
    let listener!: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
    const first = message([{ type: "thinking", thinking: "First message returned thought." },
      { type: "toolCall", id: "ordered-write", name: "write", arguments: { path: "fixture.txt", content: "fixture" } }], "toolUse");
    const second = message([{ type: "thinking", thinking: "Second message returned thought." }, { type: "text", text: '{"summary":"ordered result"}' }]);
    const source: AgentEvent[] = [
      { type: "message_start", message: first }, { type: "message_end", message: first },
      { type: "tool_execution_start", toolCallId: "ordered-write", toolName: "write", args: { path: "fixture.txt", content: "fixture" } },
      { type: "tool_execution_end", toolCallId: "ordered-write", toolName: "write", result: { content: [{ type: "text", text: "Synthetic tool result" }] }, isError: false },
      { type: "message_start", message: second }, { type: "message_end", message: second },
    ];
    const runner = new PiRunner({
      resolveModel: async () => ({ model, streamFn: stream('{"summary":"unused"}') }),
      createAgent: () => ({
        subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
        prompt: async () => {
          const pending = source.map(event => Promise.resolve(listener(event, input.signal)));
          // This assertion runs before any appendFile promise can complete.
          try { expect(observed.map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end", "usage", "tool_start", "tool_end", "thinking_start", "thinking", "thinking_end", "usage"]); }
          finally { await Promise.all(pending); }
        },
        abort() {}, waitForIdle: async () => {},
      }) as unknown as Agent,
    });
    const result = await runner.run(input);
    const starts = observed.filter(event => event.type === "thinking_start");
    expect(starts.map(event => event.blockId?.split(":").slice(-2))).toEqual([["1", "0"], ["2", "0"]]);
    expect(observed.filter(event => event.type === "thinking").map(event => event.text)).toEqual(["First message returned thought.", "Second message returned thought."]);
    expect(observed.filter(event => event.type === "thinking_end").map(event => event.blockId)).toEqual(starts.map(event => event.blockId));
    expect(result).toEqual({ output: { summary: "ordered result" }, usage: { input: 26, output: 8, cost: 0.04 } });
  });

  it("redacts credentials split across text streaming chunks", async () => {
    const input = await request();
    let rendered = "";
    input.onEvent = (event) => { if (event.type === "text") rendered += event.text; };
    const runner = new PiRunner({ resolveModel: async () => ({ model, secrets: ["credential-secret"], streamFn: () => {
      const events = new AssistantMessageEventStream();
      const result = message([{ type: "text", text: '{"summary":"credential-secret"}' }]);
      queueMicrotask(() => {
        events.push({ type: "start", partial: result });
        for (const delta of ['{"summary":"cred', 'ential-', 'secret"}']) events.push({ type: "text_delta", contentIndex: 0, delta, partial: result });
        events.push({ type: "done", reason: "stop", message: result });
        events.end();
      });
      return events;
    } }) });
    await runner.run(input);
    expect(rendered).not.toContain("credential-secret");
    expect(rendered).toContain("MODEL_CREDENTIAL_REDACTED");
  });

  it("does not treat a truncated response as a valid result", async () => {
    const input = await request();
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => message([{ type: "text", text: '{"summary":"truncated"}' }], "length")) }) });
    await expect(runner.run(input)).rejects.toThrow("length");
  });

  it("includes credentials refreshed by Pi after initial resolution in streaming and saved output redaction", async () => {
    const input = await request();
    const secrets = ["old-model-credential"];
    let rendered = "";
    input.onEvent = event => { if (event.type === "text") rendered += event.text; };
    const runner = new PiRunner({ resolveModel: async () => ({ model, secrets, streamFn: () => {
      secrets.push("new-refreshed-model-credential");
      const events = new AssistantMessageEventStream();
      const response = message([{ type: "text", text: '{"summary":"new-refreshed-model-credential old-model-credential"}' }]);
      queueMicrotask(() => {
        events.push({ type: "start", partial: response });
        for (const delta of ['{"summary":"new-refreshed-', 'model-credential old-model-', 'credential"}']) {
          events.push({ type: "text_delta", contentIndex: 0, delta, partial: response });
        }
        events.push({ type: "done", reason: "stop", message: response });
        events.end();
      });
      return events;
    } }) });
    const result = await runner.run(input);
    expect(result.output).toEqual({ summary: "[MODEL_CREDENTIAL_REDACTED] [MODEL_CREDENTIAL_REDACTED]" });
    expect(rendered).toContain("MODEL_CREDENTIAL_REDACTED");
    for (const secret of secrets) {
      expect(rendered).not.toContain(secret);
      expect(await readFile(join(input.runDir, "events.jsonl"), "utf8")).not.toContain(secret);
      expect(await readFile(join(input.runDir, "output.json"), "utf8")).not.toContain(secret);
    }
  });

  it("does not stop a Pi tool turn at disabled cumulative resource budgets", async () => {
    const input = await request("execute");
    input.snapshot.config.limits.maxTokens = null;
    input.snapshot.config.limits.maxCost = null;
    input.snapshot.usage = { input: 1_000_000, output: 100_000, cost: 100 };
    await writeFile(join(input.workspace, "fixture.txt"), "synthetic fixture");
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => ++calls === 1
      ? message([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "fixture.txt" } }], "toolUse")
      : message([{ type: "text", text: '{"summary":"tool result received","result":"done"}' }])) }) });
    expect((await runner.run(input)).output).toEqual({ summary: "tool result received", result: "done" });
    expect(calls).toBe(2);
  });

  it("rejects an already cancelled invocation before resolving the model", async () => {
    const input = await request();
    input.signal = AbortSignal.abort();
    let called = false;
    const runner = new PiRunner({ resolveModel: async () => { called = true; return { model, streamFn: stream("{}") }; } });
    await expect(runner.run(input)).rejects.toBeInstanceOf(RuntimeRunError);
    expect(called).toBe(false);
  });

  it("propagates live cancellation to Pi and waits for settlement", async () => {
    const input = await request();
    const abort = new AbortController();
    input.signal = abort.signal;
    let aborted = false;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: (_model, _context, options) => {
      const events = new AssistantMessageEventStream();
      const finish = () => { aborted = true; const failure = message([], "aborted"); events.push({ type: "error", reason: "aborted", error: failure }); events.end(); };
      options?.signal?.addEventListener("abort", finish, { once: true });
      queueMicrotask(() => abort.abort());
      return events;
    } }) });
    await expect(runner.run(input)).rejects.toBeInstanceOf(RuntimeRunError);
    expect(aborted).toBe(true);
  });

  it.each(["turns", "tokens", "cost"])("stops tool loops at the %s budget with partial usage retained", async (budget) => {
    const input = await request("execute");
    await writeFile(join(input.workspace, "fixture.txt"), "read me");
    if (budget === "turns") input.snapshot.config.limits.maxTurnsPerRun = 1;
    if (budget === "tokens") input.snapshot.config.limits.maxTokens = 15;
    if (budget === "cost") input.snapshot.config.limits.maxCost = 0.01;
    let calls = 0;
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream(() => { calls++; return message([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "fixture.txt" } }], "toolUse"); }) }) });
    const error = await runner.run(input).catch((failure) => failure);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("budget reached");
    expect(error.usage.input).toBe(13);
    expect(calls).toBe(1);
  });
});

describe("runtime protocol", () => {
  it("uses Pi's unmodified factory tool names", () => { expect(executeTools(process.cwd()).map((tool) => tool.name)).toEqual(["read", "write", "edit", "powershell"]); });
  it("accepts strict JSON or one JSON fence and rejects ambiguous output", () => {
    expect(parseFinalJson('{"summary":"ok"}')).toEqual({ summary: "ok" });
    expect(parseFinalJson('```json\n{"summary":"ok"}\n```')).toEqual({ summary: "ok" });
    for (const invalid of ["null", "[]", "1", "here: {}", "{} {}", '```json\n{}\n```\nextra']) expect(() => parseFinalJson(invalid)).toThrow();
  });
});

async function chatRequest(text = "first private chat message"): Promise<ChatRequest> {
  const input = await request();
  return { text, workspace: input.workspace, model: { provider: "test", model: "chat" }, limits: input.snapshot.config.limits, signal: input.signal, onEvent() {} };
}

async function thinkingHarness(kind: "chat" | "decide", streamFn: StreamFn, secrets: string[] = [], control?: AbortController, observe?: (event: RuntimeEvent) => void) {
  const input = await request();
  const events: RuntimeEvent[] = [];
  const agents: AgentOptions[] = [];
  input.onEvent = event => { events.push(event); observe?.(event); };
  if (control) input.signal = control.signal;
  const options = { resolveModel: async () => ({ model, streamFn, secrets }), createAgent: (entry: AgentOptions) => { agents.push(entry); return new Agent(entry); } };
  const completed = kind === "chat" ? new ChatSession(options).send({ text: "fixture", workspace: input.workspace, model: { provider: "test", model: "chat" }, limits: input.snapshot.config.limits, signal: input.signal, onEvent: input.onEvent })
    : new PiRunner(options).run(input);
  return { input, events, agents, completed };
}

function thinkingStream(response: AssistantMessage, chunks?: string[], noDeltas = false): StreamFn {
  return () => {
    const events = new AssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "start", partial: response });
      response.content.forEach((content, contentIndex) => {
        if (content.type === "thinking") {
          events.push({ type: "thinking_start", contentIndex, partial: response });
          if (!noDeltas) for (const delta of chunks ?? [content.thinking]) events.push({ type: "thinking_delta", contentIndex, delta, partial: response });
          events.push({ type: "thinking_end", contentIndex, content: content.thinking, partial: response });
        } else if (content.type === "text") events.push({ type: "text_delta", contentIndex, delta: content.text, partial: response });
      });
      events.push({ type: "done", reason: response.stopReason as "stop" | "toolUse", message: response });
      events.end();
    });
    return events;
  };
}

describe.each(["chat", "decide"] as const)("completed-message narration and reported usage in %s", kind => {
  const answer = kind === "chat" ? "The local fixture is verified." : '{"summary":"The local fixture is verified."}';
  const sumUsage = (events: RuntimeEvent[]) => events.filter(event => event.type === "usage").reduce((total, event) => ({
    input: total.input + event.usage!.input, output: total.output + event.usage!.output, cost: total.cost + event.usage!.cost,
  }), { input: 0, output: 0, cost: 0 });

  it("identifies one message across interleaved text, thoughts and narration without reusing IDs across rounds", async () => {
    let calls = 0;
    const test = await thinkingHarness(kind, (selected, context, options) => {
      const response = ++calls === 1 ? message([
        { type: "text", text: "I will inspect a local fixture." },
        { type: "thinking", thinking: "Provider-returned thought." },
        { type: "text", text: "I will keep the observed result." },
        { type: "toolCall", id: "id-write", name: "write", arguments: { path: "id-fixture.txt", content: "fixture" } },
      ], "toolUse") : message([
        { type: "thinking", thinking: "Next provider-returned thought." },
        { type: "text", text: answer },
      ]);
      return thinkingStream(response)(selected, context, options);
    });
    await test.completed;
    const boundary = test.events.findIndex(event => event.type === "tool_start");
    const belongsToMessage = (event: RuntimeEvent) => ["text", "narration", "thinking_start", "thinking", "thinking_end"].includes(event.type);
    const first = test.events.slice(0, boundary).filter(belongsToMessage);
    const second = test.events.slice(boundary).filter(belongsToMessage);
    expect(first.map(event => event.type)).toEqual(["text", "thinking_start", "thinking", "thinking_end", "text", "narration"]);
    expect(new Set(first.map(event => event.messageId)).size).toBe(1);
    expect(new Set(second.map(event => event.messageId)).size).toBe(1);
    expect(first[0]!.messageId).toEqual(expect.any(String));
    expect(second[0]!.messageId).toEqual(expect.any(String));
    expect(first[0]!.messageId).not.toBe(second[0]!.messageId);
  });

  it("emits actual pre-tool prose once and reports one usage event per assistant message, not per tool", async () => {
    let calls = 0;
    const narration = "I will write a local fixture and then read it back.";
    const test = await thinkingHarness(kind, stream(context => {
      if (++calls === 1) return message([
        { type: "text", text: narration },
        { type: "toolCall", id: "narration-write", name: "write", arguments: { path: "narration-fixture.txt", content: "LOCAL FIXTURE ONLY" } },
        { type: "toolCall", id: "narration-read", name: "read", arguments: { path: "narration-fixture.txt" } },
      ], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
      const response = message([{ type: "text", text: answer }]);
      response.usage = { input: 20, output: 6, cacheRead: 3, cacheWrite: 4, totalTokens: 33,
        cost: { input: 0.03, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.05 } };
      return response;
    }));
    const completed = await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([{ type: "narration", mode: kind, messageId: expect.any(String), text: narration }]);
    expect(test.events.filter(event => event.type === "usage")).toEqual([
      { type: "usage", mode: kind, text: "", usage: { input: 13, output: 4, cost: 0.02 } },
      { type: "usage", mode: kind, text: "", usage: { input: 27, output: 6, cost: 0.05 } },
    ]);
    expect(sumUsage(test.events)).toEqual("usage" in completed ? completed.usage : completed);
    expect(test.events.filter(event => event.type === "tool_start")).toHaveLength(2);
    expect(test.events.findIndex(event => event.type === "narration")).toBeLessThan(test.events.findIndex(event => event.type === "tool_start"));
    expect(test.events.findIndex(event => event.type === "usage")).toBeLessThan(test.events.findIndex(event => event.type === "tool_start"));
    expect(await readFile(join(test.input.workspace, "narration-fixture.txt"), "utf8")).toBe("LOCAL FIXTURE ONLY");
  });

  it.each([
    ["raw object", '{"summary":"machine protocol"}'],
    ["raw array", '[{"action":"read"}]'],
    ["JSON fence", '```json\n{"summary":"machine protocol"}\n```'],
    ["plain JSON fence", '```\n{"summary":"machine protocol"}\n```'],
    ["array JSON fence", '```json\n["machine protocol"]\n```'],
    ["raw JSON scalar", "42"],
    ["scalar JSON fence", '```json\n42\n```'],
  ])("does not turn %s into natural-language narration", async (_label, protocol) => {
    let calls = 0;
    const test = await thinkingHarness(kind, stream(() => ++calls === 1 ? message([
      { type: "text", text: protocol! },
      { type: "toolCall", id: "protocol-write", name: "write", arguments: { path: "protocol-fixture.txt", content: "fixture" } },
    ], "toolUse") : message([{ type: "text", text: answer }])));
    await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([]);
    expect(test.events.filter(event => event.type === "usage")).toHaveLength(2);
  });

  it("never invents pre-tool narration for a pure tool call or final JSON", async () => {
    let calls = 0;
    const finalJson = '{"summary":"Only structured final output"}';
    const test = await thinkingHarness(kind, stream(() => ++calls === 1 ? message([
      { type: "toolCall", id: "silent-write", name: "write", arguments: { path: "silent-fixture.txt", content: "fixture" } },
    ], "toolUse") : message([{ type: "text", text: finalJson }])));
    const completed = await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([]);
    expect(test.events.filter(event => event.type === "usage")).toHaveLength(2);
    expect(sumUsage(test.events)).toEqual("usage" in completed ? completed.usage : completed);
  });

  it("redacts known model credentials in actual streamed narration", async () => {
    let calls = 0;
    const test = await thinkingHarness(kind, (selected, context, options) => {
      const response = ++calls === 1 ? message([
        { type: "text", text: "I will inspect the fixture using credential-secret." },
        { type: "toolCall", id: "redacted-narration-write", name: "write", arguments: { path: "redacted-fixture.txt", content: "fixture" } },
      ], "toolUse") : message([{ type: "text", text: answer }]);
      return thinkingStream(response)(selected, context, options);
    }, ["credential-secret"]);
    await test.completed;
    expect(test.events.filter(event => event.type === "narration")).toEqual([
      { type: "narration", mode: kind, messageId: expect.any(String), text: "I will inspect the fixture using [MODEL_CREDENTIAL_REDACTED]." },
    ]);
    expect(JSON.stringify(test.events)).not.toContain("credential-secret");
  });

  it.each(["error", "aborted"] as const)("reports known usage for an assistant %s instead of inventing missing consumption", async stopReason => {
    const abort = new AbortController();
    let calls = 0;
    const test = await thinkingHarness(kind, (_model, _context, options) => {
      if (++calls === 1) return stream(() => message([
        { type: "toolCall", id: "usage-write", name: "write", arguments: { path: "usage-fixture.txt", content: "fixture" } },
      ], "toolUse"))(_model, _context, options);
      const output = new AssistantMessageEventStream();
      const failure = { ...message([], stopReason), errorMessage: "Synthetic provider interruption" };
      failure.usage = { input: 7, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: 13,
        cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
      const finish = () => { output.push({ type: "error", reason: stopReason, error: failure }); output.end(); };
      if (stopReason === "aborted") {
        options?.signal?.addEventListener("abort", finish, { once: true });
        queueMicrotask(() => abort.abort());
      } else queueMicrotask(finish);
      return output;
    }, [], abort);
    const failure = await test.completed.catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(test.events.filter(event => event.type === "usage")).toEqual([
      { type: "usage", mode: kind, text: "", usage: { input: 13, output: 4, cost: 0.02 } },
      { type: "usage", mode: kind, text: "", usage: { input: 12, output: 1, cost: 0.03 } },
    ]);
    expect(sumUsage(test.events)).toEqual(failure.usage);
    expect(test.events.filter(event => event.type === "narration")).toEqual([]);
  });
});

describe.each(["chat", "decide"] as const)("Pi-returned thinking in %s", kind => {
  const answer = kind === "chat" ? "Ordinary answer." : '{"summary":"Ordinary answer."}';

  it("forwards distinct thinking start/delta/end events without changing thinking settings or mixing answer text", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([
      { type: "thinking", thinking: "Actual provider-returned thought.", thinkingSignature: "OPAQUE_SIGNATURE_NOT_TEXT" },
      { type: "text", text: answer },
    ])));
    await test.completed;
    const thoughts = test.events.filter(event => event.type.startsWith("thinking"));
    expect(thoughts.map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end"]);
    expect(thoughts.map(event => event.text)).toEqual(["", "Actual provider-returned thought.", ""]);
    expect(thoughts.every(event => event.mode === kind && typeof event.blockId === "string")).toBe(true);
    expect(thoughts.every(event => !Object.hasOwn(event, "replayed"))).toBe(true);
    expect(new Set(thoughts.map(event => event.blockId)).size).toBe(1);
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join("")).toBe(answer);
    expect(JSON.stringify(test.events)).not.toContain("OPAQUE_SIGNATURE_NOT_TEXT");
    expect(test.agents[0]?.initialState?.thinkingLevel).toBe("off");
  });

  it("redacts model credentials split across thought chunks and does not duplicate the message-end fallback", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([
      { type: "thinking", thinking: "Analyze credential-secret privately." }, { type: "text", text: answer },
    ]), ["Analyze cred", "ential-", "secret privately."]), ["credential-secret"]);
    await test.completed;
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text).join("")).toBe("Analyze [MODEL_CREDENTIAL_REDACTED] privately.");
    expect(test.events.filter(event => event.type === "thinking_start")).toHaveLength(1);
    expect(test.events.filter(event => event.type === "thinking_end")).toHaveLength(1);
    expect(JSON.stringify(test.events)).not.toContain("credential-secret");
    if (kind === "decide") expect(await readFile(join(test.input.runDir, "events.jsonl"), "utf8")).not.toContain("credential-secret");
  });

  it("falls back only to actual non-redacted thinking returned in message_end", async () => {
    const test = await thinkingHarness(kind, stream(() => message([
      { type: "thinking", thinking: "MUST_NOT_EXPOSE_REDACTED_PAYLOAD", redacted: true, thinkingSignature: "OPAQUE_REDACTED_SIGNATURE" },
      { type: "thinking", thinking: "Actually returned credential-secret thought.", thinkingSignature: "OPAQUE_SIGNATURE" },
      { type: "thinking", thinking: "", thinkingSignature: "OPAQUE_ONLY" },
      { type: "text", text: answer },
    ])), ["credential-secret"]);
    await test.completed;
    expect(test.events.filter(event => event.type.startsWith("thinking")).map(event => [event.type, event.text])).toEqual([
      ["thinking_start", ""], ["thinking", "Actually returned [MODEL_CREDENTIAL_REDACTED] thought."], ["thinking_end", ""],
    ]);
    expect(test.events.filter(event => event.type.startsWith("thinking")).every(event => event.replayed === true)).toBe(true);
    expect(JSON.stringify(test.events)).not.toMatch(/OPAQUE|MUST_NOT_EXPOSE|credential-secret/);
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join("")).not.toContain("Actually returned");
  });

  it("handles providers that return thought content at thinking_end without delta events", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([{ type: "thinking", thinking: "Provider end-only thought." }, { type: "text", text: answer }]), undefined, true));
    await test.completed;
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text).join("")).toBe("Provider end-only thought.");
    expect(test.events.filter(event => event.type === "thinking_end")).toHaveLength(1);
  });

  it("suppresses streaming redacted thinking and never decodes signatures as text", async () => {
    const test = await thinkingHarness(kind, thinkingStream(message([
      { type: "thinking", thinking: "OPAQUE_REDACTED_DATA", redacted: true, thinkingSignature: "DO_NOT_DECODE" },
      { type: "text", text: answer },
    ])));
    await test.completed;
    expect(test.events.some(event => event.type.startsWith("thinking"))).toBe(false);
    expect(JSON.stringify(test.events)).not.toMatch(/OPAQUE_REDACTED_DATA|DO_NOT_DECODE/);
  });

  it("uses unique message/content-index block IDs across a native tool turn", async () => {
    let calls = 0;
    const fn: StreamFn = (selected, context, options) => thinkingStream(++calls === 1 ? message([
      { type: "thinking", thinking: "First block." }, { type: "thinking", thinking: "Second block." },
      { type: "toolCall", id: "thinking-write", name: "write", arguments: { path: "thought-fixture.txt", content: "fixture" } },
    ], "toolUse") : message([{ type: "thinking", thinking: "Next message block." }, { type: "text", text: answer }]))(selected, context, options);
    const test = await thinkingHarness(kind, fn);
    await test.completed;
    const starts = test.events.filter(event => event.type === "thinking_start");
    const ends = test.events.filter(event => event.type === "thinking_end");
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map(event => event.blockId)).size).toBe(3);
    expect(starts.map(event => event.blockId?.split(":").slice(-2))).toEqual([["1", "0"], ["1", "1"], ["2", "0"]]);
    expect(ends.map(event => event.blockId)).toEqual(starts.map(event => event.blockId));
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text)).toEqual(["First block.", "Second block.", "Next message block."]);
    const toolStart = test.events.findIndex(event => event.type === "tool_start");
    const toolEnd = test.events.findIndex(event => event.type === "tool_end");
    expect(test.events.indexOf(ends[1]!)).toBeLessThan(toolStart);
    expect(test.events.indexOf(starts[2]!)).toBeGreaterThan(toolEnd);
  });

  it("ends a streamed thought on provider error while retaining only returned content", async () => {
    const test = await thinkingHarness(kind, () => {
      const events = new AssistantMessageEventStream();
      const partial = message([{ type: "thinking", thinking: "Returned partial thought." }]);
      queueMicrotask(() => {
        events.push({ type: "start", partial });
        events.push({ type: "thinking_start", contentIndex: 0, partial });
        events.push({ type: "thinking_delta", contentIndex: 0, delta: "Returned partial thought.", partial });
        events.push({ type: "error", reason: "error", error: { ...message([], "error"), errorMessage: "Synthetic provider error" } });
        events.end();
      });
      return events;
    });
    const error = await test.completed.catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("Synthetic provider error");
    expect(test.events.filter(event => event.type.startsWith("thinking")).map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end"]);
    expect(test.events.filter(event => event.type === "thinking").map(event => event.text)).toEqual(["Returned partial thought."]);
    expect(test.events.filter(event => event.type === "text")).toEqual([]);
  });

  it("settles an open thought when cancelled and does not invent answer text or a completion", async () => {
    const abort = new AbortController();
    const test = await thinkingHarness(kind, (_model, _context, options) => {
      const events = new AssistantMessageEventStream();
      const partial = message([{ type: "thinking", thinking: "Thought before cancellation." }]);
      options?.signal?.addEventListener("abort", () => {
        events.push({ type: "error", reason: "aborted", error: message([], "aborted") }); events.end();
      }, { once: true });
      queueMicrotask(() => {
        events.push({ type: "start", partial });
        events.push({ type: "thinking_start", contentIndex: 0, partial });
        events.push({ type: "thinking_delta", contentIndex: 0, delta: "Thought before cancellation.", partial });
      });
      return events;
    }, [], abort, event => { if (event.type === "thinking") abort.abort(); });
    await expect(test.completed).rejects.toBeInstanceOf(RuntimeRunError);
    expect(test.events.filter(event => event.type.startsWith("thinking")).map(event => event.type)).toEqual(["thinking_start", "thinking", "thinking_end"]);
    expect(test.events.filter(event => event.type === "text")).toEqual([]);
    expect(test.events.filter(event => event.type === "thinking_end")[0]?.blockId).toBe(test.events[0]?.blockId);
  });
});

describe("private Pi chat session", () => {
  it("retains ordinary chat history, streams natural text and counts each response's usage", async () => {
    const input = await chatRequest();
    const seen: Context[] = [];
    const events: RuntimeEvent[] = [];
    const agents: AgentOptions[] = [];
    input.onEvent = event => events.push(event);
    let resolves = 0;
    const session = new ChatSession({
      resolveModel: async () => { resolves++; return { model, streamFn: stream("A natural language reply, not JSON.", seen) }; },
      createAgent: options => { agents.push(options); return new Agent(options); },
    });
    expect(await session.send(input)).toEqual({ input: 13, output: 4, cost: 0.02 });
    expect(await session.send({ ...input, text: "second message" })).toEqual({ input: 13, output: 4, cost: 0.02 });
    expect(resolves).toBe(2);
    expect(agents).toHaveLength(1);
    expect(agents[0].initialState?.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell"]);
    expect(agents[0].beforeToolCall).toBeUndefined();
    expect(agents[0].afterToolCall).toBeUndefined();
    expect(seen.map(context => context.messages.length)).toEqual([1, 3]);
    expect(JSON.stringify(seen[1])).toContain("first private chat message");
    expect(JSON.stringify(seen[1])).toContain("A natural language reply, not JSON.");
    expect(seen[0].systemPrompt).not.toContain("Return one JSON object");
    expect(events.filter(event => event.type === "text")).toEqual([
      { type: "text", mode: "chat", messageId: expect.any(String), text: "A natural language reply, not JSON." },
      { type: "text", mode: "chat", messageId: expect.any(String), text: "A natural language reply, not JSON." },
    ]);
  });

  it("executes native tools in a continuing chat without creating a red-team blackboard", async () => {
    const input = await chatRequest("Write and inspect a synthetic fixture");
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    let calls = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(context => {
      if (++calls === 1) return message([{ type: "toolCall", id: "chat-write", name: "write", arguments: { path: "chat-fixture.txt", content: "chat-only fixture" } }], "toolUse");
      if (calls === 2) return message([{ type: "toolCall", id: "chat-read", name: "read", arguments: { path: "chat-fixture.txt" } }], "toolUse");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
      expect(JSON.stringify(context.messages.at(-1))).toContain("chat-only fixture");
      return message([{ type: "text", text: "The fixture is written and verified." }]);
    }) }) });
    expect(await session.send(input)).toEqual({ input: 39, output: 12, cost: 0.06 });
    expect(await readFile(join(input.workspace, "chat-fixture.txt"), "utf8")).toBe("chat-only fixture");
    expect(events.filter(event => event.type === "tool_end").map(event => [event.mode, event.toolName])).toEqual([["chat", "write"], ["chat", "read"]]);
    await expect(readFile(join(input.workspace, "state", "blackboard.md"))).rejects.toThrow();
  });

  it("never hands private chat history to the two-agent runner", async () => {
    const input = await chatRequest();
    const contexts: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream("PRIVATE_CHAT_REPLY", contexts) }) });
    await session.send(input);
    const redteam: Context[] = [];
    const runner = new PiRunner({ resolveModel: async () => ({ model, streamFn: stream('{"summary":"public board only"}', redteam) }) });
    for (const mode of ["decide", "execute", "metacog"] as const) await runner.run(await request(mode));
    expect(redteam.every(context => context.messages.length === 1)).toBe(true);
    for (const privateText of [input.text, "PRIVATE_CHAT_REPLY"]) expect(JSON.stringify(redteam)).not.toContain(privateText);
  });

  it.each(["reset", "model", "workspace"])("starts a fresh transcript after %s changes", async kind => {
    const input = await chatRequest();
    const seen: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream("old private answer", seen) }) });
    await session.send(input);
    const next = { ...input, text: "new task" };
    if (kind === "reset") session.reset();
    if (kind === "model") next.model = { ...input.model, model: "different-model" };
    if (kind === "workspace") next.workspace = (await chatRequest()).workspace;
    await session.send(next);
    expect(seen.map(context => context.messages.length)).toEqual([1, 1]);
    expect(JSON.stringify(seen[1])).not.toContain(input.text);
    expect(JSON.stringify(seen[1])).not.toContain("old private answer");
  });

  it("rejects pre-cancelled messages before model resolution", async () => {
    const resolver = vi.fn();
    const session = new ChatSession({ resolveModel: resolver });
    await expect(session.send({ ...await chatRequest(), signal: AbortSignal.abort() })).rejects.toBeInstanceOf(RuntimeRunError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["abort", "reset", "timeout"])("propagates %s to the active Pi reply and permits a later fresh request", async kind => {
    const input = await chatRequest();
    const control = new AbortController();
    input.signal = control.signal;
    if (kind === "timeout") input.limits.stepTimeoutSeconds = 0.005;
    let didAbort = false;
    let calls = 0;
    let session: ChatSession;
    session = new ChatSession({ resolveModel: async () => ({ model, streamFn: (_model, _context, options) => {
      if (++calls > 1) return stream("After cancellation")(_model, _context, options);
      const events = new AssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        didAbort = true;
        events.push({ type: "error", reason: "aborted", error: message([], "aborted") });
        events.end();
      }, { once: true });
      queueMicrotask(() => {
        if (kind === "abort") control.abort();
        if (kind === "reset") session.reset();
      });
      return events;
    } }) });
    const failure = await session.send(input).catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    if (kind === "timeout") expect(failure.message).toContain("timed out");
    expect(didAbort).toBe(true);
    session.reset();
    expect(await session.send({ ...input, signal: new AbortController().signal, limits: { ...input.limits, stepTimeoutSeconds: 60 } })).toEqual({ input: 13, output: 4, cost: 0.02 });
  });

  it("rejects simultaneous chat sends without injecting them into the active history", async () => {
    const input = await chatRequest();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const seen: Context[] = [];
    const session = new ChatSession({ resolveModel: async () => { await waiting; return { model, streamFn: stream("done", seen) }; } });
    const active = session.send(input);
    await expect(session.send({ ...input, text: "MUST_NOT_ENTER_HISTORY" })).rejects.toThrow("already running");
    release();
    await active;
    expect(JSON.stringify(seen)).not.toContain("MUST_NOT_ENTER_HISTORY");
  });

  it.each(["turns", "tokens", "cost"])("settles chat tool loops at the %s reply budget and keeps partial usage", async budget => {
    const input = await chatRequest();
    if (budget === "turns") input.limits.maxTurnsPerRun = 1;
    if (budget === "tokens") input.limits.maxTokens = 15;
    if (budget === "cost") input.limits.maxCost = 0.01;
    await writeFile(join(input.workspace, "fixture.txt"), "fixture");
    let calls = 0;
    const session = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => {
      calls++;
      return message([{ type: "toolCall", id: "chat-bounded-read", name: "read", arguments: { path: "fixture.txt" } }], "toolUse");
    }) }) });
    const error = await session.send(input).catch(error => error);
    expect(error).toBeInstanceOf(RuntimeRunError);
    expect(error.message).toContain("budget reached");
    expect(error.usage).toEqual({ input: 13, output: 4, cost: 0.02 });
    expect(calls).toBe(1);
  });

  it("redacts refreshed credentials across streaming chunks and user input", async () => {
    const input = await chatRequest("Check credential-secret");
    const events: RuntimeEvent[] = [];
    input.onEvent = event => events.push(event);
    const secrets = ["credential-secret"];
    const session = new ChatSession({ resolveModel: async () => ({ model, secrets, streamFn: (_model, context) => {
      expect(JSON.stringify(context)).not.toContain("credential-secret");
      secrets.push("refreshed-credential-secret");
      const result = message([{ type: "text", text: "credential-secret refreshed-credential-secret" }]);
      const output = new AssistantMessageEventStream();
      queueMicrotask(() => {
        output.push({ type: "start", partial: result });
        for (const delta of ["credential-", "secret refreshed-cred", "ential-secret"]) output.push({ type: "text_delta", contentIndex: 0, delta, partial: result });
        output.push({ type: "done", reason: "stop", message: result });
        output.end();
      });
      return output;
    } }) });
    await session.send(input);
    const rendered = events.filter(event => event.type === "text").map(event => event.text).join("");
    expect(rendered).toBe("[MODEL_CREDENTIAL_REDACTED] [MODEL_CREDENTIAL_REDACTED]");
  });

  it("redacts explicit credential resolver failures and keeps provider-failure usage", async () => {
    vi.stubEnv("CHAT_TEST_TOKEN", "chat-explicit-test-key");
    const input = await chatRequest();
    input.model.apiKeyEnv = "CHAT_TEST_TOKEN";
    const broken = new ChatSession({ resolveModel: async () => { throw new Error("invalid chat-explicit-test-key"); } });
    const resolutionError = await broken.send(input).catch(error => error);
    expect(resolutionError.message).toBe("invalid [MODEL_CREDENTIAL_REDACTED]");
    expect(resolutionError.usage).toEqual({ input: 0, output: 0, cost: 0 });
    const failed = new ChatSession({ resolveModel: async () => ({ model, streamFn: stream(() => ({ ...message([], "error"), errorMessage: "Provider rejected chat-explicit-test-key" })) }) });
    const providerError = await failed.send(input).catch(error => error);
    expect(providerError.message).toBe("Provider rejected [MODEL_CREDENTIAL_REDACTED]");
    expect(providerError.usage).toEqual({ input: 13, output: 4, cost: 0.02 });
  });
});
