import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlackboardStore } from "../src/store.js";
import { auditWiki } from "../src/wiki/audit.js";
import { buildRetrievalIndex, organizeWiki, refKey } from "../src/wiki/catalog.js";
import { incrementalRetrievalIndex } from "../src/wiki/incremental.js";
import { materialDelivery, recordReadPath } from "../src/wiki/materials.js";
import { applyWikiPages, validateWikiReferences, wikiIssues, wikiPagesSchema, type WikiPage, type WikiPageProposal } from "../src/wiki/model.js";
import { renderWiki } from "../src/wiki/projection.js";
import { createTaskReader } from "../src/wiki/read.js";
import { retrieveWiki } from "../src/wiki/retrieval.js";
import { wikiStructureFixture, wikiZero } from "./fixtures/wiki-structure.js";

const roots: string[] = [], stores: BlackboardStore[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-structure-")); roots.push(root);
  const result = wikiStructureFixture(root); stores.push(result.store); return result;
}
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-structure-")) throw new Error("Invalid fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});
const full = (page: WikiPage): WikiPageProposal => ({ id: page.id, title: page.title,
  blocks: page.blocks.map(({ basis: _basis, requiredBasis: _required, ...block }) => block) });
const ref = { kind: "block" as const, pageId: "WK-flow", id: "B-judgment" };

