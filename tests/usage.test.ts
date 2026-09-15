import { describe, expect, it } from "vitest";
import { addUsage, cacheInput, modelUsage } from "../src/usage.js";
import { usageSchema } from "../src/schema.js";

describe("cache token accounting", () => {
  it("includes cache writes in input but only cache reads in hits", () => {
    const value = modelUsage({ input: 100, output: 20, cacheRead: 60, cacheWrite: 40, totalTokens: 220,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } });
    expect(value).toEqual({ input: 200, output: 20, cost: 10, cacheRead: 60, cacheInput: 200 });
    expect(value.input + value.output).toBe(220);
    expect(usageSchema.parse(value)).toEqual(value);
  });

  it("preserves unknown historical coverage in both addition orders", () => {
    const old = { input: 1000, output: 100, cost: 1 };
    const fresh = { input: 200, output: 10, cost: 2, cacheRead: 150 };
    const expected = { input: 1200, output: 110, cost: 3, cacheRead: 150, cacheInput: 200 };
    expect(addUsage({ ...old }, fresh)).toEqual(expected);
    expect(addUsage({ ...fresh }, old)).toEqual(expected);
    expect(addUsage({ ...expected }, fresh)).toEqual({ input: 1400, output: 120, cost: 5, cacheRead: 300, cacheInput: 400 });
    expect(old).toEqual({ input: 1000, output: 100, cost: 1 });
    expect(cacheInput(old)).toBe(0);
  });

  it("retains old usage unchanged and distinguishes measured zero hits", () => {
    const old = { input: 10, output: 2, cost: 0 };
    expect(usageSchema.parse(old)).toEqual(old);
    expect(addUsage({ input: 0, output: 0, cost: 0 }, old)).toEqual(old);
    expect(cacheInput({ ...old, cacheRead: 0 })).toBe(10);
  });

  it.each([
    { cacheRead: -1 }, { cacheRead: NaN }, { cacheRead: Infinity }, { cacheRead: 101 },
    { cacheInput: 100 }, { cacheRead: 20, cacheInput: 10 }, { cacheRead: 20, cacheInput: 101 },
  ])("rejects invalid cache measurements %j", extra => {
    expect(usageSchema.safeParse({ input: 100, output: 5, cost: 0, ...extra }).success).toBe(false);
  });
});
