import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { evaluateRetrievalQuality } from "../tests/fixtures/retrieval-quality.js";

const { values } = parseArgs({ options: { output: { type: "string" }, baseline: { type: "string" } }, strict: true });
const root = mkdtempSync(join(tmpdir(), "xloom-quality-"));
const result = evaluateRetrievalQuality(root);
const baseline = values.baseline ? JSON.parse(readFileSync(resolve(values.baseline), "utf8")) as { splits: typeof result.splits } : undefined;
const report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), node: process.version, root, ...result,
  comparison: baseline?.splits.map(old => ({ split: old.split, beforeRecallAt5: old.recallAt5, afterRecallAt5: result.splits.find(row => row.split === old.split)!.recallAt5 })) };
const output = resolve(values.output ?? join(root, "report.json")); mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, splits: report.splits, comparison: report.comparison, unchangedBoard: report.unchangedBoard }, null, 2));
if (!report.unchangedBoard || report.splits.some(split => !split.absentQueriesCorrect || !split.sourceAndConditionChecks || !split.locatorsValid)) process.exitCode = 1;
