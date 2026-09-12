import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { defaultLoopPolicy, type LoopPolicy } from "../src/loop/policy.js";
import type { BoardSnapshot, Fact, Finding, Step } from "../src/types.js";

function step(id = "S1", patch: Partial<Step> = {}): Step {
  return { id, goalId: "G0", from: [], description: "Compare local synthetic fixtures", successSignal: "A fixture result",
    evidencePlan: "Save fixture evidence", priority: 50, status: "ready", attempts: 0, runId: null, leaseUntil: null, ...patch };
}

function board(patch: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return { revision: 0, config: defaultConfig("Complete a local synthetic fixture task"), status: "running", outcome: null, reason: "",
    goals: [{ id: "G0", description: "Complete fixture task", parentId: null, status: "active", factIds: [] }],
    facts: [], steps: [step()], findings: [], evidence: [], hints: [], usage: { input: 0, output: 0, cost: 0 },
    completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0, ...patch };
}

function finding(patch: Partial<Finding> = {}): Finding {
  return { id: "V1", key: "fixture", target: "local fixture", title: "Synthetic hypothesis", status: "technical_hit", rating: "unrated",
    evidenceIds: ["E1"], factIds: ["F1"], next: "Verify synthetic impact", ...patch };
}

const fact = (id: string, supersedes?: string): Fact => ({ id, description: "Synthetic observation", stepId: "S1", evidenceIds: ["E1"], ...(supersedes ? { supersedes } : {}) });

function settled(before: BoardSnapshot, patch: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return { ...structuredClone(before), revision: before.revision + 1, completedSteps: before.completedSteps + 1, steps: [step("S1", { status: "done" })], ...patch };
}

describe("outer-loop Step selection", () => {
  it("selects only ready Steps, descending priority and stable ID for ties", () => {
    const snapshot = board({ steps: [step("S3", { priority: 60 }), step("S1", { status: "claimed", priority: 100 }), step("S2", { priority: 60 }), step("S0", { priority: 30 })] });
    expect(defaultLoopPolicy.selectStep(snapshot)?.id).toBe("S2");
    expect(snapshot.steps.map(item => item.id)).toEqual(["S3", "S1", "S2", "S0"]);
  });

  it.each(["claimed", "done", "no_progress", "blocked", "failed", "abandoned"] as const)("never replays a %s Step", status => {
    expect(defaultLoopPolicy.selectStep(board({ steps: [step("S1", { status })] }))).toBeUndefined();
  });

  it("returns no action for an empty plan without generating one or completing the Goal", () => {
    const snapshot = board({ steps: [] });
    expect(defaultLoopPolicy.selectStep(snapshot)).toBeUndefined();
    expect(snapshot.goals[0].status).toBe("active");
    expect(snapshot.outcome).toBeNull();
  });

  it("allows a different scheduling implementation through the interface", () => {
    const policy: LoopPolicy = { selectStep: snapshot => snapshot.steps.find(item => item.status === "ready" && item.id === "S3"), reviewAfterExecution: () => undefined };
    expect(policy.selectStep(board({ steps: [step(), step("S3")] }))?.id).toBe("S3");
  });
});

