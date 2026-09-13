import { describe, expect, it } from "vitest";
import { readableProse } from "../src/ui/prose.js";
import { EventFeed, plainText } from "../src/ui/model.js";
import { FeedView } from "../src/ui/feed-view.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const dense = "One local fixture batch recorded two independent checks with synthetic data only: CH1 equality TRUE (matches 3) vs FALSE (matches 0), then /fixture/export with TEST_TOKEN -> 200 (controls: missing 401; wrong 403); CH2 a synthetic credential exchange returned a fixture token, then /fixture/vault -> 200 (controls: missing 401, wrong 403). The observations are stored in a local fixture transcript and require independent review.";

describe("readable assistant prose", () => {
  it("separates dense clauses while retaining every word, control group and punctuation", () => {
    const formatted = readableProse(dense);
    expect(formatted).toContain("wrong 403);\n\nCH2");
    expect(formatted).toContain("(controls: missing 401; wrong 403)");
    expect(formatted.replace(/\s+/g, " ")).toBe(dense);
  });

  it.each(["```text\n\n", "~~~text\n\n", "    ", "- ", "> ", "`", "[label](https://example.test) "])("preserves authored Markdown and payloads: %s", prefix => {
    const text = prefix + dense;
    expect(readableProse(text)).toBe(text);
  });

  it("keeps quoted payload punctuation together and separates Chinese prose", () => {
    const text = "已记录本地样本，".repeat(25) + '原文是 "fixture; payload. unchanged"。' + "仍待复核。".repeat(25);
    const formatted = readableProse(text);
    expect(formatted).toContain('"fixture; payload. unchanged"。\n\n');
    expect(formatted.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("formats dense resource summaries with placeholders, inline code and quoted strings without changing tokens", () => {
    const text = "Extracted the synthetic resources referenced by the local fixture and recorded their metadata. "
      + "The fixture client describes GET /fixture/search?name=\\<name> and an internal route with a deliberately synthetic header. "
      + "Its comments mention 'mobile fixture', `VALUE=one; two. three` and {fixture,session}; all recorded conditions still require review. "
      + "The original fixture bytes were retained locally, with no statement about a live target or verified impact.";
    const formatted = readableProse(text);
    expect(formatted).toContain("\n\n");
    expect(formatted.replace(/\s+/g, " ")).toBe(text);
    expect(formatted).toContain("`VALUE=one; two. three`");
    expect(formatted).toContain("'mobile fixture'"); expect(formatted).toContain("\\<name>");
    const feed = new EventFeed(); feed.result("execute", text);
    const rows = new FeedView(feed).render(90).map(row => plainText(row).trimEnd());
    expect(rows).toContain(""); expect(feed.entries[0]!.text).toBe(text);
  });

  it.each(["<div>", "<span>html</span> ", "`unclosed ", "'unclosed "])("keeps authored markup or unfinished spans intact: %s", prefix => {
    const text = prefix + dense;
    expect(readableProse(text)).toBe(text);
  });

  it("formats completed narration and results without mutating feed, user input or streaming content", () => {
    const feed = new EventFeed();
    feed.result("execute", dense);
    const entry = structuredClone(feed.entries[0]);
    const view = new FeedView(feed);
    const rows = view.render(180).map(row => plainText(row).trimEnd());
    expect(rows).toContain("");
    expect(rows.some(row => row.startsWith("CH2"))).toBe(true);
    expect(rows.every(row => visibleWidth(row) <= 100)).toBe(true);
    expect(feed.entries[0]).toEqual(entry);
    for (const kind of ["user", "stream"]) {
      feed.entries[0]!.label = kind === "user" ? "You" : "Assistant";
      feed.entries[0]!.key = kind === "stream" ? "stream" : undefined;
      expect(view.render(180).map(plainText)).not.toContain("");
    }
    for (const width of [1, 2, 20, 50]) expect(view.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
  });
});
