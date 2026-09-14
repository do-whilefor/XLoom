import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { createWriteTool } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { executionSchema, formatValidationError } from "../schema.js";
import type { RunRequest, Usage } from "../types.js";
import { evidencePath } from "../paths.js";
import { normalizeExecutionInput } from "../loop/execution-input.js";

export const stageSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  execution: executionSchema,
  yieldToDecide: z.boolean().optional(),
}).strict();

export function stagePath(request: RunRequest): string { return join(request.runDir, "artifacts", "checkpoint.json"); }

/** Existing write tool, with an explicitly advertised controller submission file.
 * All other writes retain Pi semantics. A file alone never becomes a committed fact. */
export function stageWriter(tool: ReturnType<typeof createWriteTool>, request: RunRequest, usage: Usage, redact: (value: string) => string = value => value) {
  let yielded = false;
  let summary = "";
  let snapshot = request.snapshot;
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return {
    get yielded() { return yielded; },
    get summary() { return summary; },
    get snapshot() { return snapshot; },
    tool: {
      ...tool,
      description: `${tool.description} For checkpointFile, prefer content as a JSON object {id, execution, yieldToDecide}; Xloom serializes it. Other files require string content.`,
      parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
        content: { anyOf: [tool.parameters.properties.content, { type: "object", properties: {
          id: { type: "string" }, execution: { type: "object", additionalProperties: true }, yieldToDecide: { type: "boolean" },
        }, required: ["id", "execution"], additionalProperties: false }],
        description: "File text, or a structured checkpoint object only when path is checkpointFile. Prefer the object for checkpoints; do not JSON-encode it." },
      } } as AgentTool["parameters"],
      async execute(toolCallId: string, input: unknown, signal?: AbortSignal,
        onUpdate?: Parameters<typeof tool.execute>[3]) {
        const params = z.object({ path: z.string(), content: z.unknown() }).strict().parse(input);
        if (yielded) throw new Error("This Execute run has yielded after a committed checkpoint; remaining tools were not executed.");
        const canonical = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
        if (!request.onCheckpoint || canonical(resolve(request.workspace, params.path)) !== canonical(stagePath(request))) {
          if (typeof params.content !== "string") throw new Error("Structured write.content is only supported for checkpointFile. Other files require string content; no file was written.");
          return tool.execute(toolCallId, { path: params.path, content: params.content }, signal, onUpdate);
        }
        request.signal.throwIfAborted();
        if (signal?.aborted) throw new Error("Operation aborted");
        const source = typeof params.content === "string" ? params.content : JSON.stringify(params.content);
        if (source === undefined) throw new Error("Checkpoint content is invalid: supply a complete object or JSON string; no file was written.");
        if (Buffer.byteLength(source) > 1_048_576) throw new Error("Checkpoint proposal exceeds 1 MiB.");
        // Reject malformed proposals before Pi overwrites the last checkpoint.
        // Keep the original bytes: guessing a quote/escape could change evidence.
        let parsed: unknown;
        try { parsed = JSON.parse(source.replace(/^\uFEFF/, "")); }
        catch (error) {
          throw new Error(`Checkpoint JSON is invalid: ${redact(error instanceof Error ? error.message : String(error))}\nNo checkpoint file was written or committed. Prefer write.content as a structured object {id, execution, yieldToDecide}, not a JSON-encoded string. In arrays, separate objects with commas and close the array only after the last object. Correct write.content and call write again; editing the file alone does not submit a checkpoint.`);
        }
        const cleaned = clean(parsed);
        if (cleaned && typeof cleaned === "object" && "execution" in cleaned) cleaned.execution = normalizeExecutionInput(cleaned.execution, snapshot);
        const validated = stageSchema.safeParse(cleaned);
        if (!validated.success) {
          throw new Error(`Checkpoint content is invalid: ${formatValidationError(validated.error)}\nNo checkpoint file was written or committed. Correct the listed fields in the complete write.content and call write again; do not edit checkpointFile. New finding keys require title and target; exact existing keys may omit them to retain their committed values.`);
        }
        const submission = validated.data;
        const result = await tool.execute(toolCallId, { path: params.path, content: source }, signal, onUpdate);
        request.signal.throwIfAborted();
        if (signal?.aborted) throw new Error("Operation aborted");
        if (await readFile(stagePath(request), "utf8") !== source) {
          throw new Error("Checkpoint file changed after write; this proposal was not committed. Inspect the file before submitting again with write.");
        }
        const board = await request.onCheckpoint(submission.id, submission.execution, { ...usage });
        snapshot = board;
        yielded = submission.yieldToDecide ?? false;
        summary = submission.execution.summary;
        return { ...result, content: [{ type: "text" as const, text: JSON.stringify({
          checkpoint: submission.id, committed: true, revision: board.revision, yielded,
          // Return committed public identifiers so the next batch can refer to
          // already-submitted evidence instead of inventing or resubmitting IDs.
          facts: board.facts.map(({ id, description, evidenceIds, supersedes }) => ({ id, description, evidenceIds, supersedes })),
          evidence: board.evidence.map(item => ({ id: item.id, path: evidencePath(item, dirname(dirname(request.runDir)), request.workspace), description: item.description })),
          findings: board.findings.map(({ id, key, target }) => ({ id, key, target })),
          ...(board.wikiPages?.length ? { wikiPages: board.wikiPages.map(({ id, revision }) => ({ id, revision })) } : {}),
          ...(request.wikiProjectionError ? { wikiProjection: { status: "unavailable", reason: request.wikiProjectionError } } : {}),
          instruction: yielded ? "Return control to Decide; do not execute further tools." : "Continue this Step if useful. Final output should contain only new, uncommitted records; use these committed IDs for references.",
        }) }] };
      },
    },
  };
}
