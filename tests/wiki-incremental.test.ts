import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import type { BoardSnapshot, RunRequest } from "../src/types.js";
import { buildRetrievalIndex, refKey } from "../src/wiki/catalog.js";
import { materialDelivery, planningMaterials, recordReadPath } from "../src/wiki/materials.js";
import { incrementalRetrievalIndex } from "../src/wiki/incremental.js";
import { searchOriginals } from "../src/wiki/originals.js";
import { createTaskReader } from "../src/wiki/read.js";
import { retrievalContext } from "../src/wiki/retrieval.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";
import { runtimeEvent } from "../src/runtime/pi-runner.js";
import { EventFeed } from "../src/ui/model.js";
import { FeedView } from "../src/ui/feed-view.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const roots: string[] = [], stores: BlackboardStore[] = [];
const zero = { input: 0, output: 0, cost: 0 };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-index-")) throw new Error("Invalid fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-index-")); roots.push(root); mkdirSync(join(root, "evidence"));
  const board: BoardSnapshot = { revision: 1, config: defaultConfig("Local retrieval fixture"), status: "paused", outcome: null, reason: "",
    goals: [{ id: "G0", description: "Fixture goal", parentId: null, status: "active", factIds: [] }],
    steps: [{ id: "S-old", goalId: "G0", from: [], description: "Blocked download", successSignal: "Local observation", evidencePlan: "Keep fixture", priority: 1,
      status: "blocked", attempts: 1, runId: null, leaseUntil: null, gaps: [{ id: "gap-download", missing: "downloadGrant", why: "Need explicit permission", reopenWhen: "New grant observation",
        needs: [], conditions: { scope: "local", identity: "alice", environment: "fixture", stateVersion: "v1" }, sources: [] }] }],
    facts: [{ id: "F-one", description: "An observation with conditions", stepId: "S-old", evidenceIds: ["E-one"] }], evidence: [], findings: [], hints: [],
    usage: zero, completedSteps: 1, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: 0 };
  source(board, root, "E-one", "downloadGrant=fixtureOnly; current scope=local\n");
  return { root, board };
}
function source(board: BoardSnapshot, root: string, id: string, body: string) {
  writeFileSync(join(root, "evidence", `${id}.txt`), body);
  const value = { id, path: `evidence/${id}.txt`, pathBase: "task" as const, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body), description: "Generic original", stepId: "S-old", runId: "fixture" };
  const existing = board.evidence.findIndex(item => item.id === id);
  if (existing < 0) board.evidence.push(value); else board.evidence[existing] = value;
}
const receipts = (delivery: ReturnType<typeof materialDelivery>) => Object.fromEntries(delivery.items.map(item => [item.key, item.signature]));

