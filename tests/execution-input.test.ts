import { describe, expect, it } from "vitest";
import { normalizeExecutionInput } from "../src/loop/execution-input.js";
import { executionSchema } from "../src/schema.js";
import type { BoardSnapshot } from "../src/types.js";

const board = { findings: [{ key: "known-key", title: "Original title" }] } as BoardSnapshot;
const finding = { key: "known-key", status: "lead", factRefs: [], evidenceRefs: [], next: "Review original" };
describe("existing finding update input", () => {
  it("retains only an exact existing title without mutating model input", () => {
    const input = { summary: "Update", result: "done", findings: [finding] };
    const output = executionSchema.parse(normalizeExecutionInput(input, board));
    expect(output.findings![0]!.title).toBe("Original title");
    expect(input.findings[0]).not.toHaveProperty("title");
  });
  it.each([{ key: "new-key" }, { key: "KNOWN-KEY" }, { title: null }, { title: "" }, { mystery: 1 }])("keeps invalid updates subject to strict validation: %j", extra => {
    const input = { summary: "Update", result: "done", findings: [{ ...finding, ...extra }] };
    expect(executionSchema.safeParse(normalizeExecutionInput(input, board)).success).toBe(false);
  });
});
