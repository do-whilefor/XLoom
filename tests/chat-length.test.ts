import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.js";
import { ChatSession, type ChatRequest } from "../src/runtime/chat.js";
import { RuntimeRunError } from "../src/runtime/pi-runner.js";
import type { RuntimeEvent } from "../src/types.js";

const model: Model<"openai-completions"> = {
  id: "chat-length", name: "chat-length", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_000,
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^xloom-chat-length-/);
    await rm(directory, { recursive: true, force: true });
  }
});
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } } };
}
const text = (value: string, stopReason: AssistantMessage["stopReason"] = "stop") => message([{ type: "text", text: value }], stopReason);
const networkFailure = () => ({ ...message([], "error"), errorMessage: "503 temporarily unavailable" });

async function harness(produce: (context: Context, call: number) => AssistantMessage) {
  const workspace = await mkdtemp(join(tmpdir(), "xloom-chat-length-"));
  directories.push(workspace);
  const abort = new AbortController();
  const seen: Context[] = [];
  const events: RuntimeEvent[] = [];
  const streamFn: StreamFn = (selected, context, options) => {
    expect(selected.maxTokens).toBe(model.maxTokens);
    expect(options?.maxTokens).toBeUndefined();
    seen.push(JSON.parse(JSON.stringify(context)) as Context);
    const response = produce(context, seen.length);
    const output = new AssistantMessageEventStream();
    queueMicrotask(() => {
      output.push({ type: "start", partial: response });
      response.content.forEach((part, contentIndex) => {
        if (part.type === "text") output.push({ type: "text_delta", contentIndex, delta: part.text, partial: response });
        if (part.type === "thinking") output.push({ type: "thinking_delta", contentIndex, delta: part.thinking, partial: response });
      });
      if (response.stopReason === "error" || response.stopReason === "aborted") output.push({ type: "error", reason: response.stopReason, error: response });
      else output.push({ type: "done", reason: response.stopReason as "stop" | "length" | "toolUse", message: response });
      output.end();
    });
    return output;
  };
  const session = new ChatSession({ resolveModel: async () => ({ model, streamFn }) });
  const input: ChatRequest = { text: "Explain the synthetic local fixture.", workspace, model: { provider: "test", model: model.id },
    limits: defaultConfig("chat length fixture").limits, signal: abort.signal, onEvent: event => events.push(event) };
  return { input, seen, events, abort, workspace, run: () => session.send(input) };
}

