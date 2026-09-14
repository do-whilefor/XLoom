/** Offline before/after benchmark. No models, targets or Python. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { observationRetrievalFixture } from "../tests/fixtures/observation-retrieval.js";
import { buildRetrievalIndex } from "../src/wiki/catalog.js";
import { incrementalRetrievalIndex } from "../src/wiki/incremental.js";
import { retrieveWiki } from "../src/wiki/retrieval.js";

const { values } = parseArgs({ options: { baseline: { type: "string" }, size: { type: "string", default: "1000" }, output: { type: "string" } }, strict: true });
const size = Number(values.size);
assert(Number.isSafeInteger(size) && size >= 20 && size <= 10000, "size must be 20–10000");
const root = realpathSync(mkdtempSync(join(tmpdir(), "xloom-rag-benchmark-"))), workspace = process.cwd();
let linked = false;
const board = observationRetrievalFixture(size), before = JSON.stringify(board), query = `item${Math.floor(size / 2)} downloadReport`;
const measure = <T>(run: () => T) => { const start = performance.now(), result = run(); return { ms: +(performance.now() - start).toFixed(2), result }; };
function bench(name: string, api: { buildRetrievalIndex: typeof buildRetrievalIndex; incrementalRetrievalIndex: typeof incrementalRetrievalIndex; retrieveWiki: typeof retrieveWiki }) {
  const task = join(root, name); mkdirSync(task);
  const cold = measure(() => api.incrementalRetrievalIndex(board, task, workspace));
  const warm = Array.from({ length: 5 }, () => measure(() => api.incrementalRetrievalIndex(board, task, workspace)));
  const expected = api.buildRetrievalIndex(board);
  for (const sample of warm) {
    assert.deepEqual(sample.result.index, expected);
    assert.equal(sample.result.stats.indexedBytes, 0);
    assert.equal(sample.result.stats.reused, expected.documents.length);
  }
  const search = Array.from({ length: 5 }, () => measure(() => api.retrieveWiki(board, task, workspace, query, { limit: 1, budgetChars: 16000 })));
  for (const sample of search) {
    assert.equal(sample.result.hits[0]?.ref.id, `F-${Math.floor(size / 2)}`);
    assert.equal(sample.result.budgetDeferredCount, 0);
    assert(JSON.stringify(sample.result.records).includes("Cross-tenant access is NOT verified"));
  }
  const median = (rows: { ms: number }[]) => rows.map(row => row.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]!;
  return { name, records: expected.documents.length, coldMs: cold.ms, warmMedianMs: median(warm), searchMedianMs: median(search),
    warmIndexedBytes: warm[0]!.result.stats.indexedBytes, checks: { fullIndexParity: true, exactQueryRecall: true, negativeConditionRetained: true } };
}
try {
  let baseline;
  if (values.baseline) {
    // A commit only; no untracked user files are copied or modified.
    const revision = execFileSync("git", ["rev-parse", "--verify", `${values.baseline}^{commit}`], { encoding: "utf8" }).trim();
    const baselineRoot = join(root, "baseline-source"); mkdirSync(baselineRoot);
    const archive = join(root, "baseline.tar");
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, revision, "src", "resources", "package.json"]);
    execFileSync("tar", ["-xf", archive, "-C", baselineRoot]);
    symlinkSync(join(workspace, "node_modules"), join(baselineRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir"); linked = true;
    const load = (file: string) => import(pathToFileURL(join(baselineRoot, "src/wiki", file)).href);
    baseline = { revision, ...bench("baseline-cache", { ...await load("catalog.ts"), ...await load("incremental.ts"), ...await load("retrieval.ts") }) };
  }
  const current = bench("current-cache", { buildRetrievalIndex, incrementalRetrievalIndex, retrieveWiki });
  assert.equal(JSON.stringify(board), before);
  const report = { node: process.version, platform: process.platform, size, samples: 5, baseline, current,
    ...(baseline ? { warmSpeedup: +(baseline.warmMedianMs / current.warmMedianMs).toFixed(2), searchSpeedup: +(baseline.searchMedianMs / current.searchMedianMs).toFixed(2) } : {}),
    scope: "Synthetic metadata retrieval only; excludes model latency, original hashing and real-world answer accuracy. Timings vary by machine/load." };
  if (values.output) writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  assert(dirname(root) === realpathSync(tmpdir()) && basename(root).startsWith("xloom-rag-benchmark-"), "Unsafe benchmark cleanup");
  // Remove only the link before recursive cleanup; never traverse dependencies.
  if (linked) unlinkSync(join(root, "baseline-source/node_modules"));
  rmSync(root, { recursive: true, force: true });
}