describe("native Wiki structure and review boundaries", () => {
  it("retrieves metadata-only words and transitive required blocks with their full sources", () => {
    const { store, initial, scopeId } = fixture();
    for (const query of ["BridgeAlias", "LabelBridge", "为什么标识符不能证明下载成功", "Local reports"]) {
      const result = retrieveWiki(initial, store.dataDir, store.workspace, query, { limit: 1, anchors: query === "Local reports" ? [ref] : undefined });
      expect(result.hits[0]!.ref).toEqual(ref);
      expect(result.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: { kind: "block", pageId: "WK-context", id: "B-limit" }, text: expect.stringContaining("unverified") }),
        expect.objectContaining({ ref: { kind: "block", pageId: "WK-context", id: "B-scope" }, text: expect.stringContaining("alice / v1") }),
        expect.objectContaining({ ref: { kind: "fact", id: scopeId } }),
        expect.objectContaining({ ref: { kind: "evidence", id: initial.evidence[1]!.id } }),
      ]));
      expect(JSON.stringify(result.records)).not.toContain("DIRECTORY_ONLY");
      expect((result.records[0] as any).text).not.toContain("BridgeAlias");
      expect((result.records[0] as any).retrievalMetadata.page.aliases).toEqual(["BridgeAlias"]);
    }
    expect(initial.wikiPages![0]!.blocks[0]!.requiredBasis).toHaveLength(2);
    expect(wikiIssues(initial, initial.wikiPages![0]!)).toEqual([]);
  });

  it("preserves source and dependency review baselines through page/block metadata patches", () => {
    const f = fixture(), changed = f.correct(), previous = changed.wikiPages![0]!;
    const expected = wikiIssues(changed, previous);
    expect(expected).toContainEqual(expect.objectContaining({ blockId: "B-judgment", kind: "fact", id: f.scopeId, reason: "source_changed", via: { pageId: "WK-context", blockId: "B-limit" } }));
    const board = f.submit([{ id: "WK-flow", title: "Renamed", parentPageId: null, summary: "", questions: [], aliases: ["NewAlias"],
      blockMetadata: [{ id: "B-judgment", title: "New navigation title", aliases: ["BlockAlias"], keywords: [] }] }]);
    const current = board.wikiPages![0]!;
    expect(wikiIssues(board, current)).toEqual(expected);
    expect(current.blocks[0]!.basis).toEqual(previous.blocks[0]!.basis);
    expect(current.blocks[0]!.requiredBasis).toEqual(previous.blocks[0]!.requiredBasis);
    expect(current.blocks[0]!.text).toBe(previous.blocks[0]!.text);
    expect(current.history[0]).toMatchObject({ parentPageId: "WK-index", aliases: ["BridgeAlias"] });
    expect(board.facts).toEqual(changed.facts); expect(board.noProgressCount).toBe(1);
    expect(buildRetrievalIndex(board).postings.bridgealias).toBeUndefined();
    expect(retrieveWiki(board, f.store.dataDir, f.store.workspace, "BlockAlias").hits[0]!.ref).toEqual(ref);
  });

  it("reindexes descendants after ancestor rename and move without revising their factual bases", () => {
    const f = fixture(), before = f.store.snapshot(), original = before.wikiPages![0]!;
    const file = buildRetrievalIndex(before).documents.find(doc => doc.ref.kind === "block" && doc.ref.pageId === "WK-flow")!.path;
    const board = f.submit([{ id: "WK-index", title: "RenamedAncestor", parentPageId: "WK-context" }]);
    expect(board.wikiPages![0]).toEqual(original);
    const cached = incrementalRetrievalIndex(board, f.store.dataDir, f.store.workspace);
    expect(cached.index).toEqual(buildRetrievalIndex(board));
    const doc = cached.index.documents.find(doc => refKey(doc.ref) === refKey(ref))!;
    expect(doc.path).toBe(file); expect(doc.breadcrumb?.map(item => item.title)).toEqual(["Boundary", "RenamedAncestor", "Submission"]);
    expect(retrieveWiki(board, f.store.dataDir, f.store.workspace, "RenamedAncestor").hits.map(hit => hit.ref)).toContainEqual(ref);
    expect(wikiIssues(board, original)).toEqual([]);
    const baseline = Object.fromEntries(materialDelivery(before, {}, 64000).items.map(item => [item.key, item.signature]));
    expect(materialDelivery(board, baseline, 64000).items).toContainEqual(expect.objectContaining({ id: "B-judgment", change: "changed" }));
  });

  it("does not mark dependency title/alias edits as source review or alter stable file identity", () => {
    const f = fixture(), original = f.initial.wikiPages![0]!;
    const beforePath = buildRetrievalIndex(f.initial).documents.find(doc => refKey(doc.ref) === refKey(ref))!.path;
    const board = f.submit([{ id: "WK-context", title: "Renamed boundary", blockMetadata: [{ id: "B-limit", title: "BoundaryAlias", aliases: ["ConstraintAlias"] }] }]);
    expect(wikiIssues(board, original)).toEqual([]);
    expect(buildRetrievalIndex(board).documents.find(doc => refKey(doc.ref) === refKey(ref))!.path).toBe(beforePath);
    expect(retrieveWiki(board, f.store.dataDir, f.store.workspace, "ConstraintAlias").hits[0]!.ref).toMatchObject({ id: "B-limit" });
  });

  it("propagates changed required text transitively and clears only after explicit judgment reevaluation", () => {
    const f = fixture(), context = full(f.initial.wikiPages![1]!);
    context.blocks![1]!.text = "Only alice / v1 was observed; v2 is expressly outside this observation.";
    const board = f.submit([context]);
    expect(wikiIssues(board, board.wikiPages![0]!)).toContainEqual(expect.objectContaining({ reason: "required_block_changed", kind: "block", pageId: "WK-context", id: "B-scope" }));
    const acknowledged = f.submit([full(board.wikiPages![0]!)]);
    expect(wikiIssues(acknowledged, acknowledged.wikiPages![0]!)).toEqual([]);
    expect(acknowledged.wikiPages![0]!.parentPageId).toBe("WK-index");
    expect(acknowledged.wikiPages![0]!.aliases).toEqual(["BridgeAlias"]);
  });

  it("cannot launder a stale required explanation by resubmitting only the dependent page", () => {
    const f = fixture(), changed = f.correct();
    const board = f.submit([full(changed.wikiPages![0]!)]);
    expect(wikiIssues(board, board.wikiPages![0]!)).toContainEqual(expect.objectContaining({ kind: "fact", id: f.scopeId, reason: "source_changed" }));
    const renewed = f.submit([full(board.wikiPages![0]!), full(board.wikiPages![1]!)]);
    expect(wikiIssues(renewed, renewed.wikiPages![0]!)).toEqual([]);
  });

  it("retains missing dependency warnings and returns incomplete exact and search packages", () => {
    const f = fixture(), context = full(f.initial.wikiPages![1]!);
    context.blocks = [context.blocks![1]!];
    const board = f.submit([context]);
    expect(wikiIssues(board, board.wikiPages![0]!)).toContainEqual(expect.objectContaining({ reason: "required_block_missing", id: "B-limit" }));
    expect(organizeWiki(board).missingSources).toContainEqual({ ref, source: { kind: "block", pageId: "WK-context", id: "B-limit" } });
    const reader = createTaskReader(f.store.workspace, { dataDir: f.store.dataDir, snapshot: () => board });
    for (const path of [recordReadPath(ref) + "&budgetChars=64000", "xloom://search?mode=wiki&query=BridgeAlias&budgetChars=64000"]) {
      const result = reader(path) as any;
      expect(result.complete).toBe(false);
      expect((result.wiki ?? result).records).toContainEqual({ ref: { kind: "block", pageId: "WK-context", id: "B-limit" }, status: "source_missing" });
    }
    expect(auditWiki(board, f.store.dataDir, f.store.workspace).status).toBe("unavailable");
    expect(() => f.submit([full(board.wikiPages![0]!)] )).toThrow("Unknown required Wiki block");
    f.store.failRun(f.store.runs().at(-1)!.id, "Synthetic invalid submission", wikiZero, false);
    expect(() => f.submit([{ id: "WK-flow", title: "Keep pending review" }])).not.toThrow();
  });

  it("delivers the entire dependency package or reports budget exhaustion with navigation", () => {
    const f = fixture(), reader = createTaskReader(f.store.workspace, { dataDir: f.store.dataDir, snapshot: () => f.store.snapshot() });
    const small = reader("xloom://search?mode=wiki&query=BridgeAlias&budgetChars=1024") as any;
    expect(small.complete).toBe(false); expect(small.status).toBe("budget_exhausted"); expect(small.wiki).toBeUndefined();
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(1024);
    const all = reader("xloom://search?mode=wiki&query=BridgeAlias&budgetChars=64000") as any;
    expect(all.complete).toBe(true); expect(all.wiki.records.filter((doc: any) => doc.ref.kind === "block")).toHaveLength(3);
  });

  it.each([
    ["unknown parent", [{ id: "WK-flow", parentPageId: "WK-missing" }], "Unknown Wiki parent"],
    ["parent cycle", [{ id: "WK-index", parentPageId: "WK-flow" }], "parent page cycle"],
    ["new metadata page", [{ id: "WK-new", title: "Only metadata" }], "requires title and blocks"],
    ["unknown metadata block", [{ id: "WK-flow", blockMetadata: [{ id: "B-missing", aliases: [] }] }], "Unknown Wiki metadata block"],
  ])("rejects %s atomically in Store and runtime preflight", (_name, pages, error) => {
    const f = fixture(), run = f.claim(), before = f.store.snapshot(), events = f.store.events();
    const output = { summary: "Invalid fixture", result: "no_progress" as const, wikiPages: wikiPagesSchema.parse(pages) };
    expect(() => validateWikiReferences(before, output)).toThrow(error);
    expect(() => f.store.applyExecution(run.runId, output, { input: 3, output: 2, cost: 0 })).toThrow(error);
    expect(f.store.snapshot()).toEqual(before); expect(f.store.events()).toEqual(events); expect(f.store.runs().at(-1)!.status).toBe("running");
  });

  it("rejects self/indirect dependency cycles and same-batch missing blocks", () => {
    const f = fixture();
    for (const refs of [[{ pageId: "WK-flow", blockId: "B-judgment" }], [{ pageId: "WK-context", blockId: "B-missing" }]]) {
      const proposal = full(f.initial.wikiPages![0]!); proposal.blocks![0]!.requiredBlockRefs = refs;
      expect(() => validateWikiReferences(f.initial, { summary: "Invalid", result: "no_progress", wikiPages: [proposal] })).toThrow(/cycle|Unknown required Wiki block/);
    }
    const context = full(f.initial.wikiPages![1]!); context.blocks![1]!.requiredBlockRefs = [{ pageId: "WK-flow", blockId: "B-judgment" }];
    expect(() => f.submit([context])).toThrow("required block cycle");
    const clone = structuredClone(f.initial), before = structuredClone(clone);
    expect(() => applyWikiPages(clone, [context], ref => ref, () => {})).toThrow(); expect(clone).toEqual(before);
  });

  it("validates metadata limits, patch ambiguity and required ref uniqueness", () => {
    for (const invalid of [
      { id: "WK-flow" }, { id: "WK-flow", aliases: ["\0"] }, { id: "WK-flow", aliases: ["x".repeat(129)] },
      { id: "WK-flow", questions: Array(17).fill("why") }, { id: "WK-flow", summary: "x".repeat(2001) },
      { id: "WK-flow", blockMetadata: [{ id: "B-judgment", text: "replace without review" }] },
      { id: "WK-flow", blockMetadata: [{ id: "B-judgment", requiredBlockRefs: [] }] },
      { id: "WK-flow", blockMetadata: [{ id: "B-judgment" }] },
      { id: "WK-flow", blockMetadata: [{ id: "B-judgment", aliases: [] }, { id: "B-judgment", title: "Repeated" }] },
    ]) expect(wikiPagesSchema.safeParse([invalid]).success).toBe(false);
    const f = fixture(), page = full(f.initial.wikiPages![0]!);
    expect(wikiPagesSchema.safeParse([{ ...page, blockMetadata: [{ id: "B-judgment", aliases: [] }] }]).success).toBe(false);
    page.blocks![0]!.requiredBlockRefs!.push(page.blocks![0]!.requiredBlockRefs![0]!);
    expect(wikiPagesSchema.safeParse([page]).success).toBe(false);
  });

  it("preserves metadata checkpoint history, replay idempotence, and restart projections", () => {
    const f = fixture(), run = f.claim(), output = { summary: "Metadata checkpoint", result: "no_progress", wikiPages: [{ id: "WK-flow", aliases: ["CheckpointAlias"] }] };
    const board = f.store.applyExecutionCheckpoint(run.runId, "wiki-meta", output, wikiZero);
    expect(f.store.applyExecutionCheckpoint(run.runId, "wiki-meta", output, wikiZero)).toEqual(board);
    const again = f.store.applyExecutionCheckpoint(run.runId, "wiki-meta-again", output, wikiZero);
    expect(again.wikiPages).toEqual(board.wikiPages);
    f.store.failRun(run.runId, "Synthetic interruption", wikiZero, false); f.store.close();
    const reopened = new BlackboardStore(f.store.workspace, board.config); stores.push(reopened);
    expect(reopened.snapshot().wikiPages).toEqual(board.wikiPages);
    expect(auditWiki(reopened.snapshot(), reopened.dataDir, reopened.workspace).status).toBe("consistent");
    const manifest = JSON.parse(readFileSync(join(reopened.dataDir, "wiki", "manifest.json"), "utf8"));
    expect(manifest.entries.find((entry: any) => entry.id === "WK-flow")).toMatchObject({ parentPageId: "WK-index", retrievalMetadata: { aliases: ["CheckpointAlias"] } });
  });

  it("preserves old snapshots and history when new optional fields are absent", () => {
    const f = fixture(), board = structuredClone(f.initial);
    for (const page of board.wikiPages!) {
      delete page.parentPageId; delete page.aliases; delete page.questions; delete page.summary;
      for (const block of page.blocks) { delete block.requiredBasis; delete block.requiredBlockRefs; delete block.keywords; delete block.aliases; }
    }
    expect(() => buildRetrievalIndex(board)).not.toThrow();
    const previous = structuredClone(board.wikiPages);
    applyWikiPages(board, [{ id: "WK-flow", aliases: ["LegacyAlias"] }], ref => ref, () => { throw new Error("Metadata must not reseal evidence"); });
    expect(board.wikiPages![0]!.blocks).toEqual(previous![0]!.blocks);
    expect(wikiIssues(board, board.wikiPages![0]!)).toEqual([]);
    expect([...renderWiki(board, f.store.dataDir, f.store.workspace).values()].join("\n")).toContain("LegacyAlias");
  });

  it("verifies dependency archives on full submissions but preserves review state during metadata maintenance", () => {
    const f = fixture(), evidence = f.initial.evidence[1]!;
    writeFileSync(join(f.store.dataDir, evidence.path), "CORRUPTED SYNTHETIC ARCHIVE");
    expect(() => f.submit([full(f.initial.wikiPages![0]!)] )).toThrow("Evidence changed");
    f.store.failRun(f.store.runs().at(-1)!.id, "Synthetic invalid submission", wikiZero, false);
    expect(() => f.submit([{ id: "WK-flow", title: "Navigation maintenance" }])).not.toThrow();
    expect(auditWiki(f.store.snapshot(), f.store.dataDir, f.store.workspace).issues).toContainEqual(expect.objectContaining({ code: "evidence_mismatch", id: evidence.id }));
  });

  it("seals new same-batch dependency targets independently of submission order", () => {
    const f = fixture(), left = f.correct(), right = structuredClone(left);
    const flow = full(left.wikiPages![0]!), context = full(left.wikiPages![1]!);
    flow.blocks![0]!.requiredBlockRefs = [{ pageId: "WK-context", blockId: "B-new" }];
    context.blocks!.push({ id: "B-new", title: "New correction explanation", text: "The old scope has been withdrawn; actual success remains unverified.",
      sources: [{ kind: "fact", id: left.facts.at(-1)!.id }], requiredBlockRefs: [{ pageId: "WK-context", blockId: "B-limit" }] });
    const output = { summary: "Reevaluate affected explanations", result: "no_progress" as const, wikiPages: [flow, context] };
    expect(() => validateWikiReferences(left, output)).not.toThrow();
    applyWikiPages(left, [flow, context], ref => ref, () => {});
    applyWikiPages(right, [context, flow], ref => ref, () => {});
    expect(left.wikiPages).toEqual(right.wikiPages);
    expect(wikiIssues(left, left.wikiPages![0]!)).toEqual([]);
    expect(left.wikiPages![0]!.blocks[0]!.requiredBasis).toHaveLength(3);
  });

  it("diagnoses transitive missing explanations before a model's final repair", () => {
    const f = fixture(), board = structuredClone(f.initial);
    board.wikiPages![1]!.blocks = [board.wikiPages![1]!.blocks[0]!];
    expect(() => validateWikiReferences(board, { summary: "Reevaluate", result: "no_progress", wikiPages: [full(board.wikiPages![0]!)] })).toThrow("Unknown required Wiki block: WK-context/B-scope");
  });

  it("projects only public history fields while retaining historical metadata and dependencies", () => {
    const f = fixture(), board = f.submit([{ id: "WK-flow", title: "Renamed" }]), previous = board.wikiPages![0]!.history[0]!;
    Object.assign(previous, { privateMessage: "PRIVATE_HISTORY_VALUE" }); Object.assign(previous.blocks[0]!, { apiKey: "PRIVATE_BLOCK_VALUE" });
    const rendered = [...renderWiki(board, f.store.dataDir, f.store.workspace).values()].join("\n");
    expect(rendered).not.toMatch(/PRIVATE_HISTORY_VALUE|PRIVATE_BLOCK_VALUE/);
    expect(rendered).toContain("历史必要解释引用"); expect(rendered).toContain("BridgeAlias");
    expect(buildRetrievalIndex(board).documents.every(doc => !doc.text.includes("PRIVATE_"))).toBe(true);
  });
});
