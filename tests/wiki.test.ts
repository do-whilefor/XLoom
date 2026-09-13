import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { executionSchema } from "../src/schema.js";
import { projectContext } from "../src/loop/context.js";
import { buildRunPrompt } from "../src/runtime/prompts.js";
import { validateWikiReferences, wikiBasis, wikiIssues, wikiPagesSchema, type WikiPageProposal } from "../src/wiki/model.js";
import { renderWiki, wikiMarker } from "../src/wiki/projection.js";
import type { Execution, RunRequest } from "../src/types.js";

const stores: BlackboardStore[] = [], roots: string[] = [];
const usage = { input: 3, output: 2, cost: 0 };
let sequence = 0;
function open(root?: string, taskId?: string) {
  if (!root) { root = mkdtempSync(join(tmpdir(), "xloom-wiki-")); roots.push(root); }
  const store = new BlackboardStore(root, defaultConfig("Synthetic Wiki provenance"), { taskId });
  stores.push(store); return store;
}
function claim(store: BlackboardStore) {
  const id = ++sequence;
  store.setStatus("running", "Fixture"); store.beginRun(`d-${id}`, "decide");
  const board = store.applyDecision(`d-${id}`, { summary: "Fixture", steps: [{ goalId: "G0", from: [], description: `Local fixture ${id}`, successSignal: "Fixture", evidencePlan: "Fixture", priority: 1 }] }, usage);
  const step = board.steps.find(item => item.status === "ready")!;
  store.beginRun(`e-${id}`, "execute", step.id);
  const artifacts = join(store.dataDir, "runs", `e-${id}`, "artifacts"); mkdirSync(artifacts, { recursive: true });
  return { runId: `e-${id}`, artifacts, step };
}
function page(factId = "f"): WikiPageProposal {
  return { id: "WK-flow", title: "Synthetic workflow", blocks: [{ id: "B-boundary", title: "Observed and unknown",
    text: "The fixture returned a label. Cross-account consumption remains unverified.", sources: [{ kind: "fact", id: factId }] }] };
}
function seed(store: BlackboardStore) {
  const run = claim(store); writeFileSync(join(run.artifacts, "raw.txt"), "SYNTHETIC FIXTURE ONLY\nlabel=one\n");
  return store.applyExecution(run.runId, { summary: "Synthetic observation", result: "done",
    evidence: [{ ref: "e", path: "raw.txt", description: "Synthetic raw fixture" }],
    facts: [{ ref: "f", description: "Fixture returned a label", evidenceRefs: ["e"] }],
    findings: [{ key: "fixture", title: "Fixture", target: "local", status: "lead", factRefs: ["f"], evidenceRefs: ["e"], next: "Unknown consumer" }], wikiPages: [page()],
  }, usage);
}
function manifest(store: BlackboardStore) { return JSON.parse(readFileSync(join(store.dataDir, "wiki", "manifest.json"), "utf8")); }
function pagePath(store: BlackboardStore, id = "WK-flow") { return join(store.dataDir, "wiki", manifest(store).entries.find((entry: { id: string }) => entry.id === id).path); }
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("xloom-wiki-")) throw new Error("Unexpected fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("task Wiki and explicit provenance", () => {
  it("generates task-local automatic pages and seals same-batch explanation sources in SQLite", () => {
    const store = open(undefined, "wiki-task"); const board = seed(store);
    expect(relative(store.workspace, store.dataDir).startsWith("..")).toBe(true);
    const note = board.wikiPages![0]!;
    expect(note.blocks[0]!.sources).toEqual([{ kind: "fact", id: board.facts[0]!.id }]);
    expect(note.blocks[0]!.basis).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "evidence", id: board.evidence[0]!.id })]));
    expect(note).toMatchObject({ revision: 1, boardRevision: board.revision, history: [] });
    expect(wikiIssues(board, note)).toEqual([]);
    const data = manifest(store);
    for (const file of data.files) expect(createHash("sha256").update(readFileSync(join(store.dataDir, "wiki", file.path))).digest("hex")).toBe(file.sha256);
    expect(data.entries.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining(["goal", "step", "fact", "finding", "evidence", "note"]));
    expect(readFileSync(pagePath(store), "utf8")).toContain("Cross-account consumption remains unverified");
    expect(readFileSync(join(store.dataDir, "wiki", "index.md"), "utf8")).toContain("未解决 Findings");
    store.setStatus("paused", "Fixture complete"); const before = store.events(); store.close();
    const reopened = open(store.workspace, "wiki-task");
    expect(reopened.snapshot().wikiPages).toEqual(board.wikiPages);
    expect(reopened.events()).toEqual(before);
  });

  it("keeps page identity and author history without counting Wiki edits as research progress", () => {
    const store = open(); const original = seed(store); const file = pagePath(store);
    const revised = page(original.facts[0]!.id); revised.title = "Renamed explanation"; revised.blocks[0]!.text = "Still unknown; revisit with a valid consumer.";
    const run = claim(store); const board = store.applyExecution(run.runId, { summary: "Revise explanation only", result: "done", wikiPages: [revised] }, usage);
    expect(board.wikiPages).toHaveLength(1);
    expect(board.wikiPages![0]).toMatchObject({ revision: 2, history: [{ revision: 1, title: "Synthetic workflow" }] });
    expect(pagePath(store)).toBe(file);
    expect(board.findings).toEqual(original.findings); expect(board.facts).toEqual(original.facts); expect(board.evidence).toEqual(original.evidence);
    expect(board.noProgressCount).toBe(1); expect(board.steps.at(-1)!.status).toBe("no_progress");
    const repeated = claim(store); store.applyExecution(repeated.runId, { summary: "Same content", result: "no_progress", wikiPages: [revised] }, usage);
    expect(store.snapshot().wikiPages![0]!.revision).toBe(2);
    expect(readFileSync(file, "utf8")).toContain("历史解释");
  });

  it("marks corrected sources for review, keeps the old text and requires explicit resubmission", () => {
    const store = open(); const original = seed(store); const old = original.facts[0]!.id;
    const run = claim(store); writeFileSync(join(run.artifacts, "correction.txt"), "SYNTHETIC CORRECTION\nlabel=two\n");
    const board = store.applyExecution(run.runId, { summary: "Correction", result: "done", evidence: [{ ref: "e2", path: "correction.txt", description: "Synthetic correction" }],
      facts: [{ ref: "f2", description: "Corrected fixture label", evidenceRefs: ["e2"], supersedes: old }] }, usage);
    expect(board.wikiPages).toEqual(original.wikiPages);
    expect(wikiIssues(board, board.wikiPages![0]!)).toContainEqual({ blockId: "B-boundary", kind: "fact", id: old, reason: "source_changed" });
    expect(readFileSync(pagePath(store), "utf8")).toContain("待复核");
    expect(readFileSync(pagePath(store), "utf8")).toContain(original.wikiPages![0]!.blocks[0]!.text);
    store.close(); const reopened = open(store.workspace);
    expect(wikiIssues(reopened.snapshot(), reopened.snapshot().wikiPages![0]!)).not.toEqual([]);
    const reviewed = page(board.facts.at(-1)!.id); reviewed.blocks[0]!.text = "The corrected label is recorded; consumer impact is still unknown.";
    const followup = claim(reopened); const result = reopened.applyExecution(followup.runId, { summary: "Explicit source review", result: "no_progress", wikiPages: [reviewed] }, usage);
    expect(wikiIssues(result, result.wikiPages![0]!)).toEqual([]);
    expect(result.wikiPages![0]!.history[0]!.blocks[0]!.sources[0]!.id).toBe(old);
    expect(result.findings[0]!.status).toBe("lead");
  });

  it("includes new related attempts and declared counterevidence without treating them as verdicts", () => {
    const store = open(); const board = seed(store); const baseline = structuredClone(board);
    const changed = structuredClone(board);
    changed.attempts = [{ id: "A-counter", stepId: board.steps[0]!.id, hypothesis: "fixture", scope: "other-tenant", identity: "bob", stateVersion: "v2",
      baseline: "normal", changedVariable: "object", outcome: "refutes", observation: "Synthetic denial", evidenceIds: [board.evidence[0]!.id], conditionKey: "private", outcomeKey: "private", runId: "private" }];
    expect(wikiIssues(changed, changed.wikiPages![0]!)).not.toEqual([]);
    changed.attempts = [];
    changed.steps.push({ ...changed.steps[0]!, id: "S-counter", from: [board.facts[0]!.id], combination: {
      requires: [board.facts[0]!.id], missing: [], scope: "other", stateVersion: "v2", expectedCapability: "Unverified", counterEvidence: [board.facts[0]!.id],
    } });
    expect(wikiIssues(changed, changed.wikiPages![0]!)).not.toEqual([]);
    expect(() => wikiBasis(changed, [{ kind: "fact", id: board.facts[0]!.id }])).not.toThrow();
    expect(board).toEqual(baseline);
    expect(changed.findings[0]!.status).toBe("lead");
  });

  it("rejects missing and cross-task sources atomically and diagnoses them before final repair", () => {
    const store = open(undefined, "first"); const board = seed(store);
    const other = open(store.workspace, "second"); const run = claim(other);
    const proposal: Execution = { summary: "Foreign source", result: "no_progress", wikiPages: [page(board.facts[0]!.id)] };
    const before = other.snapshot(), events = other.events();
    expect(() => validateWikiReferences(before, proposal)).toThrow("wikiPages[0].blocks[0].sources[0]");
    expect(() => other.applyExecution(run.runId, proposal, usage)).toThrow("Unknown Wiki source");
    expect(other.snapshot()).toEqual(before); expect(other.events()).toEqual(events);
    expect(other.runs().at(-1)!.status).toBe("running");
    const corrupt = structuredClone(board); corrupt.facts = [];
    expect(wikiIssues(corrupt, board.wikiPages![0]!)).toContainEqual(expect.objectContaining({ reason: "source_missing" }));
  });

  it("validates page/block identifiers and allows typed local references without name ambiguity", () => {
    const note = page("same"); note.blocks[0]!.sources.push({ kind: "evidence", id: "same" });
    expect(wikiPagesSchema.safeParse([note]).success).toBe(true);
    for (const id of ["../escape", "WK-../escape", "WK-UPPER", "AUTO-fact", "WK-name.md"]) expect(wikiPagesSchema.safeParse([{ ...note, id }]).success).toBe(false);
    expect(wikiPagesSchema.safeParse([note, note]).success).toBe(false);
    expect(wikiPagesSchema.safeParse([{ ...note, blocks: [note.blocks[0], note.blocks[0]] }]).success).toBe(false);
    expect(executionSchema.safeParse({ summary: "Fixture", result: "done", wikiPages: [{ ...note, status: "impact_verified" }] }).success).toBe(false);
    const store = open(); const run = claim(store); writeFileSync(join(run.artifacts, "raw.txt"), "SYNTHETIC LOCAL REF");
    const board = store.applyExecution(run.runId, { summary: "Typed local refs", result: "done", evidence: [{ ref: "same", path: "raw.txt", description: "Fixture" }],
      facts: [{ ref: "same", description: "Fixture", evidenceRefs: ["same"] }], wikiPages: [note] }, usage);
    expect(board.wikiPages![0]!.blocks[0]!.sources).toEqual([{ kind: "fact", id: board.facts[0]!.id }, { kind: "evidence", id: board.evidence[0]!.id }]);
  });

  it("preserves checkpoint pages on failure, accepts idempotent replay, and seals final Step state", () => {
    const store = open(); seed(store); const run = claim(store);
    const proposal: Execution = { summary: "Checkpoint explanation", result: "no_progress", wikiPages: [page(store.snapshot().facts[0]!.id)] };
    proposal.wikiPages![0]!.title = "Checkpoint version";
    const board = store.applyExecutionCheckpoint(run.runId, "wiki-batch", proposal, usage);
    expect(store.applyExecutionCheckpoint(run.runId, "wiki-batch", proposal, usage)).toEqual(board);
    store.failRun(run.runId, "Synthetic interruption", usage, false);
    expect(store.snapshot().wikiPages).toEqual(board.wikiPages);
    const final = claim(store); const note = page(); note.blocks[0]!.sources = [{ kind: "step", id: final.step.id }];
    const result = store.applyExecution(final.runId, { summary: "Final explanation", result: "blocked", wikiPages: [note] }, usage);
    expect(wikiIssues(result, result.wikiPages![0]!)).toEqual([]);
  });

  it("keeps committed state after projection failure and reconstructs views without replaying execution", () => {
    const store = open(); const index = join(store.dataDir, "wiki", "index.md");
    writeFileSync(index, "USER FILE TO PRESERVE"); const board = seed(store);
    expect(store.wikiProjectionError).toContain("Preserving non-generated Wiki file");
    expect(readFileSync(index, "utf8")).toBe("USER FILE TO PRESERVE");
    expect(board.wikiPages).toHaveLength(1); expect(store.runs().at(-1)!.status).toBe("completed");
    store.setStatus("paused", "Fixture complete"); const before = store.events(); store.close(); unlinkSync(index);
    const reopened = open(store.workspace);
    expect(reopened.wikiProjectionError).toBeNull(); expect(reopened.snapshot().wikiPages).toEqual(board.wikiPages); expect(reopened.events()).toEqual(before);
    expect(readFileSync(index, "utf8")).toContain("Xloom 研究 Wiki");
  });

  it("rejects recognizable generated Wiki copies as evidence and verifies author source archives", () => {
    const store = open(); seed(store); const run = claim(store);
    writeFileSync(join(run.artifacts, "copied.md"), readFileSync(pagePath(store)));
    expect(() => store.applyExecution(run.runId, { summary: "Derived copy", result: "done", evidence: [{ ref: "copy", path: "copied.md", description: "Derived Wiki" }] }, usage)).toThrow("not original evidence");
    const board = store.snapshot(); const evidence = board.evidence[0]!;
    writeFileSync(join(store.dataDir, evidence.path), "TAMPERED FIXTURE");
    expect(() => store.applyExecution(run.runId, { summary: "Source check", result: "no_progress", wikiPages: [page(board.facts[0]!.id)] }, usage)).toThrow("Evidence changed");
    expect(store.snapshot()).toEqual(board);
  });

  it("refuses projection through a directory junction while retaining database changes", () => {
    const store = open(); const outside = join(store.workspace, "unrelated"); mkdirSync(outside);
    const sentinel = join(outside, "sentinel.txt"); writeFileSync(sentinel, "PRESERVE");
    const pages = join(store.dataDir, "wiki", "pages"), original = join(store.dataDir, "wiki", "pages-original");
    if (dirname(pages) !== join(store.dataDir, "wiki") || dirname(original) !== dirname(pages)) throw new Error("Unexpected fixture move path");
    renameSync(pages, original); symlinkSync(outside, pages, "junction");
    store.setStatus("paused", "Committed despite unavailable projection");
    expect(store.wikiProjectionError).toContain("must not be a symlink");
    expect(store.snapshot().status).toBe("paused"); expect(readFileSync(sentinel, "utf8")).toBe("PRESERVE");
  });

  it("tracks source conditions and preserves complete negation without flagging unrelated runtime changes", () => {
    const store = open(); const board = seed(store); const changed = structuredClone(board);
    changed.steps[0]!.runId = "PRIVATE_CHANGED_RUN";
    changed.steps[0]!.leaseUntil = 12345;
    changed.usage.input += 100;
    expect(wikiIssues(changed, changed.wikiPages![0]!)).toEqual([]);
    changed.steps[0]!.combination = { requires: [board.facts[0]!.id], scope: "new-tenant", stateVersion: "v2", missing: ["Not verified"], expectedCapability: "Unknown" };
    expect(wikiIssues(changed, changed.wikiPages![0]!)).not.toEqual([]);
    const files = renderWiki(changed, store.dataDir, store.workspace);
    expect([...files.values()].join("\n")).toContain("Cross-account consumption remains unverified.");
    expect([...files.values()].join("\n")).not.toContain("PRIVATE_CHANGED_RUN");
  });

  it("exposes compact research pointers, uses portable resources and excludes private runtime fields", () => {
    const store = open(); const board = seed(store);
    for (const collection of [board.steps, board.facts, board.evidence, board.findings]) for (const item of collection) Object.assign(item, { messages: "PRIVATE_MESSAGE", apiKey: "PRIVATE_KEY" });
    const files = renderWiki(board, store.dataDir, store.workspace);
    expect([...files.values()].join("\n")).not.toMatch(/PRIVATE_MESSAGE|PRIVATE_KEY|leaseUntil|runId/);
    const request: RunRequest = { id: "fixture", mode: "execute", snapshot: board, workspace: store.workspace,
      runDir: join(store.dataDir, "runs", "fixture"), blackboardPath: store.projectionPath, step: board.steps[0], signal: new AbortController().signal, onEvent() {} };
    expect(projectContext(request)).not.toHaveProperty("wikiPages");
    const prompt = buildRunPrompt(request); const data = JSON.parse(prompt.userPrompt.split("\n").at(-1)!);
    expect(data.wiki.indexFile).toBe(join(store.dataDir, "wiki", "index.md"));
    expect(existsSync(data.wiki.authoringGuide)).toBe(true);
    expect(readFileSync(data.wiki.authoringGuide, "utf8")).toContain("wikiPages");
    expect(JSON.stringify(data.wiki).length).toBeLessThan(1000);
    request.wikiProjectionError = "Synthetic projection failure";
    expect(JSON.parse(buildRunPrompt(request).userPrompt.split("\n").at(-1)!).wiki.status).toBe("unavailable");
    expect(buildRunPrompt(request).systemPrompt).toBe(prompt.systemPrompt);
    expect(wikiMarker).toContain("authoritative");
  });
});
