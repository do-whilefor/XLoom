import { describe, expect, it } from "vitest";
import { inspectGoalDeclarations } from "../src/loop/goals.js";
import type { Decision, Goal } from "../src/types.js";

type Declaration = NonNullable<Decision["goals"]>[number];

function root(): Goal {
  return { id: "G0", description: "Inspect the synthetic fixture", parentId: null, status: "active", factIds: ["F-root"] };
}

function declaration(id = "G2", parentId = "G0"): Declaration {
  return { id, description: "Compare the synthetic fixture labels", parentId };
}

describe("Goal declaration identity and history", () => {
  it.each(["active", "satisfied", "abandoned"] as const)("treats an exact repeated %s Goal as a no-op without resetting its evidence", status => {
    const prior: Goal = { ...declaration(), status, factIds: ["F-observed", "F-reviewed"] };
    const existing = [root(), prior];
    const declarations = [declaration()];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toEqual([]);
    expect(result.additions).toEqual([]);
    expect(result.goals.get(prior.id)).toBe(prior);
    expect(result.goals.get(prior.id)).toEqual(original.existing[1]);
    expect({ existing, declarations }).toEqual(original);
  });

  it("creates identical same-batch declarations once and lets a later child use that parent", () => {
    const existing = [root()];
    const declarations = [declaration(), declaration(), declaration("G-child", "G2")];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toEqual([]);
    expect(result.additions).toEqual([
      { ...declarations[0], status: "active", factIds: [] },
      { ...declarations[2], status: "active", factIds: [] },
    ]);
    expect([...result.goals.keys()]).toEqual(["G0", "G2", "G-child"]);
    expect({ existing, declarations }).toEqual(original);
  });

  it.each([
    { description: "Compare a different synthetic fixture" },
    { description: "COMPARE THE SYNTHETIC FIXTURE LABELS" },
    { description: "Compare  the synthetic fixture labels" },
    { parentId: "G-other" },
  ])("rejects an existing ID with changed identity %j instead of replacing its history", changed => {
    const prior: Goal = { ...declaration(), status: "satisfied", factIds: ["F-original"] };
    const otherParent: Goal = { ...declaration("G-other"), status: "active", factIds: [] };
    const existing = [root(), otherParent, prior];
    const declarations = [{ ...declaration(), ...changed }];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('goals[0].id="G2"');
    expect(result.errors[0]).toContain("different description or parent");
    expect(result.additions).toEqual([]);
    expect(result.goals.get("G2")).toBe(prior);
    expect({ existing, declarations }).toEqual(original);
  });

  it.each([
    { description: "Another fixture check" },
    { parentId: "G-parent" },
  ])("rejects conflicting same-batch reuse %j and keeps the first declaration", changed => {
    const existing = [root()];
    const first = declaration();
    const declarations = [declaration("G-parent"), first, { ...first, ...changed }];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('goals[2].id="G2"');
    expect(result.goals.get("G2")).toEqual({ ...first, status: "active", factIds: [] });
    expect(result.additions.filter(goal => goal.id === "G2")).toHaveLength(1);
    expect({ existing, declarations }).toEqual(original);
  });

  it("cannot replace G0 or turn the root into its own child", () => {
    const existing = [root()];
    const original = structuredClone(existing);
    const result = inspectGoalDeclarations(existing, [{ id: "G0", description: existing[0]!.description, parentId: "G0" }]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Goal G0 already exists");
    expect(result.additions).toEqual([]);
    expect(result.goals.get("G0")).toBe(existing[0]);
    expect(existing).toEqual(original);
  });

  it.each(["satisfied", "abandoned"] as const)("accepts an exact historical declaration even when its parent is now %s", parentStatus => {
    const parent: Goal = { ...declaration("G-parent"), status: parentStatus, factIds: ["F-parent"] };
    const prior: Goal = { ...declaration("G-child", "G-parent"), status: "satisfied", factIds: ["F-child"] };
    const existing = [root(), parent, prior];
    const original = structuredClone(existing);

    const result = inspectGoalDeclarations(existing, [declaration("G-child", "G-parent")]);

    expect(result.errors).toEqual([]);
    expect(result.additions).toEqual([]);
    expect(result.goals.get("G-child")).toBe(prior);
    expect(existing).toEqual(original);
  });
});

describe("new Goal parent constraints", () => {
  it.each(["satisfied", "abandoned"] as const)("does not reopen a %s parent by repeating it before creating a child", status => {
    const parent: Goal = { ...declaration(), status, factIds: ["F-parent-history"] };
    const existing = [root(), parent];
    const declarations = [declaration(), declaration("G-child", "G2")];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('goals[1].parentId="G2"');
    expect(result.errors[0]).toContain(`has status ${status}`);
    expect(result.additions).toEqual([]);
    expect(result.goals.get("G2")).toBe(parent);
    expect(result.goals.has("G-child")).toBe(false);
    expect({ existing, declarations }).toEqual(original);
  });

  it.each(["G-missing", "G-child"])("rejects missing or self-referencing parent %s without adding the child", parentId => {
    const existing = [root()];
    const declarations = [declaration("G-child", parentId)];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`goals[0].parentId="${parentId}"`);
    expect(result.additions).toEqual([]);
    expect(result.goals.has("G-child")).toBe(false);
    expect({ existing, declarations }).toEqual(original);
  });

  it("rejects a parent declared later without reordering the batch", () => {
    const existing = [root()];
    const declarations = [declaration("G-child", "G-parent"), declaration("G-parent")];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('goals[0].parentId="G-parent"');
    expect(result.goals.has("G-child")).toBe(false);
    expect(result.additions.map(goal => goal.id)).toEqual(["G-parent"]);
    expect({ existing, declarations }).toEqual(original);
  });

  it("accepts earlier active parents through a new hierarchy", () => {
    const existing = [root()];
    const declarations = [declaration("G-parent"), declaration("G-child", "G-parent"), declaration("G-leaf", "G-child")];
    const original = structuredClone({ existing, declarations });

    const result = inspectGoalDeclarations(existing, declarations);

    expect(result.errors).toEqual([]);
    expect(result.additions.map(goal => [goal.id, goal.parentId, goal.status])).toEqual([
      ["G-parent", "G0", "active"], ["G-child", "G-parent", "active"], ["G-leaf", "G-child", "active"],
    ]);
    expect({ existing, declarations }).toEqual(original);
  });
});
