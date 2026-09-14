import { describe, expect, it } from "vitest";
import { observationRetrievalFixture } from "./fixtures/observation-retrieval.js";
import { buildRetrievalIndex } from "../src/wiki/catalog.js";
import { retrieveWiki } from "../src/wiki/retrieval.js";
import { join } from "node:path";

const task = join(process.cwd(), "synthetic-rag-fixture"), workspace = process.cwd();
describe("retrieval precision with complete source packages", () => {
  it("keeps complete query matches above repeated single-token distractors without deleting partial matches", () => {
    const board = observationRetrievalFixture(100);
    board.facts.push({ id: "F-complete", stepId: null, evidenceIds: [], description: "rareMarker scopedDownload" },
      { id: "F-distractor", stepId: null, evidenceIds: [], description: "rareMarker ".repeat(100) });
    const index = buildRetrievalIndex(board);
    const result = retrieveWiki(board, task, workspace, "rareMarker scopedDownload", { limit: 4 }, index);
    expect(result.hits[0]!.ref.id).toBe("F-complete");
    expect(result.hits.map(hit => hit.ref.id)).toContain("F-distractor");
    expect(retrieveWiki(board, task, workspace, "F-distractor rareMarker scopedDownload", { limit: 1 }, index).hits[0]!.reason).toBe("exact_reference");
  });
  it.each(["item40 downloadReport", "F-40", "item40 下载边界"])("recalls known content with its negative conditions and provenance: %s", query => {
    const board = observationRetrievalFixture(100), before = structuredClone(board);
    const result = retrieveWiki(board, task, workspace, query, { limit: 1 }, buildRetrievalIndex(board));
    expect(result.budgetDeferredCount).toBe(0);
    expect(result.records).toContainEqual(expect.objectContaining({ ref: { kind: "fact", id: "F-40" } }));
    expect(result.records).toContainEqual(expect.objectContaining({ ref: { kind: "evidence", id: "E-40" }, integrity: "not_checked" }));
    expect(JSON.stringify(result.records)).toContain("NOT verified"); expect(board).toEqual(before);
  });
});
