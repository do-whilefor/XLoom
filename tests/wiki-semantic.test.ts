import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wikiStructureFixture } from "./fixtures/wiki-structure.js";
import { createTaskReader, type TaskReadContext } from "../src/wiki/read.js";
import { createSemanticTaskReader, type SemanticModel } from "../src/wiki/semantic.js";
import { clearRetrievalSnapshots } from "../src/wiki/incremental.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";

const fixtures: ReturnType<typeof wikiStructureFixture>[] = [], roots: string[] = [];
const query = "拿到凭条能否视作取件完成";
const path = `xloom://search?mode=wiki&query=${encodeURIComponent(query)}&strategy=semantic&budgetChars=64000&limit=2`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-semantic-")); roots.push(root);
  const f = wikiStructureFixture(root); fixtures.push(f);
  const generate = vi.fn<SemanticModel["generate"]>(async (stage, input: any) => stage === "expand"
    ? { groups: input.groups.map((group: any) => ({ id: group.id, queries: ["label returned", "download successful", "cross-account consumption"] })) }
    : stage === "index" ? { documents: input.documents.map((doc: any) => ({ id: doc.id, queries: ["拿到凭条能否视作取件完成", "receipt retrieval verification"] })) }
    : { scores: input.candidates.map((candidate: any) => ({ id: candidate.id, score: candidate.ref.pageId === "WK-flow" ? 100 : candidate.ref.kind === "block" ? 50 : 10 })) });
  const context: TaskReadContext = { dataDir: f.store.dataDir, snapshot: () => f.store.snapshot(), semantic: { identity: "fixture-model-v1", generate } };
  const reader = () => createSemanticTaskReader(root, context, createTaskReader(root, context));
  return { ...f, root, context, generate, reader };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
  clearRetrievalSnapshots();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-semantic-")) throw new Error("Unsafe semantic fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("model-assisted retrieval with authoritative source delivery", () => {
  it("recalls alternate expressions, reranks complete judgments and preserves source boundaries", async () => {
    const f = fixture(), before = f.store.snapshot();
    const lexical: any = await f.reader()(path.replace("strategy=semantic", "strategy=lexical"));
    expect(lexical.wiki.hits).toHaveLength(0); expect(f.generate).not.toHaveBeenCalled();
    const result: any = await f.reader()(path);
    expect(result.semantic.status).toBe("applied");
    expect(result.wiki.hits[0].ref).toMatchObject({ kind: "block", pageId: "WK-flow", id: "B-judgment" });
    expect(result.wiki.records.map((doc: any) => doc.text).join("\n")).toContain("Only alice / v1 was observed");
    expect(result.wiki.records.map((doc: any) => doc.text).join("\n")).toContain("Successful downloading is unverified");
    expect(result.complete).toBe(true); expect(JSON.stringify(result).length).toBeLessThanOrEqual(64000);
    expect(f.store.snapshot()).toEqual(before); expect(f.store.materialReceipts()).toEqual({});
    const rank = f.generate.mock.calls.find(([stage]) => stage === "rerank")![1] as any;
    const chosen = rank.candidates.find((item: any) => item.ref.pageId === "WK-flow");
    expect(chosen.records.some((doc: any) => doc.ref.id === "B-scope")).toBe(true);
  });
  it("persists hints across reader/process-cache restart and invalidates ranking after corrections or model changes", async () => {
    const f = fixture(); await f.reader()(path); f.generate.mockClear(); clearRetrievalSnapshots();
    const warm: any = await f.reader()(path);
    expect(warm.semantic).toMatchObject({ status: "applied", requests: 0 }); expect(warm.semantic.cacheHits).toBeGreaterThan(0);
    expect(f.generate).not.toHaveBeenCalled();
    f.correct();
    const changed: any = await f.reader()(path);
    expect(changed.semantic.status).toBe("applied");
    expect(f.generate.mock.calls.every(([stage]) => stage !== "expand")).toBe(true);
    expect(changed.semantic.indexedDocuments).toBeGreaterThan(0); expect(changed.semantic.reusedDocuments).toBeGreaterThan(0);
    expect(JSON.stringify(changed.wiki.records)).toContain("source_changed");
    f.generate.mockClear(); f.context.semantic!.identity = "fixture-model-v2";
    await f.reader()(path); expect(f.generate.mock.calls[0]![0]).toBe("expand");
    const db = new DatabaseSync(join(f.store.dataDir, "cache/retrieval.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT payload FROM entries WHERE namespace='semantic'").all();
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain("Only alice / v1 was observed");
    } finally { db.close(); }
  });
  it("rejects invented IDs and reports a lexical fallback without changing source state", async () => {
    const f = fixture(), before = f.store.snapshot();
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => args[0] !== "rerank" ? original(...args) : { scores: [{ id: "NOT_A_CANDIDATE", score: 100 }] });
    const result: any = await f.reader()(path);
    expect(result.semantic.status).toBe("failed_lexical_fallback");
    expect(JSON.stringify(result)).not.toContain("NOT_A_CANDIDATE");
    expect(f.store.snapshot()).toEqual(before);
  });
  it("indexes only a new Wiki judgment and keeps model hints outside author revisions", async () => {
    const f = fixture(); await f.reader()(path); f.generate.mockClear();
    f.submit([{ id: "WK-new", title: "Another observation", blocks: [{ id: "B-new", title: "New scope", text: "This separate check is unverified.", sources: [{ kind: "fact", id: f.factId }] }] }]);
    const before = f.store.snapshot(), result: any = await f.reader()(path);
    expect(result.semantic).toMatchObject({ status: "applied", indexedDocuments: 1, reusedDocuments: 4 });
    const inputs = f.generate.mock.calls.filter(([stage]) => stage === "index").flatMap(([, input]) => (input as any).documents);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].records[0].ref.pageId).toBe("WK-new");
    expect(f.store.snapshot()).toEqual(before);
  });
  it("accounts for semantic diagnostics within the source delivery budget", async () => {
    const f = fixture();
    for (const budget of [1024, 2048, 6000, 64000]) {
      const result: any = await f.reader()(path.replace("budgetChars=64000", `budgetChars=${budget}`));
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
      if (budget === 1024) expect(result.nextReadPath).toContain("strategy=semantic");
      if (budget === 64000 && result.nextReadPath) expect(result.nextReadPath).not.toBe(path);
    }
  });
  it("never reuses rankings across a board change while the model is running", async () => {
    const f = fixture(); let corrected = false;
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === "rerank" && !corrected) { corrected = true; f.correct(); }
      return result;
    });
    const result: any = await f.reader()(path);
    expect(result.semantic.status).toBe("sources_changed_lexical_fallback");
    expect(result.boardRevision).toBe(f.store.snapshot().revision);
  });
  it("uses the existing async read tool, respects cancellation and does not invoke models for malformed paths", async () => {
    const f = fixture(), controller = new AbortController();
    const tool = createWorkspaceReadTool(f.root, undefined, f.context);
    const result = await tool.execute("semantic", { path });
    expect(JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "{}").semantic.status).toBe("applied");
    f.generate.mockClear();
    await expect(f.reader()(path + "&query=duplicate")).rejects.toThrow("parameters");
    expect(f.generate).not.toHaveBeenCalled();
    controller.abort();
    await expect(f.reader()(path + "&refresh=true", controller.signal)).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("does not turn damaged original bytes into a valid semantic hit", async () => {
    const f = fixture(), evidence = f.store.snapshot().evidence[0]!;
    writeFileSync(join(f.store.dataDir, evidence.path), "tampered original");
    const result: any = await f.reader()(path.replace("mode=wiki", "mode=combined"));
    expect(result.complete).toBe(false);
    expect(result.originals?.hits.some((hit: any) => hit.locator.evidenceId === evidence.id)).not.toBe(true);
    expect(readFileSync(join(f.store.dataDir, evidence.path), "utf8")).toBe("tampered original");
  });
  it("preserves exact references even when the model prefers a different candidate", async () => {
    const f = fixture();
    const result: any = await f.reader()(path.replace(encodeURIComponent(query), encodeURIComponent("WK-context B-scope")));
    expect(result.wiki.hits[0]).toMatchObject({ ref: { kind: "block", pageId: "WK-context", id: "B-scope" }, reason: "exact_reference" });
  });
});
