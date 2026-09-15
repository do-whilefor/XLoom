import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { submissionTool } from "../src/runtime/submission.js";
import { decisionSchema, executionSchema } from "../src/schema.js";

describe("private proposal repair", () => {
  it.each(["decide", "metacog", "execute"] as const)("retains missing required %s fields for local repair", async mode => {
    const submit = submissionTool(mode, value => (mode === "execute" ? executionSchema : decisionSchema).parse(value));
    const output = mode === "execute" ? { summary: "Retain this execution" } : { steps: [] };
    const args = validateToolArguments(submit.tool, { type: "toolCall", id: "missing", name: "submit", arguments: { output } });
    expect(args).toEqual({ output });
    await expect(submit.tool.execute("missing", args)).rejects.toThrow("Rejected proposal retained");
    expect(submit.accepted).toBe(false);
    const repair = mode === "execute" ? { path: "/result", value: "no_progress" } : { path: "/summary", value: "Repaired planning" };
    await submit.tool.execute("repair", { repair: [repair] });
    expect(submit.output).toEqual(mode === "execute" ? { ...output, result: "no_progress" } : { ...output, summary: "Repaired planning" });
  });

  it.each([42, true, null])("preserves invalid summary %j without Pi coercion or removal", async summary => {
    const submit = submissionTool("decide", value => decisionSchema.parse(value));
    const output = { summary };
    const args = validateToolArguments(submit.tool, { type: "toolCall", id: "invalid", name: "submit", arguments: { output } });
    expect(args).toEqual({ output });
    await expect(submit.tool.execute("invalid", args)).rejects.toThrow("Rejected proposal retained");
    expect(submit.accepted).toBe(false);
    await submit.tool.execute("repair", { repair: [{ path: "/summary", value: "Actual summary" }] });
    expect(submit.output).toEqual({ summary: "Actual summary" });
  });

  it("repairs the newest invalid execution instead of an older rejected proposal", async () => {
    const submit = submissionTool("execute", value => executionSchema.parse(value));
    const call = async (id: string, arguments_: Record<string, unknown>) => submit.tool.execute(id,
      validateToolArguments(submit.tool, { type: "toolCall", id, name: "submit", arguments: arguments_ }));
    await expect(call("old", { output: { summary: "OUTDATED", result: "no_progress", extra: true } })).rejects.toThrow();
    const newest = { summary: "LATEST observed result", result: "invalid", extra: true };
    await expect(call("new", { output: newest })).rejects.toThrow();
    await call("repair", { repair: [{ path: "/result", value: "blocked" }, { path: "/extra", remove: true }] });
    expect(submit.output).toEqual({ summary: newest.summary, result: "blocked" });
    expect(newest).toEqual({ summary: "LATEST observed result", result: "invalid", extra: true });
  });

  it("describes the envelope while keeping null optional fields strictly repairable", async () => {
    const submit = submissionTool("decide", value => decisionSchema.parse(value));
    expect(submit.tool.description).toContain('{"output":{...task result...}}');
    expect(submit.tool.description).toContain("do not send null");
    expect(() => validateToolArguments(submit.tool, { type: "toolCall", id: "bad-envelope", name: "submit", arguments: { summary: "Wrong envelope" } })).toThrow();
    const original = { output: { summary: "Valid summary", conclusion: null } };
    const args = validateToolArguments(submit.tool, { type: "toolCall", id: "null", name: "submit", arguments: original });
    expect(args).toEqual(original);
    await expect(submit.tool.execute("null", args)).rejects.toThrow("Rejected proposal retained");
    await submit.tool.execute("repair", { repair: [{ path: "/conclusion", remove: true }] });
    expect(submit.output).toEqual({ summary: "Valid summary" });
  });
  it.each(["decide", "metacog"] as const)("exposes the authoritative Step requirements without intercepting private %s repair", async mode => {
    const submit = submissionTool(mode, value => decisionSchema.parse(value));
    const wire = submit.tool.parameters as any;
    const required = Object.entries(decisionSchema.shape.steps.unwrap().element.shape)
      .filter(([, field]) => !field.isOptional()).map(([name]) => name);
    const contract = wire.properties.output.properties.steps;
    expect(Object.keys(contract.items.properties)).toEqual(required);
    expect(contract.description).toContain(required.join(", "));
    expect(contract.items.properties.from.description).toContain("Explicit [] only when");
    const output = { summary: "Inspect fixture", steps: [{ goalId: "G0", description: "Read original", successSignal: "Bytes observed", evidencePlan: "Archive original", priority: 1 }] };
    const args = validateToolArguments(submit.tool, { type: "toolCall", id: "first", name: "submit", arguments: { output } });
    await expect(submit.tool.execute("first", args)).rejects.toThrow("Rejected proposal retained");
    expect(submit.accepted).toBe(false); expect(submit.output).toBeUndefined();
    await submit.tool.execute("repair", { repair: [{ path: "/steps/0/from", value: [] }] });
    expect(submit.accepted).toBe(true);
    expect(submit.output).toEqual({ ...output, steps: [{ ...output.steps[0], from: [] }] });
    expect(output.steps[0]).not.toHaveProperty("from");
    await expect(submit.tool.execute("duplicate", { output })).rejects.toThrow("already been accepted");
  });

  it("does not coerce or discard invalid nested Step values before private validation", async () => {
    const submit = submissionTool("decide", value => decisionSchema.parse(value));
    const output = { summary: "Keep original input", steps: [{ goalId: "G0", from: [42], priority: null }] };
    const args = validateToolArguments(submit.tool, { type: "toolCall", id: "original", name: "submit", arguments: { output } });
    expect(args).toEqual({ output });
    await expect(submit.tool.execute("original", args)).rejects.toThrow("Rejected proposal retained");
    expect(submit.accepted).toBe(false);
  });

  it("accepts removal through Pi's tool argument validator and rejects ambiguous operations", () => {
    const { tool } = submissionTool("decide", value => value);
    const validate = (repair: unknown[]) => validateToolArguments(tool, { type: "toolCall", id: "repair", name: "submit", arguments: { repair } });
    const repairs = [{ path: "/conclusion", remove: true }, { path: "/steps/0/from", value: [] }, { path: "/nullable", value: null }];
    expect(validate(repairs)).toEqual({ repair: repairs });
    for (const repair of [{ path: "/conclusion" }, { path: "/conclusion", remove: true, value: null }, { path: "/conclusion", remove: false }]) {
      expect(() => validate([repair])).toThrow();
    }
  });

  it("removes invalid optional fields and fills required fields without resubmitting the proposal", async () => {
    const schema = z.object({ summary: z.string(), steps: z.array(z.object({ from: z.array(z.string()) })),
      conclusion: z.object({ reason: z.string() }).optional() });
    const proposed = { summary: "Keep this summary", steps: [{}], conclusion: null };
    const validate = vi.fn((value: unknown) => schema.parse(value));
    const submit = submissionTool("decide", validate);
    await expect(submit.tool.execute("bad", { output: proposed })).rejects.toThrow("remove:true");
    await submit.tool.execute("repair", { repair: [{ path: "/steps/0/from", value: [] }, { path: "/conclusion", remove: true }] });
    expect(submit.accepted).toBe(true);
    expect(submit.output).toEqual({ summary: proposed.summary, steps: [{ from: [] }] });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(proposed).toEqual({ summary: "Keep this summary", steps: [{}], conclusion: null });
  });

  it("splices removed array entries and uses the resulting indices for later repairs", async () => {
    const schema = z.object({ summary: z.string(), reviews: z.array(z.object({ reason: z.string() })) });
    const proposed = { summary: "fixture", reviews: [null, { reason: "retained" }] };
    const submit = submissionTool("metacog", value => schema.parse(value));
    await expect(submit.tool.execute("bad", { output: proposed })).rejects.toThrow();
    await submit.tool.execute("repair", { repair: [{ path: "/reviews/0", remove: true }, { path: "/reviews/0/reason", value: "corrected" }] });
    expect(submit.output).toEqual({ summary: "fixture", reviews: [{ reason: "corrected" }] });
    expect(proposed.reviews).toEqual([null, { reason: "retained" }]);
  });

  it("rejects invalid removal batches atomically and still validates required fields after removal", async () => {
    const validate = vi.fn((value: unknown) => z.object({ summary: z.string() }).strict().parse(value));
    const submit = submissionTool("decide", validate);
    await expect(submit.tool.execute("bad", { output: { summary: "retained", extra: null } })).rejects.toThrow();
    for (const repair of [
      [{ path: "/extra", remove: true, value: null }], [{ path: "/extra", remove: false }],
      [{ path: "/extra", remove: true }, { path: "/missing", remove: true }],
      [{ path: "/extra", remove: true }, { path: "/__proto__", remove: true }],
    ]) await expect(submit.tool.execute("invalid", { repair })).rejects.toThrow();
    expect(validate).toHaveBeenCalledTimes(1);
    await expect(submit.tool.execute("required", { repair: [{ path: "/summary", remove: true }] })).rejects.toThrow();
    expect(validate.mock.calls.at(-1)).toEqual([{ extra: null }]);
    expect(submit.accepted).toBe(false); expect(submit.output).toBeUndefined();
    await submit.tool.execute("fixed", { repair: [{ path: "/summary", value: "restored" }, { path: "/extra", remove: true }] });
    expect(submit.output).toEqual({ summary: "restored" });
  });

  it("repairs one rejected reference while preserving the whole proposal and revalidating it", async () => {
    const proposed = { summary: "fixture", reviews: [{ findingId: "V1", pocEvidenceId: "wrong", reason: "original evidence judgment" }],
      updateGoals: [{ id: "G0", factIds: ["F1"] }] };
    const validate = vi.fn((value: unknown) => {
      const proposal = value as typeof proposed;
      if (proposal.reviews[0].pocEvidenceId !== "E1") throw new Error("reviews[0].pocEvidenceId must belong to V1");
      return proposal;
    });
    const submit = submissionTool("metacog", validate);
    await expect(submit.tool.execute("bad", { output: proposed })).rejects.toThrow("Rejected proposal retained");
    expect(submit.accepted).toBe(false); expect(submit.output).toBeUndefined();
    await submit.tool.execute("repair", { repair: [{ path: "/reviews/0/pocEvidenceId", value: "E1" }] });
    expect(submit.accepted).toBe(true); expect(validate).toHaveBeenCalledTimes(2);
    expect(submit.output).toEqual({ ...proposed, reviews: [{ ...proposed.reviews[0], pocEvidenceId: "E1" }] });
    expect(proposed.reviews[0].pocEvidenceId).toBe("wrong");
    await expect(submit.tool.execute("again", { repair: [{ path: "/summary", value: "changed" }] })).rejects.toThrow("already been accepted");
  });

  it("keeps candidates private to a run and rejects ambiguous or missing repair inputs", async () => {
    const submit = submissionTool("decide", value => value);
    await expect(submit.tool.execute("missing", { repair: [{ path: "/summary", value: "x" }] })).rejects.toThrow("No rejected proposal");
    await expect(submit.tool.execute("both", { output: { summary: "x" }, repair: [{ path: "/summary", value: "y" }] })).rejects.toThrow("Choose output or repair");
    await expect(submit.tool.execute("neither", {})).rejects.toThrow("Choose output or repair");
    await expect(submit.tool.execute("no-value", { repair: [{ path: "/summary" }] })).rejects.toThrow("Repair value is required");
  });

  it("rejects unsafe paths without changing the retained candidate or validating a partial repair", async () => {
    const validate = vi.fn(() => { throw new Error("synthetic failure"); });
    const submit = submissionTool("decide", validate);
    await expect(submit.tool.execute("initial", { output: { summary: "original", reviews: [{ reason: "original" }] } })).rejects.toThrow();
    for (const path of ["/__proto__/polluted", "/reviews/constructor/prototype/polluted", "/reviews/length", "/reviews/1", "/reviews/-", "/missing/child", "/summary/child", "/bad~2escape", "/"]) {
      await expect(submit.tool.execute("unsafe", { repair: [{ path: "/summary", value: "must not persist" }, { path, value: true }] })).rejects.toThrow();
    }
    expect(validate).toHaveBeenCalledTimes(1); expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expect(submit.tool.execute("safe", { repair: [{ path: "/reviews/0/reason", value: "corrected" }] })).rejects.toThrow("synthetic failure");
    expect(validate.mock.calls.at(-1)).toEqual([{ summary: "original", reviews: [{ reason: "corrected" }] }]);
  });

  it("supports missing object fields and JSON Pointer escaping without bypassing validation", async () => {
    let first = true;
    const submit = submissionTool("execute", value => { if (first) { first = false; throw new Error("missing fields"); } return value; });
    await expect(submit.tool.execute("first", { output: { summary: "fixture", result: "done", "a/b~c": {} } })).rejects.toThrow();
    await submit.tool.execute("second", { repair: [{ path: "/a~1b~0c/value", value: 42 }] });
    expect(submit.output).toEqual({ summary: "fixture", result: "done", "a/b~c": { value: 42 } });
  });
});
