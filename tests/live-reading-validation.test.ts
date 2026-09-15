import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeReadingOutcomes } from "../scripts/lib/reading-outcomes.js";
import { searchTask } from "../src/wiki/query.js";
import { wikiStructureFixture } from "./fixtures/wiki-structure.js";
import type { Evidence, RuntimeEvent } from "../src/types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const root = resolve("synthetic-reading"), body = "abc更正";
const evidence = { id: "E1", sha256: hash(body), bytes: Buffer.byteLength(body), path: "evidence/original.bin", pathBase: "task" } as Evidence;
function read(mode: RuntimeEvent["mode"], path: string, text: string, isError = false, id = "call"): RuntimeEvent[] {
  return [{ type: "tool_start", mode, toolName: "read", toolCallId: id, text: JSON.stringify({ path }) },
    { type: "tool_end", mode, toolName: "read", toolCallId: id, text, isError }];
}
function native(mode: RuntimeEvent["mode"], text = body, byteOffset = 0, overrides = {}): RuntimeEvent[] {
  return read(mode, "xloom://original?evidenceId=E1", JSON.stringify({ type: "original_read", integrity: "verified",
    locator: { evidenceId: "E1", sha256: evidence.sha256, byteOffset, byteLength: Buffer.byteLength(text) },
    rangeSha256: hash(text), text, ...overrides }));
}
const analyze = (events: RuntimeEvent[]) => analyzeReadingOutcomes(events, [evidence], root, root);

describe("live native reading verification", () => {
  it("distinguishes fully delivered file bytes from the required native route", () => {
    const result = analyze([...read("decide", join(root, evidence.path), body), ...native("execute")]);
    expect(result.originalDeliveryByBothRoles).toBe(true);
    expect(result.nativeReadingByBothRoles).toBe(false);
    expect(result.coverage[0].evidence[0]).toMatchObject({ fileComplete: true, nativeComplete: false });
  });

  it("joins byte ranges out of order and allows overlap, but not gaps or another role's bytes", () => {
    expect(analyze([...native("decide", "更正", 3), ...native("decide", "abc"), ...native("decide", "bc", 1), ...native("execute")]).nativeReadingByBothRoles).toBe(true);
    expect(analyze([...native("decide", "ab"), ...native("decide", "更正", 3), ...native("execute")]).nativeReadingByBothRoles).toBe(false);
    expect(analyze([...native("decide", "abc"), ...native("execute", "更正", 3)]).nativeReadingByBothRoles).toBe(false);
  });

  it("requires successful paired read events in the same role", () => {
    const events = native("decide");
    expect(analyze([events[1]]).deliveries).toHaveLength(0);
    expect(analyze([events[0], { ...events[1], mode: "execute" }]).deliveries).toHaveLength(0);
    expect(analyze([events[0], { ...events[1], isError: true }]).deliveries).toHaveLength(0);
    expect(analyze([events[0], { ...events[1], toolCallId: "different" }]).deliveries).toHaveLength(0);
  });

  it("rejects stale hashes, wrong evidence IDs, invalid ranges and altered output", () => {
    for (const overrides of [
      { integrity: "not_checked" }, { rangeSha256: "wrong" }, { text: `${body} truncated` },
      ...[{ evidenceId: "E2" }, { sha256: "old" }, { byteOffset: -1 }, { byteOffset: 1 }, { byteLength: 1.5 }]
        .map(change => ({ locator: { evidenceId: "E1", sha256: evidence.sha256, byteOffset: 0, byteLength: evidence.bytes, ...change } })),
    ]) expect(analyze(native("decide", body, 0, overrides)).deliveries).toHaveLength(0);
  });

  it("does not count file paths, snippets, or identical content from another file as delivery", () => {
    for (const events of [read("decide", join(root, evidence.path), body.slice(1)),
      read("decide", join(root, evidence.path), body + " [truncated]"), read("decide", join(root, "other.bin"), body),
      read("decide", join(root, evidence.path), body, true), read("decide", evidence.path, body)]) {
      expect(analyze(events).deliveries).toHaveLength(0);
    }
    expect(analyzeReadingOutcomes([], [], root, root).nativeReadingByBothRoles).toBe(false);
  });

  it("requires a completed native Wiki search for each role, independently of original reading", () => {
    const packet = { type: "task_search", mode: "wiki", query: "BridgeAlias", complete: true, wiki: { records: [{ id: "source" }] } };
    const search = (mode: RuntimeEvent["mode"], complete: boolean) => read(mode, "xloom://search?mode=wiki&query=BridgeAlias", JSON.stringify({ ...packet, complete }));
    expect(analyze([...search("decide", true), ...search("execute", false)]).nativeSearchByBothRoles).toBe(false);
    expect(analyze([...search("decide", true), ...search("execute", true)]).nativeSearchByBothRoles).toBe(true);
    expect(analyze([...native("decide"), ...native("execute")]).nativeSearchByBothRoles).toBe(false);
  });

  it("provides the guided fixture's full source package and all archive locators at the stated budget", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "xloom-live-reading-contract-"));
    const fixture = wikiStructureFixture(fixtureRoot);
    try {
      const board = fixture.correct();
      const result = searchTask(board, fixture.store.dataDir, fixtureRoot, "BridgeAlias", { mode: "wiki", budgetChars: 64000 });
      expect(result.complete).toBe(true);
      const json = JSON.stringify(result);
      for (const item of board.evidence) { expect(json).toContain(item.id); expect(json).toContain(item.sha256); }
      expect(json).toContain("originalReadPath");
      expect(json).toContain("WK-flow");
      expect(json).toContain("aliases");
    } finally { fixture.store.close(); }
  });
});
