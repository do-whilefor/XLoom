import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { Mode } from "../types.js";

const repairsSchema = z.array(z.object({ path: z.string().startsWith("/"), value: z.unknown() }).strict()
  .refine(value => Object.hasOwn(value, "value"), "Repair value is required")).min(1).max(32);
function repairProposal(previous: Record<string, unknown>, repairs: z.infer<typeof repairsSchema>): Record<string, unknown> {
  const draft = structuredClone(previous);
  for (const repair of repairs) {
    const parts = repair.path.slice(1).split("/");
    if (parts.some(part => /~(?![01])/u.test(part))) throw new Error("Repair paths use JSON Pointer escaping (~0, ~1).");
    const keys = parts.map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (keys.some(key => !key || ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("Invalid repair path.");
    let parent: Record<string, unknown> | unknown[] = draft;
    for (const [index, key] of keys.entries()) {
      const final = index === keys.length - 1;
      if (Array.isArray(parent) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= parent.length)) throw new Error("Repair array index must already exist.");
      if (final) { (parent as Record<string, unknown>)[key] = structuredClone(repair.value); break; }
      if (!Object.hasOwn(parent, key)) throw new Error("Repair parent must already exist; set the missing object in one repair or resubmit output.");
      const child: unknown = (parent as Record<string, unknown>)[key];
      if (!child || typeof child !== "object") throw new Error("Repair parent must be an object or array.");
      parent = child as Record<string, unknown>;
    }
  }
  return draft;
}

/** A proposal channel only: validation and controller commit semantics are shared
 * with text JSON. No target/file operation or task-completion policy lives here. */
export function submissionTool(mode: Mode, validate: (output: unknown) => unknown) {
  let accepted = false;
  let output: unknown;
  let rejected: Record<string, unknown> | undefined;
  const tool: AgentTool = {
    name: "submit", label: "Submit result", executionMode: "sequential",
    description: "Submit output using the task contract after tools/evidence finish. Validation errors commit nothing and retain the rejected proposal privately in this run. Fix only erroneous fields with repair:[{path:'/reviews/0/pocEvidenceId',value:'exact attached ID'}], or resubmit output; choose one. Repairs set object fields or existing array entries using JSON Pointer and revalidate the whole proposal. Acceptance ends this run; controller commit/review follows. Do not repeat checkpoint records.",
    // Keep the common envelope small. Full evolving contracts and reference
    // validation remain in the shared validator instead of duplicating schemas.
    parameters: { type: "object", properties: { output: { type: "object", properties: {
      summary: { type: "string" }, ...(mode === "execute" ? { result: { type: "string", enum: ["done", "no_progress", "blocked"] } } : {}),
    }, required: ["summary", ...(mode === "execute" ? ["result"] : [])], additionalProperties: true },
    repair: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", properties: { path: { type: "string" }, value: {} }, required: ["path", "value"], additionalProperties: false } },
    }, additionalProperties: false } as AgentTool["parameters"],
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      if (accepted) throw new Error("A final proposal has already been accepted for this run.");
      const input = z.object({ output: z.record(z.unknown()).optional(), repair: repairsSchema.optional() }).strict()
        .refine(value => (value.output !== undefined) !== (value.repair !== undefined), "Choose output or repair").parse(args);
      if (input.repair && !rejected) throw new Error("No rejected proposal exists in this run; submit output first.");
      const draft = input.output ?? repairProposal(rejected!, input.repair!);
      const saved = structuredClone(draft);
      let validated: unknown;
      try { validated = validate(draft); }
      catch (error) {
        rejected = saved;
        throw new Error(`${error instanceof Error ? error.message : String(error)} Rejected proposal retained in this run. Use submit(repair:[{path:"/field/0/name",value:correctValue}]) to fix only the listed fields, or resubmit output. No fields were changed automatically.`, { cause: error });
      }
      signal?.throwIfAborted();
      output = validated;
      accepted = true;
      rejected = undefined;
      return { content: [{ type: "text", text: '{"accepted":true,"instruction":"Run ended; controller commit/review follows."}' }], details: {} };
    },
  };
  return { tool, get accepted() { return accepted; }, get output() { return output; } };
}