describe("durable material announcements", () => {
  it("announces only changed versions, preserves source identity and prioritizes old gaps", () => {
    const { board } = fixture();
    board.facts.push({ ...board.facts[0]!, id: "F-copy" });
    const before = structuredClone(board), first = materialDelivery(board, {});
    expect(first.items[0]?.kind).toBe("gap");
    expect(first.items.filter(item => item.kind === "fact")).toHaveLength(2);
    const baseline = receipts(first);
    expect(materialDelivery(board, baseline).items).toEqual([]);
    board.facts[0]!.description = "Corrected observation; old scope no longer applies";
    expect(materialDelivery(board, baseline).items).toContainEqual(expect.objectContaining({ id: "F-one", change: "changed" }));
    expect(board.steps).toEqual(before.steps);
  });
  it("accounts for the whole navigation envelope and leaves omitted cards pending", () => {
    const { board } = fixture();
    for (let i = 0; i < 120; i++) board.facts.push({ id: `F-extra-${i}`, description: "完整条件不能由导航标题代替".repeat(100), stepId: null, evidenceIds: [] });
    for (const budget of [1024, 1800, 6000, 64000]) {
      const first = materialDelivery(board, {}, budget);
      expect(JSON.stringify(first).length).toBeLessThanOrEqual(budget);
      expect(first.items.length + first.deferredCount).toBe(123);
      const next = materialDelivery(board, receipts(first), 64000);
      expect(next.items.every(item => !first.items.some(previous => previous.key === item.key))).toBe(true);
      expect(next.items.length + next.deferredCount).toBe(first.deferredCount);
    }
  });
  it("associates original-body hits to a gap as lexical candidates without resolving it", () => {
    const { board, root } = fixture(), before = structuredClone(board);
    const delivery = planningMaterials(board, {}, root, root);
    expect(delivery.items.find(item => item.id === "E-one")?.relatedGaps).toContainEqual(expect.objectContaining({ gapId: "gap-download", relation: "lexical" }));
    expect(board).toEqual(before);
    expect(JSON.stringify(planningMaterials(board, {}, root, root, 1024)).length).toBeLessThanOrEqual(1024);
    writeFileSync(join(root, "evidence", "E-one.txt"), "changed source");
    expect(planningMaterials(board, {}, root, root).originalLinking?.unavailableSources).toBe(1);
  });
  it("pages pending announcements within one reader and refreshes sources for a fresh role", () => {
    const { board, root } = fixture(); const stamps: object[] = [];
    const read = createTaskReader(root, { dataDir: root, snapshot: () => board, onAnnounced: items => stamps.push(...items) });
    const first = read("xloom://materials?budgetChars=1800") as any;
    const second = read("xloom://materials?budgetChars=64000") as any;
    expect(second.items.some((item: any) => first.items.some((old: any) => old.key === item.key))).toBe(false);
    expect(stamps.length).toBe(3);
    expect((read("xloom://materials") as any).items).toEqual([]);
    expect((read("xloom://materials?refresh=true") as any).items.length).toBe(3);
    const fresh = createTaskReader(root, { dataDir: root, snapshot: () => board, materialBaseline: receipts(materialDelivery(board, {})) });
    expect((fresh(recordReadPath({ kind: "evidence", id: "E-one" })) as any).complete).toBe(true);
  });
  it("reads whole source/correction packages and does not acknowledge undelivered records", () => {
    const { board, root } = fixture();
    board.facts.push({ id: "F-correction", description: "Later scope correction", stepId: null, evidenceIds: ["E-one"], supersedes: "F-one" });
    const stamps: object[] = [], read = createTaskReader(root, { dataDir: root, snapshot: () => board, onAnnounced: items => stamps.push(...items) });
    const path = recordReadPath({ kind: "evidence", id: "E-one" });
    const full = read(path) as any;
    expect(full.complete).toBe(true); expect(JSON.stringify(full)).toContain("Later scope correction");
    expect(stamps).toContainEqual(expect.objectContaining({ key: refKey({ kind: "fact", id: "F-correction" }) }));
    stamps.length = 0;
    board.facts[0]!.description = "Very long complete authored condition. ".repeat(2000);
    expect((read(path + "&budgetChars=1024") as any).complete).toBe(false); expect(stamps).toEqual([]);
    expect(() => read("xloom://record?kind=block&id=B")).toThrow("Invalid exact");
    expect(() => read("xloom://materials?refresh=yes")).toThrow("refresh");
  });
  it("commits receipts atomically and preserves them across task reopen", () => {
    const { root } = fixture(); let store = new BlackboardStore(root, defaultConfig("Fixture receipts")); stores.push(store);
    store.setStatus("running", "Fixture"); store.beginRun("seed", "decide");
    store.applyDecision("seed", { summary: "Seed", steps: [{ goalId: "G0", from: [], description: "Observe", successSignal: "Result", evidencePlan: "Save fixture", priority: 1 }] }, zero);
    const step = store.snapshot().steps[0]!; store.beginRun("execute", "execute", step.id);
    const artifacts = join(store.dataDir, "runs", "execute", "artifacts"); mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "body.txt"), "local fixture observation");
    store.applyExecution("execute", { summary: "Observed", result: "done", evidence: [{ ref: "e", path: "body.txt", description: "Original" }], facts: [{ ref: "f", description: "Local observation", evidenceRefs: ["e"] }] }, zero);
    const pending = materialDelivery(store.snapshot(), {});
    store.beginRun("invalid", "decide");
    expect(() => store.applyDecision("invalid", { summary: "Invalid", steps: [{ goalId: "UNKNOWN", from: [], description: "Bad", successSignal: "Bad", evidencePlan: "Bad", priority: 1 }] }, zero, pending)).toThrow();
    expect(store.materialReceipts()).toEqual({}); store.failRun("invalid", "Fixture failure", zero);
    store.setStatus("running", "Retry"); store.beginRun("cancelled", "decide"); store.failRun("cancelled", "Cancelled fixture", zero);
    expect(store.materialReceipts()).toEqual({});
    store.setStatus("running", "Retry"); store.beginRun("accepted", "decide");
    store.applyDecision("accepted", { summary: "Read only the first navigation card" }, zero, { ...pending, items: pending.items.slice(0, 1) });
    const accepted = store.materialReceipts(); expect(Object.keys(accepted)).toHaveLength(1);
    store.close(); stores.splice(stores.indexOf(store), 1);
    store = new BlackboardStore(root, defaultConfig("Fixture receipts")); stores.push(store);
    expect(store.materialReceipts()).toEqual(accepted);
    expect(materialDelivery(store.snapshot(), accepted).items).toHaveLength(pending.items.length - 1);
  });
  it("uses delta navigation in planning while keeping native full-source paths", () => {
    const { board, root } = fixture();
    const request: RunRequest = { id: "R", mode: "decide", snapshot: board, workspace: root, runDir: join(root, "runs", "R"), blackboardPath: join(root, "blackboard.md"),
      signal: new AbortController().signal, onEvent() {}, materials: materialDelivery(board, {}) };
    const context = retrievalContext(request) as any;
    expect(context.type).toBe("planning_navigation"); expect(context.records).toBeUndefined();
    expect(context.questions[0].readPath).toContain("xloom://question");
  });
});