describe("outer-loop review triggers", () => {
  it("does not review a normal successful Step before the periodic boundary", () => {
    const before = board();
    expect(defaultLoopPolicy.reviewAfterExecution(before, settled(before), "S1")).toBeUndefined();
  });

  it("prioritizes blocked over hit, fact revision, stagnation and periodic review", () => {
    const before = board();
    const after = settled(before, { steps: [step("S1", { status: "blocked" })], findings: [finding()], facts: [fact("F2", "F1")], noProgressCount: 3, completedSteps: 3 });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")).toMatchObject({ kind: "blocked", reason: expect.stringContaining("S1") });
  });

  it("prioritizes a new technical hit over fact revision, stagnation and periodic review", () => {
    const before = board();
    const after = settled(before, { findings: [finding()], facts: [fact("F2", "F1")], noProgressCount: 3, completedSteps: 3 });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")).toMatchObject({ kind: "technical_hit", reason: expect.stringContaining("impact chain") });
  });

  it.each([
    { status: "lead" as const },
    { status: "closed" as const },
    { evidenceIds: [] },
    { factIds: [] },
  ])("reviews newly supported/reopened technical hits (%j)", prior => {
    const before = board({ findings: [finding(prior)] });
    const after = settled(before, { findings: [finding()] });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")?.kind).toBe("technical_hit");
  });

  it("does not repeat hit review when another Step leaves its support unchanged", () => {
    const before = board({ findings: [finding()] });
    const after = settled(before, { facts: [fact("F-unrelated")], findings: [finding({ next: "Reworded next action", title: "Reworded title" })] });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")).toBeUndefined();
    expect(defaultLoopPolicy.reviewAfterExecution(after, settled(after), "S1")).toBeUndefined();
  });

  it("treats support IDs as sets rather than order-sensitive chat changes", () => {
    const before = board({ findings: [finding({ evidenceIds: ["E1", "E2"], factIds: ["F1", "F2"] })] });
    const after = settled(before, { findings: [finding({ evidenceIds: ["E2", "E1", "E2"], factIds: ["F2", "F1"] })] });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")).toBeUndefined();
  });

  it.each(["lead", "closed", "impact_verified"] as const)("does not treat a %s finding as a new technical hit", status => {
    const before = board();
    expect(defaultLoopPolicy.reviewAfterExecution(before, settled(before, { findings: [finding({ status })] }), "S1")).toBeUndefined();
  });

  it("prioritizes a newly superseding Fact over stagnation and periodic review", () => {
    const before = board({ facts: [fact("F1")] });
    const after = settled(before, { facts: [fact("F1"), fact("F2", "F1")], noProgressCount: 3, completedSteps: 3 });
    const review = defaultLoopPolicy.reviewAfterExecution(before, after, "S1");
    expect(review).toMatchObject({ kind: "fact_revision", reason: expect.stringContaining("F2 supersedes F1") });
    expect(review?.reason).toContain("dependent assumptions");
  });

  it("does not repeatedly review an already known superseding Fact", () => {
    const before = board({ facts: [fact("F1"), fact("F2", "F1")] });
    expect(defaultLoopPolicy.reviewAfterExecution(before, settled(before, { facts: [...before.facts, fact("F3")] }), "S1")).toBeUndefined();
  });

  it("prioritizes stagnation over periodic review and asks for a changed variable", () => {
    const before = board({ completedSteps: 2, noProgressCount: 2 });
    const after = settled(before, { noProgressCount: 3, steps: [step("S1", { status: "no_progress" })] });
    const review = defaultLoopPolicy.reviewAfterExecution(before, after, "S1");
    expect(review?.kind).toBe("stagnation");
    expect(review?.reason).toMatch(/change an identity, object, entry point, state or request shape/);
    expect(after.status).toBe("running");
    expect(after.outcome).toBeNull();
    expect(after.goals[0].status).toBe("active");
  });

  it("does not force a review for one no-progress result below both thresholds", () => {
    const before = board();
    const after = settled(before, { noProgressCount: 1, steps: [step("S1", { status: "no_progress" })] });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")).toBeUndefined();
  });

  it.each([3, 4])("reviews at or beyond the periodic boundary (%i Steps)", completedSteps => {
    const before = board({ completedSteps: completedSteps - 1 });
    expect(defaultLoopPolicy.reviewAfterExecution(before, settled(before), "S1")?.kind).toBe("periodic");
  });

  it("measures the periodic interval from the last review, not the first Step", () => {
    const before = board({ completedSteps: 8, lastMetaStep: 7 });
    expect(defaultLoopPolicy.reviewAfterExecution(before, settled(before), "S1")).toBeUndefined();
    const next = settled(before);
    expect(defaultLoopPolicy.reviewAfterExecution(next, settled(next), "S1")?.kind).toBe("periodic");
  });

  it("does not trigger a periodic review at a zero-Step boundary", () => {
    const snapshot = board();
    expect(defaultLoopPolicy.reviewAfterExecution(snapshot, structuredClone(snapshot), "S1")).toBeUndefined();
  });

  it("defensively disables periodic scheduling for an unvalidated zero interval", () => {
    const before = board();
    before.config.limits.metacogEvery = 0;
    expect(defaultLoopPolicy.reviewAfterExecution(before, settled(before), "S1")).toBeUndefined();
  });

  it.each(["ready", "claimed", "failed", "abandoned"] as const)("does not treat a %s Step as a settled execution", status => {
    const before = board();
    const after = settled(before, { findings: [finding()], steps: [step("S1", { status })] });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")).toBeUndefined();
  });

  it("does not review an absent Step", () => {
    const before = board();
    expect(defaultLoopPolicy.reviewAfterExecution(before, settled(before), "missing")).toBeUndefined();
  });

  it("does not change board state, produce a conclusion/rating or impose a Step limit", () => {
    const before = board({ completedSteps: 240, lastMetaStep: 239, findings: [finding()] });
    const after = settled(before);
    const original = structuredClone({ before, after });
    expect(defaultLoopPolicy.reviewAfterExecution(before, after, "S1")).toBeUndefined();
    expect({ before, after }).toEqual(original);
    expect(defaultLoopPolicy.selectStep(board({ steps: [step()], completedSteps: 241 }))?.id).toBe("S1");
  });
});
