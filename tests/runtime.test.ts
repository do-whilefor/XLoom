import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { PiRunner, RuntimeRunError, executeTools, parseFinalJson } from "../src/runtime/index.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import type { BoardSnapshot, ModelConfig, RunRequest } from "../src/types.js";

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
    expect(options.map((entry) => entry.initialState?.tools?.map((tool) => tool.name))).toEqual([[], ["read", "write", "edit", "powershell"], []]);
    expect(options.every((entry) => entry.toolExecution === "sequential" && !entry.beforeToolCall && !entry.afterToolCall)).toBe(true);
    expect(seen.every((context) => context.messages.length === 1 && context.messages[0].role === "user")).toBe(true);
    expect(seen.every((context) => !JSON.stringify(context).includes("only this run") && !JSON.stringify(context).includes("DO_NOT_EXPOSE_ENV_NAME"))).toBe(true);
  });

  it("only projects blackboard fields and keeps evidence excerpts", async () => {
    const input = await request();
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
