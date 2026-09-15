import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { Mode } from "../types.js";

/** A proposal channel only: validation and controller commit semantics are shared
 * with text JSON. No target/file operation or task-completion policy lives here. */
export function submissionTool(mode: Mode, validate: (output: unknown) => unknown) {
  let accepted = false;
  let output: unknown;
  const tool: AgentTool = {
    name: "submit", label: "Submit result", executionMode: "sequential",
    description: "Submit this run's final result as an object using the output contract in the task. Call after all tools/evidence are finished. Validation errors commit nothing; fix the listed fields. Acceptance ends this run; the controller still validates/commits and decides task completion. Do not repeat checkpoint records.",
    // Keep the common envelope small. Full evolving contracts and reference
    // validation remain in the shared validator instead of duplicating schemas.
    parameters: { type: "object", properties: { output: { type: "object", properties: {
      summary: { type: "string" }, ...(mode === "execute" ? { result: { type: "string", enum: ["done", "no_progress", "blocked"] } } : {}),
    }, required: ["summary", ...(mode === "execute" ? ["result"] : [])], additionalProperties: true } }, required: ["output"], additionalProperties: false } as AgentTool["parameters"],
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      if (accepted) throw new Error("A final proposal has already been accepted for this run.");
      const input = z.object({ output: z.record(z.unknown()) }).strict().parse(args);
      output = validate(input.output);
      signal?.throwIfAborted();
      accepted = true;
      return { content: [{ type: "text", text: '{"accepted":true,"instruction":"Run ended; controller commit/review follows."}' }], details: {} };
    },
  };
  return { tool, get accepted() { return accepted; }, get output() { return output; } };
}
