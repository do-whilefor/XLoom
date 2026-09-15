import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { wikiStructureFixture } from "./fixtures/wiki-structure.js";
import { assertWikiProjectionReady, clearWikiPageCaches, renderWiki, writeWiki } from "../src/wiki/projection.js";
import { wikiFilename, wikiMarker } from "../src/wiki/format.js";
import { auditWiki } from "../src/wiki/audit.js";
import { createWorkspaceReadTool } from "../src/runtime/read.js";
import { BlackboardStore } from "../src/store.js";

const fixtures: ReturnType<typeof wikiStructureFixture>[] = [], roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xloom-wiki-recovery-")); roots.push(root);
  const result = wikiStructureFixture(root); fixtures.push(result); return result;
}
afterEach(() => {
  for (const item of fixtures.splice(0)) item.store.close();
  clearWikiPageCaches();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("xloom-wiki-recovery-")) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("incremental Wiki projection and recovery", () => {
  it("reuses pages, invalidates descendant navigation and repairs manually changed generated files", () => {
    const { store } = fixture(), board = store.snapshot();
    expect(writeWiki(board, store.dataDir, store.workspace)).toMatchObject({ renderedPages: 0, writtenFiles: 0 });
    board.wikiPages!.find(page => page.id === "WK-index")!.title = "Renamed parent";
    const updated = writeWiki(board, store.dataDir, store.workspace);
    expect(updated.renderedPages).toBe(2);
    expect(updated.reusedPages).toBeGreaterThan(0);
    const path = join(store.dataDir, "wiki/pages", wikiFilename("note", "WK-flow"));
    expect(readFileSync(path, "utf8")).toContain("Renamed parent");
    writeFileSync(path, `${wikiMarker}\nALTERED DERIVED PAGE`);
    const repaired = writeWiki(board, store.dataDir, store.workspace);
    expect(repaired.renderedPages).toBe(0);
    expect(readFileSync(path, "utf8")).not.toContain("ALTERED DERIVED PAGE");
    expect(auditWiki(board, store.dataDir, store.workspace).status).toBe("consistent");
  });
  it("invalidates source-dependent pages with unchanged revision and matches a complete rebuild", () => {
    const { store, scopeId } = fixture(), board = store.snapshot();
    board.facts.find(fact => fact.id === scopeId)!.description = "Corrected: bob/v2 denied access; alice/v1 is obsolete";
    const result = writeWiki(board, store.dataDir, store.workspace);
    expect(result.renderedPages).toBeGreaterThan(1);
    for (const [path, body] of renderWiki(board, store.dataDir, store.workspace)) expect(readFileSync(join(store.dataDir, "wiki", path), "utf8")).toBe(body);
    expect(auditWiki(board, store.dataDir, store.workspace).status).toBe("review_required");
    clearWikiPageCaches();
    expect(writeWiki(board, store.dataDir, store.workspace).writtenFiles).toBe(0);
  });
  it("marks interrupted publication unavailable, preserves committed state and recovers without execution replay", async () => {
    const { store } = fixture(), file = join(store.dataDir, "wiki/index.md");
    writeFileSync(file, "USER FILE TO PRESERVE");
    store.setStatus("paused", "Committed before projection failure");
    const board = store.snapshot(), events = store.events();
    expect(store.wikiProjectionError).toContain("Preserving non-generated");
    expect(JSON.parse(readFileSync(join(store.dataDir, "wiki/projection-state.json"), "utf8")).status).toBe("building");
    expect(() => assertWikiProjectionReady(board, store.dataDir)).toThrow("incomplete or stale");
    const reader = createWorkspaceReadTool(store.workspace, undefined, { dataDir: store.dataDir, snapshot: () => board });
    await expect(reader.execute("read", { path: file })).rejects.toThrow("incomplete or stale");
    const native = await reader.execute("search", { path: "xloom://search?mode=wiki&query=BridgeAlias&budgetChars=64000" });
    expect(JSON.parse(native.content[0]!.type === "text" ? native.content[0]!.text : "{}").wiki.hits.length).toBeGreaterThan(0);
    store.close(); unlinkSync(file);
    const reopened = new BlackboardStore(store.workspace, board.config);
    try {
      expect(reopened.events()).toEqual(events);
      expect(reopened.snapshot()).toEqual(board);
      expect(reopened.wikiProjectionError).toBeNull();
      expect(() => assertWikiProjectionReady(board, reopened.dataDir)).not.toThrow();
    } finally { reopened.close(); }
  });
  it("removes obsolete hash-listed pages but preserves changed files and unrelated paths", () => {
    const { store } = fixture(), board = store.snapshot();
    const path = join(store.dataDir, "wiki/pages", wikiFilename("note", "WK-flow"));
    const retained = join(store.dataDir, "wiki/pages", wikiFilename("note", "WK-context"));
    writeFileSync(retained, `${wikiMarker}\nUSER ANNOTATION`);
    board.wikiPages = board.wikiPages!.filter(page => page.id === "WK-index");
    const result = writeWiki(board, store.dataDir, store.workspace);
    expect(result.removedFiles).toBe(1); expect(existsSync(path)).toBe(false);
    expect(readFileSync(retained, "utf8")).toContain("USER ANNOTATION");
    expect(() => assertWikiProjectionReady(board, store.dataDir)).not.toThrow();
  });
});
