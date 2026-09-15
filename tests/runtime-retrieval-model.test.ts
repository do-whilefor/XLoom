import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createRetrievalModel } from "../src/runtime/retrieval-model.js";

const model: Model<"openai-completions"> = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage: Usage = { input: 20, output: 10, cacheRead: 5, cacheWrite: 2, totalTokens: 37, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } };
function fixture(stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop") {
  const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: '{"groups":[{"id":"query","queries":["download"]}]}' }],
    api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: 0 };
  const stream = vi.fn<StreamFn>(() => {
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (stopReason === "error" || stopReason === "aborted") events.push({ type: "error", reason: stopReason, error: response });
      else events.push({ type: "done", reason: stopReason, message: response });
      events.end();
    });
    return events;
  });
  return { stream, response, selected: { model, streamFn: stream } };
}
describe("stateless semantic model requests", () => {
  it("uses existing authentication, no tools, accounts for usage and redacts source credentials", async () => {
    const f = fixture(), consumed = vi.fn();
    const semantic = createRetrievalModel(f.selected, f.stream, consumed, "run-id", () => true, text => text.replaceAll("SECRET", "[redacted]"));
    expect(await semantic.generate("expand", { query: "SECRET source" })).toMatchObject({ groups: [{ id: "query", queries: ["download"] }] });
    expect(consumed).toHaveBeenCalledExactlyOnceWith(usage);
    const [, context, options] = f.stream.mock.calls[0]!;
    expect(context.tools).toEqual([]); expect(JSON.stringify(context.messages)).not.toContain("SECRET");
    expect(options).toMatchObject({ sessionId: "run-id", reasoning: "low" });
    expect(options).not.toHaveProperty("apiKey"); expect(options).not.toHaveProperty("maxTokens");
  });
  it("reserves the caller's final request and propagates cancellation without calling the provider", async () => {
    const f = fixture();
    const semantic = createRetrievalModel(f.selected, f.stream, () => {}, "run", () => false, text => text);
    await expect(semantic.generate("expand", {})).rejects.toThrow("request capacity");
    const signal = AbortSignal.abort();
    await expect(semantic.generate("expand", {}, signal)).rejects.toThrow();
    expect(f.stream).not.toHaveBeenCalled();
  });
  it.each(["length", "toolUse", "error"] as const)("accounts for %s output but rejects it as retrieval hints", async reason => {
    const f = fixture(reason), consumed = vi.fn();
    const semantic = createRetrievalModel(f.selected, f.stream, consumed, "run", () => true, text => text);
    await expect(semantic.generate("rerank", {})).rejects.toThrow("complete data response");
    expect(consumed).toHaveBeenCalledExactlyOnceWith(usage);
  });
});
