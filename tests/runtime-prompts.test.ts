import { describe, expect, it } from "vitest";
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.js";
import { decisionSchema, executionSchema } from "../src/schema.js";
import { ChatSession, chatPrompt } from "../src/runtime/chat.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { powerShellPrompt } from "../src/runtime/powershell.js";
import type { BoardSnapshot, RunRequest } from "../src/types.js";

const model: Model<"openai-completions"> = {
  id: "offline", name: "offline", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_000,
};

function captureChat(seen: Context[]): ChatSession {
  return new ChatSession({ resolveModel: async () => ({ model, streamFn: (_model, context) => {
    seen.push(JSON.parse(JSON.stringify(context)) as Context);
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "Offline fixture reply." }], stopReason: "stop",
      api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const events = new AssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "done", reason: "stop", message });
      events.end();
    });
    return events;
  } }) });
}

describe("compact built-in prompts", () => {
  it("sends short ordinary chat requests without unlimited-budget prose or duplicate PowerShell guidance", async () => {
    const seen: Context[] = [];
    const session = captureChat(seen);
    const input = { text: "你是什么模型", workspace: process.cwd(), model: { provider: "test", model: "offline" },
      limits: defaultConfig("chat fixture").limits, signal: new AbortController().signal, onEvent() {} };
    try {
      await session.send(input);
      await session.send({ ...input, text: "继续" });
      expect(seen).toHaveLength(2);
      expect(seen.map(context => context.messages.length)).toEqual([1, 3]);
      for (const context of seen) {
        expect(context.systemPrompt?.trim()).toBe(chatPrompt);
        expect(context.systemPrompt!.length).toBeLessThanOrEqual(300);
        expect(context.systemPrompt).not.toMatch(/model-turn limit|maxTurnsPerRun|final allowed model|JSON object/);
        expect(context.systemPrompt).not.toContain(powerShellPrompt);
        expect(context.tools?.map(tool => tool.name)).toEqual(["read", "write", "edit", "powershell"]);
        const definitions = JSON.stringify(context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })));
        expect(definitions.length).toBeLessThanOrEqual(3_300);
        expect(context.systemPrompt!.length + definitions.length).toBeLessThanOrEqual(3_600);
        const shell = context.tools!.find(tool => tool.name === "powershell")!;
        expect(shell.description.split(powerShellPrompt)).toHaveLength(2);
      }
    } finally {
      session.reset();
    }
  });

  it("still explains an explicitly configured chat turn budget", async () => {
    const seen: Context[] = [];
    const session = captureChat(seen);
    const limits = { ...defaultConfig("chat fixture").limits, maxTurnsPerRun: 2 };
    try {
      await session.send({ text: "fixture", workspace: process.cwd(), model: { provider: "test", model: "offline" },
        limits, signal: new AbortController().signal, onEvent() {} });
      expect(seen[0]!.systemPrompt).toContain("maxTurnsPerRun=2");
      expect(seen[0]!.systemPrompt).not.toContain(powerShellPrompt);
    } finally {
      session.reset();
    }
  });

  it.each([
    ["decide", 650, 3_100], ["execute", 650, 2_300], ["metacog", 900, 3_100],
  ] as const)("keeps %s instructions compact while retaining a valid JSON output contract", (mode, systemLimit, protocolLimit) => {
    const snapshot: BoardSnapshot = {
      revision: 0, config: defaultConfig("Synthetic prompt fixture"), status: "running", outcome: null, reason: "",
      goals: [], steps: [], facts: [], evidence: [], findings: [], hints: [],
      usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0,
    };
    const request: RunRequest = { id: "fixture", mode, snapshot, workspace: "fixture", runDir: "fixture/run",
      signal: new AbortController().signal, onEvent() {} };
    const { systemPrompt, userPrompt } = buildRunPrompt(request);
    const protocol = userPrompt.slice(0, userPrompt.lastIndexOf("\n\n"));
    expect(systemPrompt.length).toBeLessThanOrEqual(systemLimit);
    expect(protocol.length).toBeLessThanOrEqual(protocolLimit);
    expect(systemPrompt).toContain("Final response: one JSON object");
    expect(systemPrompt).toContain("Never invent evidence or private reasoning");
    expect(systemPrompt).not.toContain(powerShellPrompt);
    // The contract uses | to list enum alternatives; each first alternative must
    // still form a schema-valid example after prose is compressed.
    const example = JSON.parse(protocol.split("\n")[1]!, (_key, value: unknown) =>
      typeof value === "string" ? value.split("|")[0] : value);
    expect((mode === "execute" ? executionSchema : decisionSchema).safeParse(example).success).toBe(true);
    expect(JSON.parse(userPrompt.split("\n").at(-1)!).blackboard.project.goal).toBe("Synthetic prompt fixture");
  });
});
