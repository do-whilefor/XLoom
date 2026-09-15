import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { auditWiki } from "../src/wiki/audit.js";
import { runLocal } from "../src/wiki/local.js";
import { renderWiki } from "../src/wiki/projection.js";
import { retrieveWiki } from "../src/wiki/retrieval.js";

const roots: string[] = [], stores: BlackboardStore[] = [];
function open() {
  const root = mkdtempSync(join(tmpdir(), "xloom-local-wiki-")); roots.push(root);
  const store = new BlackboardStore(root, defaultConfig("Local retrieval fixture"), { taskId: "fixture-task" }); stores.push(store);
  store.setStatus("running", "Synthetic fixture");
  store.beginRun("plan", "decide");
  store.applyDecision("plan", { summary: "Fixture", steps: [{ goalId: "G0", from: [], description: "Store synthetic local observation", successSignal: "Fixture", evidencePlan: "Fixture", priority: 1 }] }, { input: 0, output: 0, cost: 0 });
  const step = store.snapshot().steps[0]!;
  store.beginRun("fixture-run", "execute", step.id);
  const artifacts = join(store.dataDir, "runs", "fixture-run", "artifacts"); mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "source.txt"), "SYNTHETIC LOCAL ORIGINAL\nExport job is recorded; download remains unverified.\n");
  store.applyExecution("fixture-run", { summary: "Fixture", result: "done", evidence: [{ ref: "e", path: "source.txt", description: "Synthetic original" }],
    facts: [{ ref: "f", description: "Local export fixture", evidenceRefs: ["e"] }], wikiPages: [{ id: "WK-local", title: "Local export explanation", blocks: [{ id: "B-gap", title: "Remaining consumer gap",
      text: "Download remains unverified; source metadata is not demonstrated impact.", sources: [{ kind: "fact", id: "f" }] }] }] }, { input: 1, output: 1, cost: 0 });
  return { store, root, artifacts };
}
function args(store: BlackboardStore, action: string, extra: string[] = []) { return [action, "--task", store.dataDir, "--workspace", store.workspace, ...extra]; }
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes("xloom-local-wiki-")) throw new Error("Unexpected local Wiki fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local organization, integrity audit and script entry", () => {
  it.each([["--help"], ["-h"], ["search", "--help"]])("shows help without task/workspace or opening a database (%j)", (...argv) => {
    const database = vi.spyOn(DatabaseSync.prototype, "prepare");
    const help = runLocal(argv);
    expect(help).toMatchObject({ exitCode: 0, output: { type: "help", actions: { search: expect.any(String), "read-original": expect.stringContaining("automatic paging") } } });
    expect(database).not.toHaveBeenCalled();
  });
  it("publishes hash-listed organization and retrieval projections on ordinary commits", () => {
    const { store } = open(); const manifest = JSON.parse(readFileSync(join(store.dataDir, "wiki/manifest.json"), "utf8"));
    for (const name of ["search-index.json", "organization.json"]) {
      const body = readFileSync(join(store.dataDir, "wiki", name));
      expect(manifest.files).toContainEqual({ path: name, sha256: createHash("sha256").update(body).digest("hex") });
      expect(JSON.parse(body.toString())).toMatchObject({ generator: "xloom-wiki-v1", evidence: false, boardRevision: store.snapshot().revision });
    }
    expect(auditWiki(store.snapshot(), store.dataDir, store.workspace)).toMatchObject({ status: "consistent", checkedEvidence: 1, issues: [] });
  });

  it("reads the current committed board without taking the writer lock or recovering an active run", () => {
    const { store } = open(); store.beginRun("still-active", "decide");
    const before = store.snapshot(), runs = store.runs(), events = store.events();
    expect(runLocal(args(store, "search", ["--query", "consumer"])).output).toMatchObject({ type: "retrieval", evidence: false });
    expect(runLocal(args(store, "organize")).output).toMatchObject({ type: "organization", counts: { blocks: 1 } });
    expect(runLocal(args(store, "audit"))).toMatchObject({ exitCode: 0, output: { status: "consistent" } });
    expect(store.snapshot()).toEqual(before); expect(store.runs()).toEqual(runs); expect(store.events()).toEqual(events);
  });

  it("refuses to publish a result after a concurrent committed board change", () => {
    const { store } = open();
    const prepare = DatabaseSync.prototype.prepare;
    let reads = 0;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "SELECT value FROM board WHERE id=1" && ++reads === 2) store.setStatus("paused", "Concurrent committed fixture update");
      return prepare.call(this, sql);
    });
    expect(() => runLocal(args(store, "search", ["--query", "consumer"]))).toThrow("Task changed during the local operation");
    expect(store.snapshot().reason).toBe("Concurrent committed fixture update");
  });

  it("detects altered original bytes, even of the same size, without repairing or deleting evidence", () => {
    const { store } = open(), board = store.snapshot(), evidence = board.evidence[0]!, file = join(store.dataDir, evidence.path);
    const original = readFileSync(file), changed = Buffer.from(original); changed[0] ^= 1; writeFileSync(file, changed);
    const report = runLocal(args(store, "audit"));
    expect(report).toMatchObject({ exitCode: 2, output: { status: "unavailable", issues: [expect.objectContaining({ code: "evidence_mismatch", id: evidence.id })] } });
    expect(readFileSync(file)).toEqual(changed); expect(store.snapshot()).toEqual(board);
  });

  it("reports missing originals and missing generated pages separately", () => {
    const { store } = open(), board = store.snapshot();
    unlinkSync(join(store.dataDir, board.evidence[0]!.path)); unlinkSync(join(store.dataDir, "wiki/index.md"));
    const report = auditWiki(board, store.dataDir, store.workspace);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["projection_unavailable", "evidence_unavailable"]));
    expect(report.status).toBe("unavailable");
  });

  it("streams the full evidence hash and finds a changed tail beyond the first buffer", () => {
    const { store } = open(), board = store.snapshot(), evidence = board.evidence[0]!, file = join(store.dataDir, evidence.path);
    const body = Buffer.alloc(256 * 1024, 65); writeFileSync(file, body);
    evidence.bytes = body.length; evidence.sha256 = createHash("sha256").update(body).digest("hex");
    // Projection mismatch is expected for this intentionally modified in-memory fixture.
    expect(auditWiki(board, store.dataDir, store.workspace).issues.some(issue => issue.code === "evidence_mismatch")).toBe(false);
    body[body.length - 1] ^= 1; writeFileSync(file, body);
    expect(auditWiki(board, store.dataDir, store.workspace).issues).toContainEqual(expect.objectContaining({ code: "evidence_mismatch", id: evidence.id }));
  });

  it("does not trust a poisoned persisted index and rebuilds generated projections from SQLite", () => {
    const { store } = open(), board = store.snapshot(), file = join(store.dataDir, "wiki/search-index.json");
    writeFileSync(file, JSON.stringify({ generator: "xloom-wiki-v1", documents: [{ text: "INJECTED_UNTRUSTED_CONTENT" }], postings: {} }));
    expect(JSON.stringify(runLocal(args(store, "search", ["--query", "consumer"])).output)).not.toContain("INJECTED_UNTRUSTED_CONTENT");
    expect(auditWiki(board, store.dataDir, store.workspace).issues).toContainEqual(expect.objectContaining({ code: "projection_mismatch", path: file }));
    store.setStatus("paused", "Rebuild derived projection");
    expect(readFileSync(file, "utf8")).not.toContain("INJECTED_UNTRUSTED_CONTENT");
    expect(auditWiki(store.snapshot(), store.dataDir, store.workspace).status).toBe("consistent");
    expect(store.snapshot().facts).toEqual(board.facts); expect(store.snapshot().wikiPages).toEqual(board.wikiPages);
  });

  it("recreates a deleted index on reopen and preserves a non-generated conflicting file", () => {
    const { store } = open(); const file = join(store.dataDir, "wiki/search-index.json"), before = store.snapshot();
    store.setStatus("paused", "Fixture"); store.close(); unlinkSync(file);
    const reopened = new BlackboardStore(store.workspace, before.config, { taskId: "fixture-task" }); stores.push(reopened);
    expect(existsSync(file)).toBe(true); expect(reopened.wikiProjectionError).toBeNull();
    writeFileSync(file, "USER NOTES TO PRESERVE"); reopened.setStatus("paused", "Preserve unrelated contents");
    expect(reopened.wikiProjectionError).toContain("Preserving non-generated Wiki file");
    expect(readFileSync(file, "utf8")).toBe("USER NOTES TO PRESERVE");
  });

  it("refuses to follow projection or evidence directory junctions during audit", () => {
    const { store, root } = open(), outside = join(root, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "sentinel.txt"), "PRIVATE OUTSIDE CONTENT");
    for (const folder of [join(store.dataDir, "wiki/pages"), join(store.dataDir, "evidence")]) {
      const backup = `${folder}-backup`;
      if (!folder.startsWith(`${store.dataDir}\\`) && !folder.startsWith(`${store.dataDir}/`)) throw new Error("Unexpected fixture move path");
      renameSync(folder, backup); symlinkSync(outside, folder, "junction");
    }
    const report = auditWiki(store.snapshot(), store.dataDir, store.workspace);
    expect(report.status).toBe("unavailable"); expect(JSON.stringify(report)).not.toContain("PRIVATE OUTSIDE CONTENT");
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["projection_unavailable", "evidence_unavailable"]));
  });

  it("keeps a changed author's source baseline stale after organization and an integrity audit", () => {
    const { store } = open(), board = store.snapshot(), before = structuredClone(board.wikiPages);
    board.facts[0]!.description = "Updated fixture condition";
    // Audit the changed in-memory public snapshot against old projections: both kinds of issue remain visible.
    const report = auditWiki(board, store.dataDir, store.workspace);
    expect(report.organization.reviewRequired).toHaveLength(1); expect(report.issues.length).toBeGreaterThan(0);
    expect(board.wikiPages).toEqual(before);
    expect(retrieveWiki(board, store.dataDir, store.workspace, "consumer").records).toContainEqual(expect.objectContaining({ status: "review_required" }));
  });

  it("rejects recognizably derived retrieval, organization and audit JSON as original evidence", () => {
    const { store, artifacts } = open();
    store.beginRun("plan-2", "decide");
    store.applyDecision("plan-2", { summary: "Fixture", steps: [{ goalId: "G0", from: [], description: "Derived copy test", successSignal: "Fixture", evidencePlan: "Fixture", priority: 1 }] }, { input: 0, output: 0, cost: 0 });
    store.beginRun("derived-run", "execute", store.snapshot().steps.at(-1)!.id);
    const current = join(dirname(dirname(artifacts)), "derived-run/artifacts"); mkdirSync(current, { recursive: true });
    for (const action of ["search", "organize", "audit"]) {
      const data = JSON.stringify(runLocal(args(store, action, action === "search" ? ["--query", "consumer"] : [])).output);
      writeFileSync(join(current, "derived.json"), data);
      const before = store.snapshot();
      expect(() => store.applyExecution("derived-run", { summary: "Invalid evidence", result: "done", evidence: [{ ref: "e", path: "derived.json", description: "Derived material" }] }, { input: 0, output: 0, cost: 0 })).toThrow("not original evidence");
      expect(store.snapshot()).toEqual(before);
    }
  });

  it("runs the packaged script from an unrelated working directory and returns exact source references", () => {
    const { store, root } = open(); const script = fileURLToPath(new URL("../dist/wiki/local.js", import.meta.url));
    const output = execFileSync(process.execPath, [script, ...args(store, "search", ["--kind", "block", "--page", "WK-local", "--id", "B-gap"])], { cwd: root, encoding: "utf8", timeout: 10000 });
    const data = JSON.parse(output); expect(data.hits).toHaveLength(1); expect(data.records).toContainEqual(expect.objectContaining({ ref: { kind: "fact", id: store.snapshot().facts[0]!.id } }));
    expect(JSON.stringify(data)).not.toContain("runId");
  });

  it.each([["--limit", "0"], ["--kind", "block", "--id", "B-gap"], ["--page", "WK-local"], ["--unknown", "value"]])("rejects invalid local search options %j", extra => {
    const { store } = open(); expect(() => runLocal(args(store, "search", extra))).toThrow();
  });
});