describe("chat continuation after provider output limits", () => {
  it.each(([[], [{ type: "text", text: " " }], [{ type: "thinking", thinking: "" }]] as AssistantMessage["content"][]).map(content => ({ content })))(
    "stops empty length output without spending unlimited requests (%j)", async ({ content }) => {
      const test = await harness(() => message(content, "length"));
      test.input.limits.maxTurnsPerRun = null;
      await expect(test.run()).rejects.toThrow("empty length response");
      expect(test.seen).toHaveLength(1);
      expect(test.events.filter(event => event.type === "usage")).toHaveLength(1);
    });
  it.each(["thinking", "text"] as const)("retains a %s-only length response and streams only the remaining reply", async kind => {
    const first = kind === "thinking" ? message([{ type: "thinking", thinking: "Private fixture reasoning remains unfinished." }], "length") : text("The fixture has ", "length");
    const test = await harness((context, call) => {
      if (call === 1) {
        expect(context.messages).toHaveLength(1);
        expect(context.systemPrompt).not.toContain("output limit");
        return first;
      }
      expect(context.messages[1]).toMatchObject(first);
      expect(context.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("output only the remaining content") }] });
      return text(kind === "thinking" ? "The fixture is synthetic." : "synthetic data.");
    });
    expect(await test.run()).toEqual({ input: 6, output: 2, cost: 0.04, cacheRead: 2, cacheInput: 6 });
    expect(test.seen).toHaveLength(2);
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join(""))
      .toBe(kind === "thinking" ? "The fixture is synthetic." : "The fixture has synthetic data.");
    expect(test.events.filter(event => event.type === "usage")).toHaveLength(2);
  });

  it("continues through four consecutive length responses without a continuation-count cap", async () => {
    const parts = ["First", ", second", ", third", ", fourth", ", finished."];
    const test = await harness((context, call) => {
      for (const part of parts.slice(0, call - 1)) expect(JSON.stringify(context.messages)).toContain(part);
      return text(parts[call - 1], call <= 4 ? "length" : "stop");
    });
    expect(await test.run()).toEqual({ input: 15, output: 5, cost: 0.1, cacheRead: 5, cacheInput: 15 });
    expect(test.seen).toHaveLength(5);
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join("")).toBe(parts.join(""));
    expect(test.events.filter(event => event.type === "usage")).toHaveLength(5);
  });

  it("keeps a completed write and its result exactly once across repeated continuation requests", async () => {
    const test = await harness((context, call) => {
      if (call === 1) return message([{ type: "toolCall", id: "write-once", name: "write", arguments: { path: "fixture.txt", content: "completed fixture" } }], "toolUse");
      expect(context.messages.filter(item => item.role === "toolResult")).toHaveLength(1);
      expect(context.messages.find(item => item.role === "toolResult")).toMatchObject({ toolCallId: "write-once", isError: false });
      return text(call === 2 ? "The fixture " : call === 3 ? "was written " : "once.", call < 4 ? "length" : "stop");
    });
    expect(await test.run()).toEqual({ input: 12, output: 4, cost: 0.08, cacheRead: 4, cacheInput: 12 });
    expect(test.events.filter(event => event.type === "tool_start" && event.toolName === "write")).toHaveLength(1);
    expect(test.events.filter(event => event.type === "tool_end" && event.toolName === "write")).toHaveLength(1);
    expect(await readFile(join(test.workspace, "fixture.txt"), "utf8")).toBe("completed fixture");
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join("")).toBe("The fixture was written once.");
  });

  it("leaves Pi's rejection of a truncated tool batch intact", async () => {
    const test = await harness((context, call) => {
      if (call === 1) return message([{ type: "toolCall", id: "truncated-write", name: "write", arguments: { path: "must-not-exist.txt", content: "partial" } }], "length");
      expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "truncated-write", isError: true });
      return text("The truncated tool was not executed.");
    });
    await test.run();
    expect(test.seen).toHaveLength(2);
    expect(await readdir(test.workspace)).toEqual([]);
    expect(test.events.filter(event => event.type === "tool_end" && event.toolName === "write" && !event.isError)).toEqual([]);
  });

  it.each(["turns", "tokens", "cost"])("respects an explicit %s budget before another length continuation", async kind => {
    const test = await harness(() => text("Partial reply", "length"));
    if (kind === "turns") test.input.limits.maxTurnsPerRun = 1;
    if (kind === "tokens") test.input.limits.maxTokens = 4;
    if (kind === "cost") test.input.limits.maxCost = 0.02;
    const failure = await test.run().catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain("budget reached");
    expect(failure.usage).toEqual({ input: 3, output: 1, cost: 0.02, cacheRead: 1, cacheInput: 3 });
    expect(test.seen).toHaveLength(1);
  });

  it("keeps tools disabled on the last explicitly allowed continuation request", async () => {
    const test = await harness((context, call) => {
      if (call === 1) return text("Initial reply", "length");
      expect(context.tools).toEqual([]);
      return text(" remainder.");
    });
    test.input.limits.maxTurnsPerRun = 2;
    await test.run();
    expect(test.seen).toHaveLength(2);
  });

  it("honors cancellation before issuing the next continuation", async () => {
    const test = await harness(() => text("Partial reply", "length"));
    test.input.onEvent = event => {
      test.events.push(event);
      if (event.type === "notice" && event.text.includes("output limit")) test.abort.abort(new Error("user cancelled continuation"));
    };
    const failure = await test.run().catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain("user cancelled continuation");
    expect(failure.usage).toEqual({ input: 3, output: 1, cost: 0.02, cacheRead: 1, cacheInput: 3 });
    expect(test.seen).toHaveLength(1);
  });

  it("combines a single transient retry with length continuations in the same private transcript", async () => {
    const test = await harness((context, call) => {
      if (call === 1) return text("First", "length");
      if (call === 2) return networkFailure();
      expect(JSON.stringify(context.messages)).toContain("First");
      expect(context.messages.some(item => item.role === "assistant" && item.stopReason === "error")).toBe(false);
      return text(call === 3 ? " second" : " finished.", call === 3 ? "length" : "stop");
    });
    expect(await test.run()).toEqual({ input: 12, output: 4, cost: 0.08, cacheRead: 4, cacheInput: 12 });
    expect(test.seen).toHaveLength(4);
    expect(test.events.filter(event => event.type === "text").map(event => event.text).join("")).toBe("First second finished.");
    expect(test.events.filter(event => event.type === "notice" && event.text.includes("Continuing once"))).toHaveLength(1);
  });

  it("does not renew the transient retry allowance after a length response", async () => {
    const test = await harness((_context, call) => call === 2 ? text("Partial reply", "length") : networkFailure());
    const failure = await test.run().catch(error => error);
    expect(failure).toBeInstanceOf(RuntimeRunError);
    expect(failure.message).toContain("503");
    expect(failure.usage).toEqual({ input: 9, output: 3, cost: 0.06, cacheRead: 3, cacheInput: 9 });
    expect(test.seen).toHaveLength(3);
  });
});
