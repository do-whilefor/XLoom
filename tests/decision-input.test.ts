import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { decisionSchema } from "../src/schema.js";
import { decisionRepairGuidance, normalizeDecisionInput } from "../src/loop/decision-input.js";
import type { BoardSnapshot } from "../src/types.js";

const board: BoardSnapshot = { revision: 0, config: defaultConfig("Synthetic protocol fixture"), status: "running", outcome: null, reason: "", goals: [], facts: [], steps: [], evidence: [], findings: [], hints: [], usage: { input: 0, output: 0, cost: 0 }, completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0 };
const step = { goalId: "G0", from: ["F-fixture"], description: "Check the synthetic fixture", successSignal: "Recorded fixture", evidencePlan: "Original fixture", priority: 10 };
const combination = { requires: ["F-fixture"], missing: ["Unverified fixture condition"], scope: "fixture only", stateVersion: "v1", expectedCapability: "Fixture result", counterEvidence: ["F-counter"] };

describe("conservative model decision format compatibility", () => {
  it("nests misplaced combination fields without changing or losing any requirement", () => {
    const input = { summary: "Synthetic fixture", steps: [{ ...step, ...combination }] }, original = structuredClone(input);
    const result = normalizeDecisionInput(input, board);
    expect(decisionSchema.parse(result.value)).toEqual({ summary: input.summary, steps: [{ ...step, combination }] });
    expect(input).toEqual(original); expect(result.changes).toHaveLength(1);
  });

  it("removes only unused, unique new Step labels before the controller allocates IDs", () => {
    const input = { summary: "New fixture work", steps: [{ ...step, id: "S-local-new", ...combination }] };
    const normalized = normalizeDecisionInput(input, board);
    expect(decisionSchema.parse(normalized.value).steps![0]).toEqual({ ...step, combination });
    expect(normalized.changes).toHaveLength(2); expect(input.steps[0]!.id).toBe("S-local-new");
  });

  it.each(["existing", "duplicate", "reference", "summary_reference", "invalid_label"])("rejects ambiguous %s IDs without changing the proposal", kind => {
    const input = { summary: "Fixture", steps: [{ ...step, id: "S-local-new" }], updateSteps: [] as { id: string; action: string; reason: string }[] };
    const snapshot = structuredClone(board);
    if (kind === "existing") snapshot.steps.push({ ...step, id: "S-local-new", status: "ready", attempts: 0, runId: null, leaseUntil: null });
    if (kind === "duplicate") input.steps.push({ ...input.steps[0]!, description: "Another fixture" });
    if (kind === "reference") input.updateSteps.push({ id: "S-local-new", action: "prioritize", reason: "Fixture" });
    if (kind === "summary_reference") input.summary = "Next execute S-local-new";
    if (kind === "invalid_label") input.steps[0]!.id = "not-a-step-id";
    const before = structuredClone(input);
    expect(() => normalizeDecisionInput(input, snapshot)).toThrow(/Step|Steps/); expect(input).toEqual(before);
  });

  it("rejects conflicting nested fields, and leaves unknown/missing fields to strict validation", () => {
    expect(() => normalizeDecisionInput({ summary: "Fixture", steps: [{ ...step, ...combination, combination: { ...combination, missing: ["Another condition"] } }] }, board)).toThrow(/Conflicting/);
    for (const extra of [{ mystery: "must not be dropped" }, { requires: ["F-fixture"] }, { combination: { ...combination, missing: null } }]) {
      const result = normalizeDecisionInput({ summary: "Fixture", steps: [{ ...step, ...extra }] }, board);
      expect(decisionSchema.safeParse(result.value).success).toBe(false);
    }
  });

  it("keeps valid existing updates and canonical conditions untouched", () => {
    const input = { summary: "Fixture", steps: [{ ...step, combination }], updateSteps: [{ id: "S-existing", action: "prioritize", priority: 80, reason: "Fixture" }] };
    expect(normalizeDecisionInput(input, board)).toEqual({ value: input, changes: [] });
    expect(decisionRepairGuidance("steps.0: Unrecognized key(s) in object: 'id'")).toContain("Preserve all prerequisite and counterevidence values");
    expect(decisionRepairGuidance("Unknown Fact")).toBe("");
  });

  it("rejects an empty combination without dropping its unverified conditions", () => {
    const input = { summary: "First observation", steps: [{ ...step, from: [], combination: { ...combination, requires: [], counterEvidence: [] } }] };
    expect(normalizeDecisionInput(input, board)).toEqual({ value: input, changes: [] });
    expect(decisionSchema.safeParse(input).success).toBe(false);
    const guidance = decisionRepairGuidance("steps.0.combination.requires: Array must contain at least 1 element(s)");
    expect(guidance).toContain("omit combination and retain every unverified condition");
    expect(guidance).toContain("Never invent a Fact ID or discard conditions");
  });
});