describe("incremental source projections", () => {
  it("reuses metadata tokens while returning fresh authoritative source records", () => {
    const { board, root } = fixture();
    const cold = incrementalRetrievalIndex(board, root, root);
    expect(cold.index).toEqual(buildRetrievalIndex(board)); expect(cold.stats.added).toBe(4);
    const warm = incrementalRetrievalIndex(board, root, root);
    expect(warm.stats).toMatchObject({ added: 0, updated: 0, reused: 4, indexedBytes: 0 });
    board.facts[0]!.description = "Revised download scope";
    const changed = incrementalRetrievalIndex(board, root, root);
    expect(changed.stats).toMatchObject({ updated: 1, reused: 3 }); expect(changed.index).toEqual(buildRetrievalIndex(board));
    board.facts = []; expect(incrementalRetrievalIndex(board, root, root).stats.removed).toBe(1);
    expect(incrementalRetrievalIndex(board, root, root, true).stats).toMatchObject({ updated: 3, reused: 0 });
  });
  it("indexes only added/changed bytes and verifies warm hits anew", () => {
    const { board, root } = fixture();
    expect(searchOriginals(board, root, root, "downloadGrant").index).toMatchObject({ added: 1, reused: 0, indexedBytes: board.evidence[0]!.bytes, verifiedOriginals: 1 });
    expect(searchOriginals(board, root, root, "downloadGrant").index).toMatchObject({ added: 0, reused: 1, indexedBytes: 0, verifiedOriginals: 1 });
    source(board, root, "E-two", "unrelated independent source");
    expect(searchOriginals(board, root, root, "downloadGrant").index).toMatchObject({ added: 1, reused: 1, indexedBytes: board.evidence[1]!.bytes });
    source(board, root, "E-two", "new downloadGrant scope");
    const changed = searchOriginals(board, root, root, "downloadGrant");
    expect(changed.index).toMatchObject({ updated: 1, reused: 1, verifiedOriginals: 2 }); expect(changed.hits).toHaveLength(2);
    board.evidence.shift();
    expect(searchOriginals(board, root, root, "downloadGrant").index).toMatchObject({ removed: 1, reused: 1 });
    expect(searchOriginals(board, root, root, "noMatch").index).toMatchObject({ indexedBytes: 0, verifiedOriginals: 0 });
    expect(searchOriginals(board, root, root, "noMatch", 6, true).index).toMatchObject({ updated: 1, reused: 0, indexedBytes: board.evidence[0]!.bytes });
  });
  it("rejects changed bytes and never returns stale cached source snippets", () => {
    const { board, root } = fixture(); searchOriginals(board, root, root, "downloadGrant");
    writeFileSync(join(root, "evidence", "E-one.txt"), "downloadGrant tampered original");
    expect(searchOriginals(board, root, root, "downloadGrant")).toMatchObject({ complete: false, hits: [], issues: [expect.objectContaining({ reason: "Evidence SHA-256/size mismatch" })] });
  });
  it("preserves broken and foreign cache files and falls back without board mutation", () => {
    const { board, root } = fixture(), before = structuredClone(board);
    const other = fixture(); searchOriginals(other.board, other.root, other.root, "downloadGrant");
    mkdirSync(join(root, "cache")); const path = join(root, "cache", "retrieval.sqlite");
    copyFileSync(join(other.root, "cache", "retrieval.sqlite"), path); const foreign = readFileSync(path);
    expect(searchOriginals(board, root, root, "downloadGrant").index.storage).toBe("memory"); expect(readFileSync(path)).toEqual(foreign);
    writeFileSync(path, "preserve unknown file");
    const fallback = searchOriginals(board, root, root, "downloadGrant");
    expect(fallback.index.storage).toBe("memory"); expect(fallback.hits).toHaveLength(1); expect(readFileSync(path, "utf8")).toBe("preserve unknown file"); expect(board).toEqual(before);
  });
  it("stores locators and terms, without source bodies or cached verification verdicts", () => {
    const { board, root } = fixture(); searchOriginals(board, root, root, "downloadGrant");
    const db = new DatabaseSync(join(root, "cache", "retrieval.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT payload FROM entries WHERE namespace='original'").all();
      const payload = String(rows[0]!.payload);
      expect(payload).not.toContain("downloadGrant=fixtureOnly;"); expect(payload).not.toContain("verified");
      expect(JSON.parse(payload)[0]).toEqual({ offset: 0, byteLength: board.evidence[0]!.bytes });
      expect(db.prepare("SELECT key,unit FROM terms WHERE namespace='original' AND term='downloadgrant'").all()).toContainEqual({ key: "E-one", unit: 0 });
    } finally { db.close(); }
  });
  it("bypasses a linked cache directory without writing into its destination", () => {
    const { board, root } = fixture(), other = fixture();
    symlinkSync(other.root, join(root, "cache"), "junction");
    const result = searchOriginals(board, root, root, "downloadGrant");
    expect(result.index).toMatchObject({ storage: "memory", added: 1 }); expect(result.hits).toHaveLength(1);
    expect(result.index.fallbackReason).toContain("linked");
  });
  it.each(["original", "metadata"])("treats damaged %s cache rows as cache failure, not missing source evidence", namespace => {
    const { board, root } = fixture();
    searchOriginals(board, root, root, "downloadGrant"); incrementalRetrievalIndex(board, root, root);
    const db = new DatabaseSync(join(root, "cache", "retrieval.sqlite"));
    try { db.prepare("UPDATE entries SET payload='{' WHERE namespace=?").run(namespace); }
    finally { db.close(); }
    if (namespace === "original") {
      const result = searchOriginals(board, root, root, "downloadGrant");
      expect(result.index.storage).toBe("memory"); expect(result.complete).toBe(true); expect(result.hits).toHaveLength(1);
    } else {
      const result = incrementalRetrievalIndex(board, root, root);
      expect(result.stats.storage).toBe("memory"); expect(result.index).toEqual(buildRetrievalIndex(board));
    }
  });
  it("falls back on a locked cache and keeps later persistent reuse available", () => {
    const { board, root } = fixture(); searchOriginals(board, root, root, "downloadGrant");
    const db = new DatabaseSync(join(root, "cache", "retrieval.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      expect(searchOriginals(board, root, root, "downloadGrant")).toMatchObject({ complete: true, index: { storage: "memory" }, hits: [expect.anything()] });
      db.exec("ROLLBACK");
    } finally { db.close(); }
    expect(searchOriginals(board, root, root, "downloadGrant").index).toMatchObject({ storage: "persistent", reused: 1 });
  });
  it("shows readable native feedback while retaining original tool JSON", async () => {
    const { board, root } = fixture(); const tool = createWorkspaceReadTool(root, undefined, { dataDir: root, snapshot: () => board });
    const result = await tool.execute("read", { path: "xloom://search?query=downloadGrant" });
    const event = runtimeEvent({ type: "tool_execution_end", toolName: "read", toolCallId: "read", result, isError: false } as any, "decide")!;
    expect(event.retrievalFeedback).toContain("完整校验 1 份"); expect(event.text).toContain("locator");
    const feed = new EventFeed(); feed.materials(materialDelivery(board, {})); feed.runtime(event);
    const view = new FeedView(feed);
    for (const width of [24, 48, 96]) expect(view.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    expect(feed.entries.some(entry => entry.text.includes("已提示 ≠ 已复核"))).toBe(true);
    expect(feed.entries.find(entry => entry.kind === "tool")?.output).toContain("locator");
    expect(runtimeEvent({ type: "tool_execution_end", toolName: "powershell", toolCallId: "fake", result, isError: false } as any, "execute")?.retrievalFeedback).toBeUndefined();
  });
});
