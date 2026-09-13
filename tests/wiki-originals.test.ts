import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import type { BoardSnapshot } from "../src/types.js";
import { gapReadPath } from "../src/knowledge/gaps.js";
import { searchOriginals, readOriginal } from "../src/wiki/originals.js";
import { retrieveQuestion } from "../src/wiki/questions.js";
import { retrievalContext } from "../src/wiki/retrieval.js";
import { runLocal } from "../src/wiki/local.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("xloom-originals-")) throw new Error("Invalid fixture cleanup path");
  rmSync(root, { recursive: true, force: true });
} });
function fixture(body = "unrelated prefix\n".repeat(5000) + "downloadGrant=LOCAL_FIXTURE; 下载授权仅供本地测试。 Actual download remains unverified.\n") {
  const root = mkdtempSync(join(tmpdir(), "xloom-originals-")); roots.push(root); mkdirSync(join(root, "evidence"));
  const file = join(root, "evidence", "original.txt"); writeFileSync(file, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const board: BoardSnapshot = { revision: 4, config: defaultConfig("WHOLE_GOAL_SHOULD_NOT_OVERRIDE_GAP"), status: "paused", outcome: null, reason: "Fixture",
    goals: [{ id: "G0", parentId: null, description: "Fixture", status: "active", factIds: [] }],
    steps: [{ id: "S-old", goalId: "G0", from: [], description: "Old download attempt", successSignal: "Recorded local result", evidencePlan: "Fixture", status: "blocked", priority: 1, attempts: 1, runId: null, leaseUntil: null,
      gaps: [{ id: "gap-download", missing: "downloadGrant 下载授权", why: "Need download permission", reopenWhen: "A grant is observed", needs: [],
        conditions: { scope: "local report", identity: "alice", environment: "fixture", stateVersion: "v1" }, sources: [] }] }],
    evidence: [{ id: "E-one", path: "evidence/original.txt", pathBase: "task", sha256, bytes: Buffer.byteLength(body), description: "Generic metadata without the query", stepId: "S-old", runId: "R" }],
    facts: [{ id: "F-one", description: "Generic observation", stepId: "S-old", evidenceIds: ["E-one"] }], findings: [], hints: [],
    usage: { input: 0, output: 0, cost: 0 }, completedSteps: 1, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0 };
  return { board, root, file, body };
}
const ref = { stepId: "S-old", gapId: "gap-download" };

describe("gap-driven original search and located reading", () => {
  it("finds content beyond metadata/excerpts and reads exactly the hashed source range", () => {
    const { board, root, body } = fixture(), before = structuredClone(board);
    const result = searchOriginals(board, root, root, "downloadGrant 下载授权");
    expect(result).toMatchObject({ complete: true, inspectedCount: 1 }); expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!; expect(hit.locator.byteOffset).toBeGreaterThan(64 * 1024);
    const read = readOriginal(board, root, root, hit.locator);
    expect(read.text).toBe(Buffer.from(body).subarray(hit.locator.byteOffset, hit.locator.byteOffset + hit.locator.byteLength).toString("utf8"));
    expect(read.text).toContain("Actual download remains unverified"); expect(read.integrity).toBe("verified"); expect(board).toEqual(before);
  });
  it("preserves UTF-8 matches across stream boundaries and minified single-line originals", () => {
    for (const body of ["x ".repeat(32762) + "边界下载授权下载授权 ends", "x ".repeat(90000) + "downloadGrant LOCAL_ONLY"]) {
      const { board, root } = fixture(body);
      const result = searchOriginals(board, root, root, body.includes("LOCAL_ONLY") ? "downloadGrant" : "下载授权");
      expect(result.complete).toBe(true); expect(result.hits.length).toBeGreaterThan(0);
      expect(readOriginal(board, root, root, result.hits[0]!.locator).text).toContain(body.includes("LOCAL_ONLY") ? "downloadGrant" : "下载授权");
      for (const hit of result.hits) expect(readOriginal(board, root, root, hit.locator).text).toBe(hit.snippet);
    }
  });
  it.each(["tampered", "missing", "binary"])("reports %s originals as incomplete and withholds hits", kind => {
    const { board, root, file } = fixture();
    if (kind === "missing") unlinkSync(file);
    else if (kind === "tampered") { const b = readFileSync(file); b[b.length - 2]! ^= 1; writeFileSync(file, b); }
    else { writeFileSync(file, Buffer.from([0, 255])); board.evidence[0]!.sha256 = createHash("sha256").update(readFileSync(file)).digest("hex"); board.evidence[0]!.bytes = 2; }
    expect(searchOriginals(board, root, root, "downloadGrant")).toMatchObject({ complete: false, hits: [], issues: [expect.objectContaining({ evidenceId: "E-one" })] });
  });
  it("rejects stale locators, unknown IDs, invalid ranges and UTF-8 cuts", () => {
    const { board, root } = fixture("下载授权 downloadGrant"); const locator = searchOriginals(board, root, root, "downloadGrant").hits[0]!.locator;
    for (const extra of [{ evidenceId: "E-other-task" }, { sha256: "stale" }, { byteOffset: -1 }, { byteLength: 9000 }, { byteOffset: 1, byteLength: 1 }])
      expect(() => readOriginal(board, root, root, { ...locator, ...extra })).toThrow();
  });
  it("does not search unregistered/private files or follow archive directory links", () => {
    const { board, root } = fixture(); mkdirSync(join(root, "runs")); writeFileSync(join(root, "runs", "private.txt"), "privateNeedle");
    expect(searchOriginals(board, root, root, "privateNeedle").hits).toEqual([]);
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "other.txt"), "privateNeedle");
    symlinkSync(outside, join(root, "evidence", "linked"), "junction"); board.evidence[0]!.path = "evidence/linked/other.txt";
    expect(searchOriginals(board, root, root, "privateNeedle")).toMatchObject({ complete: false, hits: [] });
  });
  it("binds search to the gap and carries source corrections into the question package", () => {
    const { board, root } = fixture(); board.facts.push({ id: "F-correction", description: "Countercondition requires a new local check", stepId: "S-old", evidenceIds: ["E-one"], supersedes: "F-one" });
    const result = retrieveQuestion(board, root, root, ref);
    expect(result).toMatchObject({ queryOrigin: "step_gap", answerSupport: "not_assessed", question: { conditions: { identity: "alice" }, state: "review_required" } });
    expect(JSON.stringify(result)).toContain("F-correction"); expect(JSON.stringify(result)).toContain("downloadGrant");
    expect(retrieveQuestion(board, root, root, ref, { budgetChars: 128 })).toMatchObject({ status: "budget_exhausted", complete: false });
    expect(() => retrieveQuestion(board, root, root, { ...ref, gapId: "gap-unknown" })).toThrow("Unknown");
    const context = retrievalContext({ id: "R", mode: "decide", snapshot: board, workspace: root, runDir: join(root, "runs", "R"), blackboardPath: join(root, "blackboard.md"), signal: new AbortController().signal, onEvent() {} });
    expect(context).toMatchObject({ queryOrigin: "step_gap", query: "downloadGrant 下载授权", questions: [expect.objectContaining({ readPath: gapReadPath(ref) })] });
  });
  it("uses native read for gap search and original reading, detects unchanged repeated queries, and isolates readers", async () => {
    const { board, root } = fixture(); const tool = createWorkspaceReadTool(root, undefined, { dataDir: root, snapshot: () => board });
    const read = async (path: string) => JSON.parse((await tool.execute("read", { path })).content[0]!.text as string);
    const first = await read(gapReadPath(ref)); expect(first.retrievalProgress).toBe("inspect_material");
    expect((await read(first.originals.hits[0].readPath)).text).toContain("downloadGrant");
    expect((await read(gapReadPath(ref))).retrievalProgress).toBe("stop_repeating_query");
    board.revision++;
    expect((await read(gapReadPath(ref))).retrievalProgress).toBe("inspect_material");
    const isolated = createWorkspaceReadTool(root);
    await expect(isolated.execute("read", { path: first.originals.hits[0].readPath })).rejects.toThrow("outside a research task");
    await expect(tool.execute("read", { path: gapReadPath(ref) + "&stepId=other" })).rejects.toThrow("duplicate");
    await expect(tool.execute("read", { path: gapReadPath(ref), offset: 2 })).rejects.toThrow("URI parameters");
  });
  it("exposes the same read-only workflow through the installed local command", () => {
    const { board, root } = fixture(); const db = new DatabaseSync(join(root, "blackboard.sqlite"));
    db.exec("CREATE TABLE board(id INTEGER PRIMARY KEY,value TEXT)"); const saved = JSON.stringify(board); db.prepare("INSERT INTO board VALUES(1,?)").run(saved);
    try {
      const common = ["--task", root, "--workspace", root];
      const result = runLocal(["question", ...common, "--step", ref.stepId, "--gap", ref.gapId]).output as any;
      expect(result.originals.hits).toHaveLength(1);
      const locator = result.originals.hits[0].locator;
      expect(runLocal(["read-original", ...common, "--evidence", locator.evidenceId, "--sha256", locator.sha256, "--byte-offset", String(locator.byteOffset), "--byte-length", String(locator.byteLength)]).output).toMatchObject({ integrity: "verified" });
      expect(runLocal(["search-originals", ...common, "--query", "downloadGrant"]).output).toMatchObject({ inspectedCount: 1 });
      expect(runLocal(["search-originals", ...common, "--query", "downloadGrant", "--refresh"]).output).toMatchObject({ index: { updated: 1, reused: 0, indexedBytes: board.evidence[0]!.bytes } });
      expect(db.prepare("SELECT value FROM board WHERE id=1").get()!.value).toBe(saved);
    } finally { db.close(); }
  });
});
