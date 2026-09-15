import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { submissionTool } from "../src/runtime/submission.js";

describe("private proposal repair", () => {
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
