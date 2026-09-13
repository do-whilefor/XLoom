import { describe, expect, it } from "vitest";
import { groupActivities, summarizeActivity, type ActivityGroup } from "../src/ui/activity.js";
import type { FeedEntry } from "../src/ui/model.js";

const entry = (kind: FeedEntry["kind"], values: Partial<FeedEntry> = {}): FeedEntry => ({ kind, label: "Assistant", text: "", ...values });
const tool = (label: string, state: FeedEntry["state"] = "done", values: Partial<FeedEntry> = {}): FeedEntry => entry("tool", { label, state, ...values });
const thought = (startedAt = 1000, endedAt?: number, values: Partial<FeedEntry> = {}): FeedEntry => entry("thinking", { startedAt, endedAt, ...values });
const group = (...entries: FeedEntry[]): ActivityGroup => ({ kind: "group", anchor: entries[0]!, entries });

describe("activity grouping", () => {
  it("groups contiguous thoughts, tools and protocol while preserving object identity and order", () => {
    const entries = [thought(0, 1000), entry("protocol", { text: '{"intent":"raw"}' }), tool("Read"), tool("PowerShell")];
    const original = [...entries];
    const result = groupActivities(entries);
    expect(result).toHaveLength(1);
    const grouped = result[0] as ActivityGroup;
    expect(grouped.kind).toBe("group");
    expect(grouped.anchor).toBe(entries[0]);
    grouped.entries.forEach((item, index) => expect(item).toBe(entries[index]));
    expect(entries).toEqual(original);
    expect(groupActivities(entries)[0]).not.toBe(grouped);
  });

  it.each(["message", "activity", "notice", "work", undefined] as const)("splits groups at %s boundaries", kind => {
    const before = tool("Read");
    const boundary = entry(kind);
    const after = tool("Edit");
    const result = groupActivities([before, boundary, after]);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe(boundary);
    expect((result[0] as ActivityGroup).entries).toEqual([before]);
    expect((result[2] as ActivityGroup).entries).toEqual([after]);
  });

  it("starts a new group when thinking resumes after tools", () => {
    const a = thought(0, 1000), b = thought(500, 1500), c = tool("Read");
    const d = entry("protocol"), e = thought(2000, 3000), f = tool("PowerShell");
    const result = groupActivities([a, b, c, d, e, f]) as ActivityGroup[];
    expect(result.map(item => item.entries)).toEqual([[a, b, c, d], [e, f]]);
    expect(result.map(item => item.anchor)).toEqual([a, e]);
  });

  it("supports tool-only groups without fabricating a thought", () => {
    const a = tool("Read"), b = tool("Write");
    const result = groupActivities([a, b]) as ActivityGroup[];
    expect(result[0]?.anchor).toBe(a);
    expect(result[0]?.entries).toEqual([a, b]);
    expect(summarizeActivity(result[0]!, 1000).text).not.toContain("Thought");
  });

  it("keeps diagnostics for details without making them an anchor or separator", () => {
    const a = entry("diagnostic", { text: "leading" }), b = thought(0, 1000);
    const c = entry("diagnostic", { text: "middle" }), d = tool("Read"), e = entry("diagnostic", { text: "trailing" });
    const result = groupActivities([a, b, c, d, e]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a);
    expect((result[1] as ActivityGroup).anchor).toBe(b);
    expect((result[1] as ActivityGroup).entries).toEqual([b, c, d, e]);
  });

  it("keeps protocol-only groups silent in normal presentation", () => {
    const protocol = entry("protocol", { text: '{"summary":"not a reply"}' });
    const diagnostic = entry("diagnostic", { text: "pricing unknown" });
    const result = groupActivities([protocol, diagnostic]) as ActivityGroup[];
    expect(result[0]?.entries).toEqual([protocol, diagnostic]);
    expect(summarizeActivity(result[0]!, 1000)).toEqual({ text: "", active: false, failed: 0 });
  });

  it("preserves complete ordering across roles, replies, diagnostics and the work footer", () => {
    const entries = [entry("message"), entry("activity"), thought(0, 1000), tool("Read"), entry("protocol"),
      entry("message"), entry("activity"), tool("Edit"), entry("diagnostic"), entry("work")];
    const flattened = groupActivities(entries).flatMap(item => item.kind === "group" ? item.entries : [item]);
    expect(flattened).toEqual(entries);
    flattened.forEach((item, index) => expect(item).toBe(entries[index]));
  });

  it("accepts empty and frozen feed data without mutating entries", () => {
    expect(groupActivities([])).toEqual([]);
    const a = Object.freeze(thought(0, 1000));
    const entries = Object.freeze([a]);
    expect((groupActivities(entries)[0] as ActivityGroup).anchor).toBe(a);
    expect(a).not.toHaveProperty("expanded");
  });
});

