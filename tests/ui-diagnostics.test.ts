import { describe, expect, it } from "vitest";
import { EventFeed, formatRunError, plainText } from "../src/ui/model.js";
import { FeedView } from "../src/ui/feed-view.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const raw = "steps.0: Unrecognized key(s) in object: 'id'; steps.1: Unrecognized key(s) in object: 'id'; steps.2: Unrecognized key(s) in object: 'id'";
describe("readable protocol progress and failures", () => {
  it("groups repeated field failures, states what was retained and wraps recovery guidance", () => {
    const feed = new EventFeed(); feed.failure(raw);
    const entry = feed.entries[0]!;
    expect(entry.text).toContain("新步骤 1、新步骤 2、新步骤 3：包含不支持的字段：'id'");
    expect(entry.text).toContain("本次结果未提交"); expect(entry.text).toContain("/start"); expect(entry.details).toBe(raw);
    const view = new FeedView(feed);
    for (const width of [20, 40, 90]) {
      const rows = view.render(width);
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
      expect(rows.map(plainText).join("")).toContain("/start");
      expect(rows.map(plainText).join("\n")).not.toContain("Unrecognized");
    }
    view.toggleDetails(); expect(view.render(90).map(plainText).join("\n")).toContain("Unrecognized");
  });

  it("formats new failure envelopes and keeps actual conflicts readable", () => {
    const text = formatRunError(`Final response protocol validation failed after one repair: ${raw}`);
    expect(text).toContain("新步骤 3"); expect(text).not.toContain("after one repair");
    expect(formatRunError("Final response protocol validation failed: steps.0.combination.missing: Conflicting nested and top-level values.")).toContain("本次结果未提交");
    expect(formatRunError("Some other failure")).toBe("Some other failure");
  });

  it("shows short Chinese repair/normalization progress and retains raw diagnostic details", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "notice", mode: "decide", text: "Final response has an invalid protocol shape or reference; requesting one tool-free repair using existing results." });
    feed.notice("Decision format normalized without another model request: steps.0.id omitted");
    const view = new FeedView(feed);
    const text = view.render(40).map(plainText).join("");
    expect(text).toContain("正在修正模型结果格式"); expect(text).toContain("未追加模型请求"); expect(text).not.toContain("invalid protocol");
    view.toggleDetails(); expect(view.render(90).map(plainText).join("\n")).toContain("steps.0.id omitted");
  });

  it("deduplicates checkpoint identity only, retaining distinct commits, runs and the final answer", () => {
    const feed = new EventFeed();
    const checkpoint = { mode: "execute" as const, summary: "Saved fixture", runId: "run-1", checkpointId: "batch-1", kind: "checkpoint" as const };
    const publish = (source = checkpoint) => feed.result(source.mode, source.summary, undefined, false, source);
    publish(); publish(); expect(feed.entries).toHaveLength(1);
    publish({ ...checkpoint, checkpointId: "batch-2" }); publish({ ...checkpoint, runId: "run-2" });
    feed.result("execute", checkpoint.summary); feed.result("metacog", checkpoint.summary, undefined, true);
    expect(feed.entries).toHaveLength(5); expect(feed.entries.at(-1)!.final).toBe(true);
  });
});
