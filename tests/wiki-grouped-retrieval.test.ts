import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retrievalQualityFixture } from "./fixtures/retrieval-quality.js";
import { retrieveWiki, retrievalContext } from "../src/wiki/retrieval.js";
import { searchOriginals, readOriginal } from "../src/wiki/originals.js";
import { retrieveQuestion } from "../src/wiki/questions.js";
import { gapSearchGroups } from "../src/knowledge/gaps.js";
import { compileQueryGroups } from "../src/wiki/search-groups.js";
import { createTaskReader } from "../src/wiki/read.js";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "xloom-grouped-")); roots.push(root); return { root, ...retrievalQualityFixture(root) }; }
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("xloom-grouped-")) throw new Error("Invalid grouped fixture cleanup");
  rmSync(root, { recursive: true, force: true });
} });

describe("declared prerequisite retrieval", () => {
  it("reserves a top-two slot for each input and describes matches without asserting satisfaction", () => {
    const { root, board, cases } = fixture(), query = cases.find(item => item.id === "export-multi-wiki")!, before = structuredClone(board);
    const result = retrieveWiki(board, root, root, query.query, { queryGroups: query.groups, limit: 2 });
    expect(result.hits.map(hit => hit.ref.id)).toContain("F-export-handle");
    expect(result.queryGroups?.map(group => group.fullExpressionHits)).toEqual([1, 1]);
    expect(result.hits.find(hit => hit.ref.id === "F-export-handle")?.matches).toContainEqual({ groupId: "need:1", expression: "reportKey", field: "title", coverage: "full_expression" });
    expect(result.evidence).toBe(false); expect(board).toEqual(before);
    const original = searchOriginals(board, root, root, query.query, 2, false, query.groups);
    expect(original.hits.map(hit => hit.locator.evidenceId)).toContain("E-export-handle");
    expect(original.queryGroups?.map(group => group.fullExpressionWindows)).toEqual([1, 1]);
  });
  it("keeps explicit refs first, rejects malformed groups and does not infer unseen synonyms", () => {
    const { root, board } = fixture();
    const groups = [{ id: "need:0", alternatives: ["objectHandle"] }];
    expect(retrieveWiki(board, root, root, "F-export-grant", { queryGroups: groups, limit: 1 }).hits[0]!.reason).toBe("exact_reference");
    expect(retrieveWiki(board, root, root, "objectHandle", { queryGroups: groups }).hits).toEqual([]);
    for (const invalid of [[], [{ id: "", alternatives: ["x"] }], [{ id: "x", alternatives: [] }], [groups[0]!, groups[0]!]])
      expect(() => compileQueryGroups("x", invalid)).toThrow("Invalid");
    expect(() => compileQueryGroups("x ".repeat(3000))).not.toThrow();
  });
  it("deduplicates repeated expressions, identifies explicit Wiki aliases, and preserves full source packages", () => {
    const { root, board } = fixture();
    const result = retrieveWiki(board, root, root, "exportBoundaryNote", { queryGroups: [{ id: "first", alternatives: ["exportBoundaryNote", "exportBoundaryNote"] }, { id: "second", alternatives: ["exportBoundaryNote"] }], limit: 5 });
    expect(new Set(result.hits.map(hit => JSON.stringify(hit.ref))).size).toBe(result.hits.length);
    expect(result.hits[0]!.matches?.every(match => match.field === "alias")).toBe(true);
    expect(JSON.stringify(result.records)).toContain("F-export-correction"); expect(JSON.stringify(result.records)).toContain("bob/v2");
    const small = retrieveWiki(board, root, root, "exportBoundaryNote", { budgetChars: 128 });
    expect(small.hits).toEqual([]); expect(small.records).toEqual([]); expect(small.budgetDeferredCount).toBeGreaterThan(0);
  });
  it("uses the same declared groups in question, automatic context and native read; explicit queries override them", () => {
    const { root, board } = fixture(), step = board.steps[0]!;
    step.gaps = [{ id: "gap-download", missing: "Inspect required inputs", why: "Need both inputs", reopenWhen: "Both inputs observed under matching conditions",
      needs: [{ type: "downloadGrant", aliases: ["exportPermit", "reportTicket"], description: "grant for download" },
        { type: "objectHandle", aliases: ["reportKey", "resultRef"], description: "object to download" }],
      conditions: { scope: "fixture", identity: "alice", environment: "local", stateVersion: "v1" }, sources: [] }];
    const before = structuredClone(board), ref = { stepId: step.id, gapId: "gap-download" };
    expect(gapSearchGroups(step.gaps[0]!)!.map(group => group.id)).toEqual(["need:0", "need:1", "question"]);
    const question = retrieveQuestion(board, root, root, ref, { budgetChars: 64000, limit: 2 });
    expect(question).toMatchObject({ complete: true, answerSupport: "not_assessed", originals: { hits: expect.arrayContaining([expect.objectContaining({ locator: expect.objectContaining({ evidenceId: "E-export-handle" }) })]) } });
    const reader = createTaskReader(root, { dataDir: root, snapshot: () => board });
    const path = `xloom://question?stepId=${step.id}&gapId=gap-download&budgetChars=64000&limit=2`;
    expect(reader(path)).toMatchObject({ complete: true, retrievalProgress: "inspect_material" });
    expect(reader(path)).toMatchObject({ retrievalProgress: "stop_repeating_query" });
    const smaller = retrieveQuestion(board, root, root, ref, { budgetChars: 16000, limit: 2 });
    expect(smaller).toMatchObject({ complete: false, status: "source_package_deferred" });
    expect(smaller).toHaveProperty("nextReadPath");
    if (!("nextReadPath" in smaller) || typeof smaller.nextReadPath !== "string") throw new Error("Missing source-package continuation");
    expect(reader(smaller.nextReadPath)).toMatchObject({ complete: true });
    const overflow = retrieveQuestion(board, root, root, ref, { budgetChars: 1500, query: "REVOKED", limit: 2 });
    expect(overflow).toMatchObject({ complete: false, status: "budget_exhausted" });
    if (!("nextReadPath" in overflow) || typeof overflow.nextReadPath !== "string") throw new Error("Missing overflow continuation");
    const next = new URL(overflow.nextReadPath);
    expect(next.searchParams.get("query")).toBe("REVOKED"); expect(next.searchParams.get("limit")).toBe("2");
    expect(retrieveQuestion(board, root, root, ref, { query: "REVOKED", budgetChars: 64000 })).toMatchObject({ queryOrigin: "explicit_query", originals: { query: "REVOKED" } });
    const context = retrievalContext({ id: "R", mode: "execute", snapshot: board, workspace: root, runDir: join(root, "runs"), blackboardPath: join(root, "board.md"), step, signal: new AbortController().signal, onEvent() {} });
    expect(context).toHaveProperty("queryGroups"); expect(board).toEqual(before);
  });
  it("finds full-width spellings and avoids substring decoys while keeping exact UTF-8 locators", () => {
    for (const [query, body] of [["permit", "unpermitted ".repeat(250) + "😀 Ｐｅｒｍｉｔ 仅 alice；NOT verified"], ["id", "unidentified ".repeat(250) + "😀 id=LOCAL; bob denied"]]) {
      const { root, board } = fixture(), evidence = board.evidence[0]!;
      writeFileSync(join(root, evidence.path), body!); evidence.sha256 = createHash("sha256").update(body!).digest("hex"); evidence.bytes = Buffer.byteLength(body!);
      const result = searchOriginals(board, root, root, query!, 1);
      expect(result.hits).toHaveLength(1); expect(result.hits[0]!.locator.byteOffset).toBeGreaterThan(2000);
      expect(readOriginal(board, root, root, result.hits[0]!.locator).text).toBe(result.hits[0]!.snippet);
    }
  });
  it("withholds grouped hits from damaged originals and never counts missing inputs as satisfied", () => {
    const { root, board, cases } = fixture(), query = cases.find(item => item.id === "export-multi-original")!;
    searchOriginals(board, root, root, query.query, 2, false, query.groups);
    const evidence = board.evidence.find(item => item.id === "E-export-handle")!; writeFileSync(join(root, evidence.path), "tampered");
    const result = searchOriginals(board, root, root, query.query, 2, false, query.groups);
    expect(result.complete).toBe(false); expect(result.hits.some(hit => hit.locator.evidenceId === evidence.id)).toBe(false);
    expect(result.queryGroups?.find(group => group.id === "need:1")?.fullExpressionWindows).toBe(0);
  });
});
