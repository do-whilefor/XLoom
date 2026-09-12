import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentOptions } from "@earendil-works/pi-agent-core";
import { createReadTool, createWriteTool, createEditTool, createPowerShellTool } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunner, RunRequest, RunResult, RuntimeEvent, Usage } from "../types.js";
import { buildRunPrompt } from "./prompts.js";
import { resolveModel, type ModelResolver } from "./models.js";

export class RuntimeRunError extends Error {
  constructor(message: string, public readonly usage: Usage, options?: ErrorOptions) { super(message, options); this.name = "RuntimeRunError"; }
}

export function parseFinalJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const body = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "") : trimmed;
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error("Agent final response must be a single JSON object."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent final response must be a JSON object.");
  return value as Record<string, unknown>;
}

export function executeTools(workspace: string) {
  return [createReadTool(workspace), createWriteTool(workspace), createEditTool(workspace), createPowerShellTool(workspace)];
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

export function runtimeEvent(event: AgentEvent, mode: RuntimeEvent["mode"]): RuntimeEvent | undefined {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") return { type: "text", mode, text: event.assistantMessageEvent.delta };
      return;
    case "tool_execution_start": return { type: "tool_start", mode, toolName: event.toolName, toolCallId: event.toolCallId, text: JSON.stringify(event.args) };
    case "tool_execution_update": return { type: "tool_update", mode, toolName: event.toolName, toolCallId: event.toolCallId, text: contentText(event.partialResult) };
    case "tool_execution_end": return { type: "tool_end", mode, toolName: event.toolName, toolCallId: event.toolCallId, text: contentText(event.result), isError: event.isError };
    default: return;
  }
}

export interface PiRunnerOptions { resolveModel?: ModelResolver; createAgent?: (options: AgentOptions) => Agent }

/** Each invocation owns a fresh Pi Agent and transcript. Only the blackboard is input. */
export class PiRunner implements AgentRunner {
  constructor(private readonly options: PiRunnerOptions = {}) {}

  async run(request: RunRequest): Promise<RunResult> {
    const usage: Usage = { input: 0, output: 0, cost: 0 };
    let redact = (value: string) => value;
    let agent: Agent | undefined;
    let unsubscribe: (() => void) | undefined;
    let detachAbort: (() => void) | undefined;
    let finalMessage: AssistantMessage | undefined;
    let turns = 0;
    let budgetStop = false;
    try {
      request.signal.throwIfAborted();
      if (request.mode === "execute" && !request.step) throw new Error("Execute requires an assigned Step.");
      const config = request.snapshot.config.models[request.mode === "execute" ? "execute" : "decide"];
      const selected = await (this.options.resolveModel ?? resolveModel)(config, request.signal);
      request.signal.throwIfAborted();
      const configuredSecrets = Object.values(request.snapshot.config.models).map((entry) => entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined)
        .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
      // Pi may refresh OAuth during a run; include credentials discovered after resolution.
      const secrets = () => [...new Set([...(selected.secrets ?? []), ...configuredSecrets])].sort((a, b) => b.length - a.length);
      redact = (value) => secrets().reduce((clean, secret) => secret ? clean.split(secret).join("[MODEL_CREDENTIAL_REDACTED]") : clean, value);
      await mkdir(join(request.runDir, "artifacts"), { recursive: true });
      const prompt = buildRunPrompt(request);
      await writeFile(join(request.runDir, "input.json"), redact(JSON.stringify({ mode: request.mode, ...prompt }, null, 2)), { flag: "wx" });
      const emit = (event: RuntimeEvent) => request.onEvent({ ...event, text: redact(event.text) });
      let pendingText = "";
      const emitText = (delta: string, flush = false) => {
        pendingText = redact(pendingText + delta);
        const secretTail = Math.max(0, ...secrets().map((secret) => secret.length - 1));
        const available = flush ? pendingText.length : Math.max(0, pendingText.length - secretTail);
        if (available) emit({ type: "text", mode: request.mode, text: pendingText.slice(0, available) });
        pendingText = pendingText.slice(available);
      };
      if (selected.costKnown === false) emit({ type: "notice", mode: request.mode, text: "Endpoint pricing is unknown; cost is an estimate and an optional monetary budget cannot be enforced accurately." });
      agent = (this.options.createAgent ?? ((options) => new Agent(options)))({
        initialState: { systemPrompt: prompt.systemPrompt, model: selected.model, thinkingLevel: config.thinking ?? "off", messages: [], tools: executeTools(request.workspace) },
        streamFn: selected.streamFn,
        toolExecution: "sequential",
        sessionId: request.id,
        shouldStopAfterTurn: ({ message }) => {
          turns++;
          const hasToolCalls = message.content.some((part) => part.type === "toolCall");
          const { limits } = request.snapshot.config;
          const spent = request.snapshot.usage;
          const exhausted = turns >= limits.maxTurnsPerRun
            || (limits.maxTokens !== null && spent.input + spent.output + usage.input + usage.output >= limits.maxTokens)
            || (limits.maxCost !== null && spent.cost + usage.cost >= limits.maxCost);
          budgetStop = exhausted && hasToolCalls;
          return exhausted;
        },
      });
      unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          finalMessage = event.message;
          usage.input += event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite;
          usage.output += event.message.usage.output;
          usage.cost += event.message.usage.cost.total;
        }
        // Log completed messages and tool events. Partial transcript copies would grow quadratically.
        if (event.type !== "message_update" && event.type !== "message_start" && event.type !== "agent_end") {
          await appendFile(join(request.runDir, "events.jsonl"), `${redact(JSON.stringify(event))}\n`);
        }
        const outgoing = runtimeEvent(event, request.mode);
        if (outgoing?.type === "text") emitText(outgoing.text);
        else if (outgoing) { emitText("", true); emit(outgoing); }
        if (event.type === "message_end") emitText("", true);
      });
      const onAbort = () => agent?.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => request.signal.removeEventListener("abort", onAbort);
      request.signal.throwIfAborted();
      const running = agent.prompt(redact(prompt.userPrompt));
      if (request.signal.aborted) agent.abort();
      await running;
      request.signal.throwIfAborted();
      if (budgetStop) throw new Error("Agent budget reached before a final result; the Step may have partial side effects. Inspect artifacts before retrying.");
      if (!finalMessage) throw new Error("Agent returned no final assistant message.");
      if (finalMessage.stopReason !== "stop") throw new Error(finalMessage.errorMessage ?? `Agent stopped without a complete result: ${finalMessage.stopReason}`);
      const output = parseFinalJson(redact(contentText(finalMessage)));
      await writeFile(join(request.runDir, "output.json"), JSON.stringify({ output, usage }, null, 2), { flag: "wx" });
      return { output, usage };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      throw new RuntimeRunError(message, usage);
    } finally {
      detachAbort?.();
      if (request.signal.aborted) agent?.abort();
      await agent?.waitForIdle();
      unsubscribe?.();
    }
  }
}
