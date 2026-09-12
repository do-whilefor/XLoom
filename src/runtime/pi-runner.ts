import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentOptions } from "@earendil-works/pi-agent-core";
import { createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunner, RunRequest, RunResult, RuntimeEvent, Usage } from "../types.js";
import { buildRunPrompt } from "./prompts.js";
import { resolveModel, type ModelResolver } from "./models.js";
import { createRunBudget } from "./run-budget.js";
import { createCheckedPowerShellTool } from "./powershell.js";
import { decisionSchema, executionSchema, formatValidationError } from "../schema.js";
import { createContextSummarizer, prepareContext, saveCheckpoint, loadCheckpoint, isTransientModelFailure } from "./continuity.js";
import { stageWriter } from "./stage.js";
import { validateDecisionFactReferences } from "../loop/references.js";
import { credentialPatterns, redactCredentials } from "./redaction.js";
import { createWorkspaceReadTool } from "./read.js";

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
  return [createWorkspaceReadTool(workspace), createWriteTool(workspace), createEditTool(workspace), createCheckedPowerShellTool(workspace)];
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
    : Math.max(0, value.length - Math.max(0, ...credentialPatterns(secrets()).map(secret => secret.length - 1)));
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
      redact = value => redactCredentials(value, secrets());
      await mkdir(join(request.runDir, "artifacts"), { recursive: true });
      const budget = createRunBudget(request.snapshot.config.limits, usage, request.snapshot.usage, "agent", request.signal);
      const prompt = buildRunPrompt(request);
      prompt.systemPrompt += `\n\n${budget.instruction}`;
      await writeFile(join(request.runDir, "input.json"), redact(JSON.stringify({ mode: request.mode, ...prompt }, null, 2)), { flag: "wx" });
      const emit = (event: RuntimeEvent) => request.onEvent({ ...event, text: redact(event.text) });
      forward = createRuntimeForwarder(request.mode, emit, redact, secrets);
      if (selected.costKnown === false) emit({ type: "notice", mode: request.mode, text: "Endpoint pricing is unknown; cost is an estimate and an optional monetary budget cannot be enforced accurately." });
      const stage = request.mode === "execute" && request.onCheckpoint ? stageWriter(createWriteTool(request.workspace), request, usage, redact) : undefined;
      const tools = request.mode === "execute" ? executeTools(request.workspace).map(tool => tool.name === "write" && stage ? stage.tool : tool) : [createWorkspaceReadTool(request.workspace)];
      const checkpointFile = join(request.runDir, "continuation.json");
      const identity = { role: request.mode, provider: selected.model.provider, model: selected.model.id, api: selected.model.api,
        baseUrl: selected.model.baseUrl, workspace: request.workspace, taskId: request.id, stepId: request.step?.id ?? null };
      const pending = new Set<string>();
      let checkpointError: Error | undefined;
      const persist = async () => {
        if (!agent?.state) return;
        try { await saveCheckpoint(checkpointFile, { identity, messages: agent.state.messages, pendingToolCalls: [...pending], usage }, redact); }
        catch (error) { checkpointError = error instanceof Error ? error : new Error(String(error)); throw checkpointError; }
      };
      let modelRequests = 0;
      let requestLimitReached = false;
      const finalRequest = () => request.snapshot.config.limits.maxTurnsPerRun !== null
        && modelRequests === request.snapshot.config.limits.maxTurnsPerRun - 1;
      const finalInstruction = "This is the final allowed model request. Tools are unavailable. Return the required JSON from completed observations only; do not claim unfinished work succeeded.";
      const canRequest = () => budget.canRequest && (request.snapshot.config.limits.maxTurnsPerRun === null
        || modelRequests < request.snapshot.config.limits.maxTurnsPerRun);
      const summarizer = createContextSummarizer(selected.streamFn, consumed => {
        const added = { input: consumed.input + consumed.cacheRead + consumed.cacheWrite, output: consumed.output, cost: consumed.cost.total };
        usage.input += added.input; usage.output += added.output; usage.cost += added.cost;
        emit({ type: "usage", mode: request.mode, text: "", usage: added });
      }, request.id);
      agent = (this.options.createAgent ?? ((options) => new Agent(options)))({
        initialState: { systemPrompt: prompt.systemPrompt, model: selected.model, thinkingLevel: config.thinking ?? "off", messages: [], tools: budget.toolsAllowed ? tools : [] },
        streamFn: (...args) => {
          request.signal.throwIfAborted();
          if (!canRequest()) throw new Error("Explicit invocation budget exhausted before the next model request.");
          modelRequests++;
          return selected.streamFn(...args);
        },
        toolExecution: "sequential",
        sessionId: request.id,
        beforeToolCall: async () => {
          if (checkpointError) return { block: true, reason: "Private checkpoint could not be saved; tool was not executed.", terminate: true };
          if (stage?.yielded) return { block: true, reason: "Execute has yielded to Decide; remaining tools were not executed.", terminate: true };
          request.signal.throwIfAborted();
          return undefined;
        },
        shouldStopAfterTurn: async context => {
          const stopped = await budget.shouldStopAfterTurn(context);
          const exhausted = request.snapshot.config.limits.maxTurnsPerRun !== null && modelRequests >= request.snapshot.config.limits.maxTurnsPerRun;
          if (exhausted && context.message.content.some(part => part.type === "toolCall")) requestLimitReached = true;
          return stopped || exhausted || !!stage?.yielded;
        },
        prepareNextTurnWithContext: async context => {
          request.signal.throwIfAborted();
          if (!canRequest()) throw new Error("Explicit invocation budget exhausted before context maintenance.");
          const next = await budget.prepareNextTurnWithContext(context);
          const base = next?.context ?? context.context;
          const prepared = await prepareContext(base.messages, selected.model, request.signal, summarizer);
          if (!canRequest()) throw new Error("Explicit invocation budget exhausted during context maintenance.");
          if (prepared.compacted) {
            agent!.state.messages = prepared.messages;
            await persist();
            emit({ type: "notice", mode: request.mode, text: `Private context compacted (${prepared.estimatedTokensBefore} → ${prepared.estimatedTokensAfter} estimated tokens); original evidence remains available.` });
          }
          return { context: { ...base, messages: prepared.messages, ...(finalRequest() ? { tools: [], systemPrompt: `${base.systemPrompt}\n${finalInstruction}` } : {}) } };
        },
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
        if (event.type === "message_end") {
          if (event.message.role === "assistant") for (const part of event.message.content) if (part.type === "toolCall") pending.add(part.id);
          if (event.message.role === "toolResult") pending.delete(event.message.toolCallId);
          // This awaited write precedes execution of any assistant tool batch.
          await persist();
        }
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
      if (isTransientModelFailure(finalMessage) && canRequest() && !checkpointError && !stage?.yielded) {
        const checkpoint = await loadCheckpoint(checkpointFile, identity);
        if (!checkpoint) throw new Error("No complete private checkpoint is available for continuation.");
        agent.state.messages = checkpoint.messages;
        if (finalRequest()) {
          agent.state.tools = [];
          agent.state.systemPrompt += `\n${finalInstruction}`;
        }
        emit({ type: "notice", mode: request.mode, text: "Transient model failure; continuing once from this role's completed tool results. No tool calls are replayed." });
        finalMessage = undefined;
        await agent.continue();
        request.signal.throwIfAborted();
      }
      if (budget.error) throw new Error(budget.error);
      if (requestLimitReached) throw new Error(`Agent budget reached before a final result (maxTurnsPerRun=${request.snapshot.config.limits.maxTurnsPerRun}, requests=${modelRequests}); completed evidence is retained.`);
      if (checkpointError) throw checkpointError;
      if (stage?.yielded) {
        const result: RunResult = { output: { summary: `${stage.summary} Partial checkpoint handed to Decide; Step success remains unverified.`, result: "blocked" }, usage, yielded: true };
        await writeFile(join(request.runDir, "output.json"), JSON.stringify(result, null, 2), { flag: "wx" });
        return result;
      }
      if (!finalMessage) throw new Error("Agent returned no final assistant message.");
      if (finalMessage.stopReason !== "stop") throw new Error(finalMessage.errorMessage ?? `Agent stopped without a complete result: ${finalMessage.stopReason}`);
      const validate = () => {
        const parsed = parseFinalJson(redact(contentText(finalMessage)));
        if (request.mode === "execute") {
          const validated = executionSchema.safeParse(parsed);
          if (!validated.success) throw new Error(formatValidationError(validated.error));
          return validated.data;
        }
        const validated = decisionSchema.safeParse(parsed);
        if (!validated.success) throw new Error(formatValidationError(validated.error));
        validateDecisionFactReferences(request.snapshot, validated.data);
        return validated.data;
      };
      let output: unknown;
      try { output = validate(); }
      catch (error) {
        if (!canRequest()) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        emit({ type: "notice", mode: request.mode, text: "Final response has an invalid protocol shape or Fact reference; requesting one tool-free repair using existing results." });
        agent.state.tools = [];
        agent.shouldStopAfterTurn = async context => { await budget.shouldStopAfterTurn(context); return true; };
        await agent.prompt(`Repair only the final JSON protocol. Validation error: ${reason}. Tools are unavailable. Use only observations already present; do not invent evidence, files, IDs, findings, or completion. Submit only records not already committed by checkpoints. Return the required single JSON object.`);
        request.signal.throwIfAborted();
        if (budget.error) throw new Error(budget.error);
        if (finalMessage?.stopReason !== "stop") throw new Error(finalMessage?.errorMessage ?? "Protocol repair did not finish.");
        output = validate();
      }
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
