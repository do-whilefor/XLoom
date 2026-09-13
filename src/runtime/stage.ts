import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { createWriteTool } from "@earendil-works/pi-coding-agent";
import { executionSchema, formatValidationError } from "../schema.js";
import type { RunRequest, Usage } from "../types.js";
import { evidencePath } from "../paths.js";

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
      async execute(...args: Parameters<typeof tool.execute>) {
        if (yielded) throw new Error("This Execute run has yielded after a committed checkpoint; remaining tools were not executed.");
        const canonical = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
        if (!request.onCheckpoint || canonical(resolve(request.workspace, args[1].path)) !== canonical(stagePath(request))) return tool.execute(...args);
        request.signal.throwIfAborted();
        if (args[2]?.aborted) throw new Error("Operation aborted");
        const source = args[1].content;
        if (Buffer.byteLength(source) > 1_048_576) throw new Error("Checkpoint proposal exceeds 1 MiB.");
        // Reject malformed proposals before Pi overwrites the last checkpoint.
        // Keep the original bytes: guessing a quote/escape could change evidence.
        let parsed: unknown;
        try { parsed = JSON.parse(source.replace(/^\uFEFF/, "")); }
        catch (error) {
          throw new Error(`Checkpoint JSON is invalid: ${redact(error instanceof Error ? error.message : String(error))}\nNo checkpoint file was written or committed. Check matching double quotes and escape control characters inside strings (for example, \\n). Correct write.content and call write again; editing the file alone does not submit a checkpoint.`);
        }
        const validated = stageSchema.safeParse(clean(parsed));
        if (!validated.success) {
          throw new Error(`Checkpoint content is invalid: ${formatValidationError(validated.error)}\nNo checkpoint file was written or committed. Correct the listed fields in write.content and call write again.`);
        }
        const submission = validated.data;
        const result = await tool.execute(...args);
        request.signal.throwIfAborted();
        if (args[2]?.aborted) throw new Error("Operation aborted");
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
