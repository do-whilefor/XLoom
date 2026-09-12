import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentOptions } from "@earendil-works/pi-agent-core";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunner, RunRequest, RunResult, RuntimeEvent, Usage } from "../types.js";
import { buildRunPrompt } from "./prompts.js";
import { resolveModel, type ModelResolver } from "./models.js";
import { createRunBudget } from "./run-budget.js";
import { createCheckedPowerShellTool } from "./powershell.js";

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
  return [createReadTool(workspace), createWriteTool(workspace), createEditTool(workspace), createCheckedPowerShellTool(workspace)];
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function isProtocolText(value: string): boolean {
  if (/^(?:\{|\[|```(?:json)?\s*[\[{]|```json\b)/i.test(value)) return true;
  const body = value.replace(/^```\s*\n/, "").replace(/\n```$/, "");
  try { JSON.parse(body); return true; } catch { return false; }
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

/** Forward only Pi-returned plain thinking, never signatures or provider-redacted payloads. */
export function createRuntimeForwarder(mode: RuntimeEvent["mode"], emit: (event: RuntimeEvent) => void,
  redact: (value: string) => string, secrets: () => readonly string[], fallbackText = false) {
  const prefix = randomUUID();
  let messageIndex = 0;
  const messageId = () => `${prefix}:${messageIndex}`;
  let pendingText = "";
  let sawText = false;
  type Thought = { id: string; pending: string; sawDelta: boolean; ended: boolean; replayed: boolean };
  let thoughts = new Map<number, Thought>();
  const availableText = (value: string, flush: boolean) => flush ? value.length
    : Math.max(0, value.length - Math.max(0, ...secrets().map(secret => secret.length - 1)));
  const emitText = (delta: string, flush = false) => {
    pendingText = redact(pendingText + delta);
    const available = availableText(pendingText, flush);
    if (available) emit({ type: "text", mode, messageId: messageId(), text: pendingText.slice(0, available) });
    pendingText = pendingText.slice(available);
  };
  const begin = (index: number, replayed = false): Thought => {
    let thought = thoughts.get(index);
    if (!thought) {
      emitText("", true);
      thought = { id: `${prefix}:${messageIndex}:${index}`, pending: "", sawDelta: false, ended: false, replayed };
      thoughts.set(index, thought);
      emit({ type: "thinking_start", mode, messageId: messageId(), blockId: thought.id, text: "", ...(replayed ? { replayed: true } : {}) });
    }
    return thought;
  };
  const delta = (thought: Thought, value: string, flush = false) => {
    if (thought.ended) return;
    thought.pending = redact(thought.pending + value);
    const available = availableText(thought.pending, flush);
    if (available) emit({ type: "thinking", mode, messageId: messageId(), blockId: thought.id, text: thought.pending.slice(0, available), ...(thought.replayed ? { replayed: true } : {}) });
    thought.pending = thought.pending.slice(available);
  };
  const end = (thought: Thought) => {
    if (thought.ended) return;
    delta(thought, "", true);
    thought.ended = true;
    emit({ type: "thinking_end", mode, messageId: messageId(), blockId: thought.id, text: "", ...(thought.replayed ? { replayed: true } : {}) });
  };
  const finish = () => { for (const thought of thoughts.values()) end(thought); };
  return {
    finish,
    handle(event: AgentEvent): void {
      if (event.type === "message_start" && event.message.role === "assistant") {
        finish();
        messageIndex++;
        thoughts = new Map();
        sawText = false;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start" || update.type === "thinking_delta" || update.type === "thinking_end") {
          const content = update.partial.content[update.contentIndex];
          if (content?.type !== "thinking" || content.redacted) return;
          const thought = begin(update.contentIndex);
          if (update.type === "thinking_delta") { thought.sawDelta = true; delta(thought, update.delta); }
          if (update.type === "thinking_end") {
            if (!thought.sawDelta) delta(thought, update.content, true);
            end(thought);
          }
          return;
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        event.message.content.forEach((content, index) => {
          if (content.type !== "thinking" || content.redacted || !content.thinking) return;
          const thought = begin(index, true);
          if (!thought.sawDelta && !thought.ended) delta(thought, content.thinking, true);
          end(thought);
        });
        finish();
        if (fallbackText && !sawText) emitText(contentText(event.message));
        emitText("", true);
        // Only actual, completed tool-use narration is public progress. Final JSON
        // still belongs to the controller's result contract; never invent prose.
        const narration = contentText(event.message).trim();
        if (event.message.stopReason === "toolUse" && event.message.content.some(part => part.type === "toolCall")
          && narration && !isProtocolText(narration)) {
          emit({ type: "narration", mode, messageId: messageId(), text: redact(narration) });
        }
        const usage = event.message.usage;
        emit({ type: "usage", mode, text: "", usage: {
          input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output, cost: usage.cost.total,
        } });
      }
      const outgoing = runtimeEvent(event, mode);
      if (outgoing?.type === "text") { finish(); sawText = true; emitText(outgoing.text); }
      else if (outgoing) { finish(); emitText("", true); emit(outgoing); }
      if (event.type === "message_end") emitText("", true);
    },
  };
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
    let forward: ReturnType<typeof createRuntimeForwarder> | undefined;
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
      const budget = createRunBudget(request.snapshot.config.limits, usage, request.snapshot.usage, "agent", request.signal);
      const prompt = buildRunPrompt(request);
      prompt.systemPrompt += `\n\n${budget.instruction}`;
      await writeFile(join(request.runDir, "input.json"), redact(JSON.stringify({ mode: request.mode, ...prompt }, null, 2)), { flag: "wx" });
      const emit = (event: RuntimeEvent) => request.onEvent({ ...event, text: redact(event.text) });
      forward = createRuntimeForwarder(request.mode, emit, redact, secrets);
      if (selected.costKnown === false) emit({ type: "notice", mode: request.mode, text: "Endpoint pricing is unknown; cost is an estimate and an optional monetary budget cannot be enforced accurately." });
      agent = (this.options.createAgent ?? ((options) => new Agent(options)))({
        initialState: { systemPrompt: prompt.systemPrompt, model: selected.model, thinkingLevel: config.thinking ?? "off", messages: [], tools: budget.toolsAllowed ? executeTools(request.workspace) : [] },
        streamFn: selected.streamFn,
        toolExecution: "sequential",
        sessionId: request.id,
        shouldStopAfterTurn: budget.shouldStopAfterTurn,
        prepareNextTurnWithContext: budget.prepareNextTurnWithContext,
      });
      unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          finalMessage = event.message;
          usage.input += event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite;
          usage.output += event.message.usage.output;
          usage.cost += event.message.usage.cost.total;
        }
        // Keep UI/block state ordered at callback entry, before transcript I/O.
        forward!.handle(event);
        // Log completed messages and tool events. Partial transcript copies would grow quadratically.
        if (event.type !== "message_update" && event.type !== "message_start" && event.type !== "agent_end") {
          await appendFile(join(request.runDir, "events.jsonl"), `${redact(JSON.stringify(event))}\n`);
        }
      });
      const onAbort = () => agent?.abort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => request.signal.removeEventListener("abort", onAbort);
      request.signal.throwIfAborted();
      const running = agent.prompt(redact(prompt.userPrompt));
      if (request.signal.aborted) agent.abort();
      await running;
      request.signal.throwIfAborted();
      if (budget.error) throw new Error(budget.error);
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
      forward?.finish();
      unsubscribe?.();
    }
  }
}