describe("accurate activity summaries", () => {
  it("summarizes completed thinking and successful tools in a single sentence", () => {
    expect(summarizeActivity(group(thought(1000, 7000), tool("Read"), tool("PowerShell"), tool("PowerShell")), 100_000)).toEqual({
      text: "Thought for 6s, read 1 file, ran 2 shell commands", active: false, failed: 0,
    });
  });

  it("reports active thinking and running tools without counting them as successful", () => {
    expect(summarizeActivity(group(thought(1000), tool("PowerShell", "running")), 4000)).toEqual({
      text: "Thinking for 3s, running 1 shell command", active: true, failed: 0,
    });
  });

  it("summarizes tool-only activity without inventing thought time", () => {
    expect(summarizeActivity(group(tool("Read"), tool("PowerShell"), tool("PowerShell")), 9000)).toEqual({
      text: "Read 1 file, ran 2 shell commands", active: false, failed: 0,
    });
  });

  it("merges overlapping thought intervals instead of adding parallel elapsed time twice", () => {
    expect(summarizeActivity(group(thought(1000, 4000), thought(3000, 6000), thought(2000, 3500)), 10000).text).toBe("Thought for 5s");
  });

  it("sums only disjoint thinking durations, excluding the gaps and all tool times", () => {
    const entries = group(thought(1000, 2000), thought(4000, 6000), tool("Read", "done", { startedAt: 7000, endedAt: 90000 }));
    expect(summarizeActivity(entries, 100000).text).toBe("Thought for 3s, read 1 file");
  });

  it("unions a live interval with completed blocks and rounds only the total", () => {
    const entries = group(thought(1000, 2800), thought(2500), thought(100, 600));
    expect(summarizeActivity(entries, 3300).text).toBe("Thinking for 2s");
    expect(summarizeActivity(entries, 4100).text).toBe("Thinking for 3s");
  });

  it.each([
    { durationKnown: false }, { startedAt: undefined }, { startedAt: NaN },
  ])("does not invent duration when timing is unknown: %j", values => {
    expect(summarizeActivity(group(thought(1000, 4000, values)), 9000).text).toBe("Thought");
  });

  it("does not present a partially known total as complete thought timing", () => {
    expect(summarizeActivity(group(thought(1000, 4000), thought(5000, 9000, { durationKnown: false })), 10000).text).toBe("Thought");
  });

  it("clamps reversed clocks to zero and handles invalid current time without NaN output", () => {
    expect(summarizeActivity(group(thought(5000, 1000, { text: "A real provider thought." })), 10000).text).toBe("Thought for <1s");
    expect(summarizeActivity(group(thought(5000)), 1000).text).toBe("Thinking for <1s");
    expect(summarizeActivity(group(thought(5000)), NaN).text).toBe("Thinking…");
  });

  it.each(["", "  ", "Problem:", "∴ Problem：\n"])("omits an empty completed subsecond thought: %j", text => {
    const empty = thought(1000, 1800, { text });
    expect(summarizeActivity(group(empty), 9000)).toEqual({ text: "", active: false, failed: 0 });
    expect(summarizeActivity(group(empty, tool("PowerShell")), 9000).text).toBe("Ran 1 shell command");
  });

  it("retains live empty thoughts and actual subsecond reasoning", () => {
    expect(summarizeActivity(group(thought(1000)), 1000).text).toBe("Thinking for <1s");
    expect(summarizeActivity(group(thought(1000, 1800, { text: "Problem: a response was incomplete." })), 9000).text).toBe("Thought for <1s");
  });

  it.each([{ durationKnown: false }, { startedAt: undefined }, { startedAt: NaN }, { endedAt: Infinity }])(
    "keeps active thinking visible without inventing unknown seconds: %j", values => {
      expect(summarizeActivity(group(thought(1000, undefined, values)), 9000)).toEqual({ text: "Thinking…", active: true, failed: 0 });
    },
  );

  it("separates all four successful and running tool counts with correct plural forms", () => {
    const entries = group(tool("Read"), tool("Read"), tool("Write"), tool("Edit"), tool("PowerShell"),
      tool("Read", "running"), tool("Write", "running"), tool("Edit", "running"), tool("PowerShell", "running"), tool("PowerShell", "running"));
    expect(summarizeActivity(entries, 1000)).toEqual({
      text: "Read 2 files, wrote 1 file, edited 1 file, ran 1 shell command, reading 1 file, writing 1 file, editing 1 file, running 2 shell commands",
      active: true, failed: 0,
    });
  });

  it("does not count failed calls as completed or running commands", () => {
    const entries = group(tool("PowerShell"), tool("PowerShell", "error"), tool("Read", "done", { error: true }), tool("Edit", "running"));
    expect(summarizeActivity(entries, 1000)).toEqual({ text: "Ran 1 shell command, editing 1 file, 2 failed", active: true, failed: 2 });
  });

  it("reports a failed-only group without claiming any success", () => {
    expect(summarizeActivity(group(tool("Read", "error")), 1000)).toEqual({ text: "1 failed", active: false, failed: 1 });
  });

  it("counts tool calls even when the same path or tool-call key is reused", () => {
    const options = { text: "same.txt", key: "reused" };
    expect(summarizeActivity(group(tool("Read", "done", options), tool("Read", "done", options)), 1000).text).toBe("Read 2 files");
  });

  it("never extracts success or activity from untrusted prose, protocol or diagnostics", () => {
    const entries = group(tool("Read", "running", { output: "successfully wrote 200 files" }), entry("protocol", { text: '{"read":999}' }),
      entry("diagnostic", { text: "ran 42 commands" }));
    expect(summarizeActivity(entries, 1000)).toEqual({ text: "Reading 1 file", active: true, failed: 0 });
  });

  it("keeps unknown tool labels out of generated summaries and counts only generic calls", () => {
    const entries = group(tool("HOSTILE\x1b[2J"), tool("hostile", "running"), tool("hostile", "error"));
    expect(summarizeActivity(entries, 1000)).toEqual({ text: "Ran 1 tool call, running 1 tool call, 1 failed", active: true, failed: 1 });
  });

  it("does not mutate groups or the timing and error fields used to render details", () => {
    const entries = group(Object.freeze(thought(1000, 4000)), Object.freeze(tool("Read", "error", { output: "Failure reason" })));
    const original = structuredClone(entries);
    summarizeActivity(entries, 9000);
    expect(entries).toEqual(original);
  });
});
