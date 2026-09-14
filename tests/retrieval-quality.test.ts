import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { evaluateRetrievalQuality } from "./fixtures/retrieval-quality.js";

it("evaluates fixed topic partitions with independent relevance and source/locator checks", () => {
  const root = mkdtempSync(join(tmpdir(), "xloom-quality-test-"));
  try {
    const report = evaluateRetrievalQuality(root);
    expect(report.unchangedBoard).toBe(true);
    expect(report.rows).toHaveLength(20);
    for (const split of report.splits) {
      expect(split.cases).toBe(10); expect(split.recallAt5).toBeGreaterThanOrEqual(0.5);
      expect(split.absentQueriesCorrect).toBe(true); expect(split.sourceAndConditionChecks).toBe(true); expect(split.locatorsValid).toBe(true);
    }
    expect(report.rows.filter(row => row.id.endsWith("-deep")).every(row => row.recalled === 1)).toBe(true);
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("xloom-quality-test-")) throw new Error("Invalid quality fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
