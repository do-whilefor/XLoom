import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { organizeWiki } from "../src/wiki/catalog.js";
import { observationRetrievalFixture } from "./fixtures/observation-retrieval.js";

describe("Wiki maintenance navigation", () => {
  it("links optional hint and standalone-page suggestions without changing source reviews", () => {
    const board = observationRetrievalFixture(40);
    board.facts[0]!.description = "Corrected source under another identity";
    const before = structuredClone(board), result = organizeWiki(board);
    expect(result.maintenance).toContainEqual(expect.objectContaining({ code: "missing_retrieval_hints", readPath: "xloom://record?kind=block&id=B-boundary&page=WK-0" }));
    expect(result.maintenance.filter(row => row.code === "unlinked_page")).toHaveLength(2);
    expect(result.reviewRequired.length).toBeGreaterThan(0); expect(board).toEqual(before);
  });
  it("accepts inherited page hints/questions and recognizes real directory connections", () => {
    const board = observationRetrievalFixture(40);
    for (const page of board.wikiPages!) { page.questions = ["What did alice actually observe in v1?"]; page.summary = "Recorded boundary"; }
    board.wikiPages![1]!.parentPageId = board.wikiPages![0]!.id;
    expect(organizeWiki(board).maintenance).toEqual([]);
  });
  it("does not mistake an alias for a question or a required explanation for an unlinked page", () => {
    const board = observationRetrievalFixture(40), first = board.wikiPages![0]!, second = board.wikiPages![1]!;
    first.aliases = ["KnownExportName"];
    second.blocks[0]!.requiredBlockRefs = [{ pageId: first.id, blockId: first.blocks[0]!.id }];
    const result = organizeWiki(board);
    expect(result.maintenance).toContainEqual(expect.objectContaining({ code: "missing_questions", ref: { kind: "block", pageId: first.id, id: "B-boundary" } }));
    expect(result.maintenance.some(row => row.code === "unlinked_page")).toBe(false);
  });
  it("retains long negative judgments and provides both duplicate source paths", () => {
    const board = observationRetrievalFixture(40), text = "Only alice/v1. ".repeat(600) + "NOT verified for bob.";
    for (const page of board.wikiPages!) page.blocks[0]!.text = text;
    const result = organizeWiki(board);
    expect(result.maintenance.filter(row => row.code === "large_judgment")).toHaveLength(2);
    expect(result.maintenance.filter(row => row.code === "duplicate_judgment").every(row => row.relatedReadPaths?.length === 1)).toBe(true);
    expect(board.wikiPages!.every(page => page.blocks[0]!.text === text)).toBe(true);
  });
  it("keeps metadata maintenance guidance scoped to questions and existing evidence", () => {
    const guide = readFileSync("resources/wiki/authoring.md", "utf8");
    expect(guide).toContain("rag.organizationFile"); expect(guide).toContain("must keep source-review warnings intact");
    expect(guide).toContain("Do not add speculative synonyms");
  });
});
