import { afterEach, describe, expect, it, vi } from "vitest";
import { getCapabilities, Markdown, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { FeedView, THOUGHT_LINK_PREFIX } from "../src/ui/feed-view.js";
import { EventFeed, plainText, type FeedEntry } from "../src/ui/model.js";

const originalCapabilities = getCapabilities();
afterEach(() => { setCapabilities(originalCapabilities); vi.restoreAllMocks(); });

function setup(entries: FeedEntry[] = [], now?: () => number) {
  const feed = new EventFeed();
  feed.entries.push(...entries);
  const view = new FeedView(feed, now);
  const screen = (width = 90): string => view.render(width).map(plainText).join("\n");
  return { feed, view, screen };
}

describe("compact Claude-like feed presentation", () => {
  it("shows user prompts and Markdown replies without separate role headings", () => {
    const { screen } = setup([
      { kind: "message", label: "You", text: "请读取 **原始标记**" },
      { kind: "message", label: "Assistant", text: "# 检查结果\n\n已读取 **README**，使用 `read`。\n\n- 第一项\n- 第二项" },
      { kind: "message", label: "You → Task", text: "验证 localhost 授权边界" },
      { kind: "message", label: "Decide", text: "下一步：对比账户。" },
      { kind: "message", label: "Execute", text: "**证据**已保存。" },
    ]);
    const output = screen();
    expect(output).toContain("❯ 请读取 **原始标记**");
    expect(output).toContain("检查结果");
    expect(output).toContain("❯ 验证 localhost 授权边界");
    expect(output).toContain("下一步：对比账户。");
    expect(output).toContain("证据已保存。");
    expect(output).not.toContain("●");
    expect(output).not.toContain("# 检查结果");
    expect(output).not.toContain("**README**");
    expect(output).not.toContain("`read`");
    expect(output).not.toMatch(/Assistant|Decide|Execute|You → Task/);
  });

  it("renders tools as consecutive compact rows and separates role handoff groups", () => {
    const { screen } = setup([
      { kind: "activity", label: "Decide", text: "规划", details: "LONG_PRIVATE_REASON" },
      { kind: "tool", label: "Read", text: "README.md", state: "running", output: "ENTIRE_DOCUMENT_BODY" },
      { kind: "tool", label: "PowerShell", text: "Get-ChildItem\n-Recurse", state: "done", output: "ALL_FILE_NAMES" },
      { kind: "activity", label: "Execute", text: "验证" },
    ]);
    const rows = screen().split("\n");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("● Decide · 规划");
    expect(rows[1]).toContain("● Read README.md");
    expect(rows[2]).toContain("✓ PowerShell Get-ChildItem -Recurse");
    expect(rows[3]).toBe("");
    expect(rows[4]).toContain("● Execute · 验证");
    expect(rows.join("\n")).not.toMatch(/LONG_PRIVATE_REASON|ENTIRE_DOCUMENT_BODY|ALL_FILE_NAMES/);
  });

  it("keeps a bounded error summary visible while tool details are folded", () => {
    const { screen } = setup([
      { kind: "tool", label: "Read", text: "missing.txt", state: "error", output: "ENOENT: file is missing\n" + "long detail ".repeat(200) },
    ]);
    const rows = screen().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("✕ Read missing.txt");
    expect(rows[1]).toContain("ENOENT: file is missing");
    expect(rows[1]!.length).toBeLessThanOrEqual(90);
    expect(rows.join("\n")).not.toContain("long detail ".repeat(10));
  });

  it("honors error=true even when an inconsistent tool state says done", () => {
    const { screen } = setup([{ kind: "tool", label: "PowerShell", text: "command", state: "done", error: true, output: "Command failed" }]);
    expect(screen()).toContain("✕ PowerShell command");
    expect(screen()).toContain("Command failed");
    expect(screen()).not.toContain("✓");
  });

  it("renders notices in compact rows without a repetitive xloom heading", () => {
    const { screen } = setup([
      { kind: "notice", label: "xloom", text: "API Key 已保存。" },
      { kind: "notice", label: "Loop", text: "配置读取失败\n请重试", error: true },
    ]);
    expect(screen().split("\n")).toHaveLength(2);
    expect(screen()).toContain("API Key 已保存。");
    expect(screen()).toContain("配置读取失败 请重试");
    expect(screen()).not.toMatch(/xloom|Loop/);
  });

  it("reveals complete folded notice/error text in details mode without repeating short notices", () => {
    const { view, screen } = setup([
      { kind: "notice", label: "xloom", text: "short notice" },
      { kind: "notice", label: "xloom", error: true, text: "Connection failed: " + "context ".repeat(40) + "\nIMPORTANT_RECOVERY_STEPS" },
    ]);
    expect(screen()).not.toContain("IMPORTANT_RECOVERY_STEPS");
    view.toggleDetails();
    expect(screen()).toContain("IMPORTANT_RECOVERY_STEPS");
    expect(screen().match(/short notice/g)).toHaveLength(1);
  });

  it("hides raw protocol until details are requested and renders it as plain text", () => {
    const { view, screen } = setup([{ kind: "protocol", label: "Decide", text: '# RAW_PROTOCOL\n{"summary":"**not markdown**"}', details: "reason" }]);
    expect(view.detailsVisible).toBe(false);
    expect(screen().trim()).toBe("");
    expect(view.toggleDetails()).toBe(true);
    expect(screen()).toContain("# RAW_PROTOCOL");
    expect(screen()).toContain('{"summary":"**not markdown**"}');
    expect(screen()).toContain("reason");
    expect(view.toggleDetails()).toBe(false);
    expect(screen().trim()).toBe("");
  });

  it("shows diagnostic notices only in plain-text details", () => {
    const { view, screen } = setup([{ kind: "diagnostic", label: "xloom", text: "**Unknown model pricing**" }]);
    expect(screen().trim()).toBe("");
    view.toggleDetails();
    expect(screen()).toContain("**Unknown model pricing**");
  });

  it("expands reasons and tool output without modifying the underlying feed", () => {
    const entries: FeedEntry[] = [
      { kind: "activity", label: "Decide", text: "复核", details: "reason: inspect evidence" },
      { kind: "tool", label: "Read", text: "README.md", state: "done", details: "arguments: path", output: "# raw output" },
    ];
    const original = structuredClone(entries);
    const { view, screen } = setup(entries);
    view.toggleDetails();
    expect(screen()).toContain("reason: inspect evidence");
    expect(screen()).toContain("arguments: path");
    expect(screen()).toContain("# raw output");
    expect(entries).toEqual(original);
  });

  it("bounds expanded protocol/detail text even if a caller bypassed feed limits", () => {
    const { view, screen } = setup([{ kind: "protocol", label: "Execute", text: "long detail\n".repeat(10000) }]);
    view.toggleDetails();
    const output = screen();
    expect(output.split("\n").length).toBeLessThanOrEqual(41);
    expect(output).toContain("详情已截断");
    expect(output.length).toBeLessThan(6500);
  });

  it("updates cached Markdown after streamed text changes and can invalidate it", () => {
    const entry: FeedEntry = { kind: "message", label: "Assistant", text: "**first**" };
    const { view, screen } = setup([entry]);
    expect(screen()).toContain("first");
    entry.text = "**second**";
    expect(screen()).toContain("second");
    expect(screen()).not.toContain("first");
    view.invalidate();
    expect(screen()).toContain("second");
  });

  it("uses Pi Markdown for tables and fenced code on normal-width terminals", () => {
    const render = vi.spyOn(Markdown.prototype, "render");
    const { screen } = setup([{ kind: "message", label: "Assistant", text: "| 名称 | 状态 |\n| --- | --- |\n| 对象 A | 已检查 |\n\n```powershell\nGet-ChildItem\n```" }]);
    const output = screen();
    expect(render).toHaveBeenCalled();
    expect(output).toContain("对象 A");
    expect(output).toContain("已检查");
    expect(output).toContain("Get-ChildItem");
    expect(output).toContain("┌");
    expect(output).not.toContain("| --- | --- |");
  });
});

describe("feed rendering safety and narrow terminals", () => {
  const hostile = "中文 🧪\x1b[2J\x1b]52;c;SECRET\x07\x00\x1b[31mred\x1b[0m";
  it("strips external terminal control sequences from every field in both display modes", () => {
    const entries: FeedEntry[] = ["message", "activity", "tool", "notice", "protocol"].map(kind => ({
      kind: kind as FeedEntry["kind"], label: hostile, text: hostile, details: hostile, output: hostile, state: "error",
    }));
    const { view } = setup(entries);
    for (const visible of [false, true]) {
      view.detailsVisible = visible;
      const rendered = view.render(90).join("\n");
      const withoutSgr = rendered.replace(/\x1b\[[0-9;]*m/g, "");
      expect(withoutSgr).not.toContain("\x1b");
      expect(withoutSgr).not.toContain("\x00");
      expect(withoutSgr).not.toContain("SECRET");
      expect(withoutSgr).toContain("中文");
    }
  });

  it("removes renderer-generated OSC hyperlinks while keeping readable Markdown text", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const { view, screen } = setup([{ kind: "message", label: "Assistant", text: "[模型文档](https://example.test/docs)" }]);
    expect(screen()).toContain("模型文档");
    expect(view.render(90).join("\n")).not.toContain("\x1b]");
  });

  it.each([0, 1, 2, 3, 4, 6, 8, 12, 20, 28, 40, 90])("fits all entry types and CJK content within %i columns", width => {
    const { view } = setup([
      { kind: "message", label: "You", text: "中文任务 🧪\n第二行" },
      { kind: "message", label: "Assistant", text: "| 中文 | 状态 |\n| --- | --- |\n| 对象 | 验证 |\n\n```powershell\n中文命令 🧪\n```" },
      { kind: "activity", label: "Decide", text: "规划中文 🧪", details: "中文原因" },
      { kind: "tool", label: "PowerShell", text: "中文命令".repeat(40), state: "error", output: "中文错误".repeat(100) },
      { kind: "notice", label: "xloom", text: "中文状态" },
      { kind: "protocol", label: "Execute", text: '{"总结":"中文"}' },
    ]);
    view.toggleDetails();
    const lines = view.render(width);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it.each([1, 2, 4, 12, 20])("does not invoke Pi Markdown at unsafe width %i", width => {
    const render = vi.spyOn(Markdown.prototype, "render");
    const { view } = setup([{ kind: "message", label: "Assistant", text: "| 中文 | 中文 |\n| --- | --- |\n| 🧪 | 中文 |\n\n```\n中文\n```" }]);
    view.render(width);
    expect(render).not.toHaveBeenCalled();
  });

  it("avoids one-cell nested Markdown layouts even at normal outer width", () => {
    const render = vi.spyOn(Markdown.prototype, "render");
    const { view } = setup([{ kind: "message", label: "Assistant", text: `${"> ".repeat(45)}中文\n${" ".repeat(100)}- deeply nested 中文` }]);
    for (const line of view.render(90)) expect(visibleWidth(line)).toBeLessThanOrEqual(90);
    expect(render).not.toHaveBeenCalled();
  });

  it.each([28, 40, 52])("avoids narrow CJK table cells after column redistribution at width %i", width => {
    const render = vi.spyOn(Markdown.prototype, "render");
    const { view } = setup([{ kind: "message", label: "Assistant", text: `| ${"long_word_".repeat(8)} | 中 | 文 | 字 |\n| --- | --- | --- | --- |\n| ${"another_word_".repeat(8)} | 甲 | 乙 | 丙 |` }]);
    for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(render).not.toHaveBeenCalled();
  });
});

function thoughtLinks(view: FeedView, width = 90): string[] {
  return [...view.render(width).join("\n").matchAll(/\x1b\]8;;(xloom-thinking:[^\x1b\x07]+)(?:\x1b\\|\x07)/g)].map(match => match[1]!);
}

describe("real provider thinking blocks and response duration", () => {
  it("folds real thinking by default and preserves a clickable header after expanding", () => {
    const entry: FeedEntry = { kind: "thinking", label: "Assistant", text: "**真实 provider 思考**\n不是 Markdown", startedAt: 1000, endedAt: 7200, details: "DO_NOT_RENDER_UNRELATED_PROTOCOL" };
    const { view, screen } = setup([entry], () => 100000);
    expect(screen()).toContain("▸ Thought for 6s");
    expect(screen()).not.toContain("真实 provider 思考");
    const [link] = thoughtLinks(view);
    expect(link).toMatch(/^xloom-thinking:\d+$/);
    expect(view.toggleThinkingLink(link!)).toBe(true);
    expect(screen()).toContain("▾ Thought for 6s");
    expect(screen()).toContain("∴ **真实 provider 思考**");
    expect(screen()).toContain("不是 Markdown");
    expect(screen()).not.toContain("DO_NOT_RENDER_UNRELATED_PROTOCOL");
    expect(thoughtLinks(view)).toEqual([link]);
    expect(view.toggleThinkingLink(link!)).toBe(true);
    expect(screen()).not.toContain("真实 provider 思考");
  });

  it("updates active thinking seconds and freezes elapsed time after it finishes", () => {
    let current = 7600;
    const entry: FeedEntry = { kind: "thinking", label: "Decide", text: "provider text", startedAt: 1000 };
    const { screen } = setup([entry], () => current);
    expect(screen()).toContain("Thinking… 6s");
    current = 10000;
    expect(screen()).toContain("Thinking… 9s");
    entry.endedAt = 7600;
    current = 50000;
    expect(screen()).toContain("Thought for 6s");
    expect(screen()).not.toContain("49s");
  });

  it("omits invented elapsed time for replayed thinking whose duration is unknown", () => {
    const entry: FeedEntry = { kind: "thinking", label: "Assistant", text: "replayed provider text", startedAt: 1000, endedAt: 1000, durationKnown: false };
    const { view, screen } = setup([entry], () => 7600);
    expect(screen().trim()).toBe("▸ Thought");
    expect(screen()).not.toMatch(/for|\ds/);
    view.toggleLatestThinking();
    expect(screen()).toContain("▾ Thought");
    expect(screen()).toContain("∴ replayed provider text");
    delete entry.endedAt;
    expect(screen()).toContain("▾ Thinking…");
    expect(screen()).not.toContain("6s");
    entry.durationKnown = true;
    expect(screen()).toContain("▾ Thinking… 6s");
  });

  it("uses a compact terminal work marker with total seconds and local end time", () => {
    const ended = new Date("2026-09-12T17:21:00").getTime();
    const entry: FeedEntry = { kind: "work", label: "Assistant", text: "", startedAt: ended - 6200, endedAt: ended, workStatus: "done" };
    const { screen } = setup([entry], () => ended + 100000);
    expect(screen()).toContain("✻ Worked for 6s · done 17:21");
  });

  it("keeps working markers live without claiming that an unfinished response is done", () => {
    let current = 7600;
    const { screen } = setup([{ kind: "work", label: "Assistant", text: "", startedAt: 1000, workStatus: "running" }], () => current);
    expect(screen()).toContain("✻ Working… 6s");
    current = 10000;
    expect(screen()).toContain("✻ Working… 9s");
    expect(screen()).not.toContain("done");
  });

  it.each(["paused", "stopped", "error"] as const)("does not relabel a %s response as done", workStatus => {
    const { screen } = setup([{ kind: "work", label: "Assistant", text: "", startedAt: 1000, endedAt: 7600, workStatus }]);
    expect(screen()).toContain(`Worked for 6s · ${workStatus}`);
    expect(screen()).not.toContain("done");
  });

  it("does not infer done from endedAt alone or override an explicit error", () => {
    const { screen } = setup([
      { kind: "work", label: "Assistant", text: "", startedAt: 1000, endedAt: 7600 },
      { kind: "work", label: "Assistant", text: "", startedAt: 1000, endedAt: 7600, workStatus: "done", error: true },
    ]);
    expect(screen()).toContain("· stopped");
    expect(screen()).toContain("· error");
    expect(screen()).not.toContain("done");
  });

  it("handles missing, invalid or future timestamps without NaN or negative durations", () => {
    const { screen } = setup([
      { kind: "thinking", label: "Assistant", text: "", startedAt: 9000, endedAt: 1000 },
      { kind: "thinking", label: "Assistant", text: "", startedAt: Number.NaN, endedAt: Infinity },
      { kind: "work", label: "Assistant", text: "", startedAt: undefined, workStatus: "running" },
    ], () => Number.NaN);
    expect(screen()).toContain("Thought for 0s");
    expect(screen()).toContain("Thinking… 0s");
    expect(screen()).toContain("Working… 0s");
    expect(screen()).not.toMatch(/NaN|Infinity|-\ds/);
  });

  it("does not fabricate a thought block or work marker for an ordinary answer", () => {
    const { screen, view } = setup([{ kind: "message", label: "Assistant", text: "Answer only." }]);
    expect(screen()).toContain("Answer only.");
    expect(screen()).not.toMatch(/Thinking|Thought|Worked|Working|●/);
    expect(view.toggleLatestThinking()).toBe(false);
    expect(thoughtLinks(view)).toEqual([]);
  });

  it("keeps multiple thought blocks independently expandable through known links", () => {
    const entries: FeedEntry[] = [
      { kind: "thinking", label: "Decide", text: "FIRST_PROVIDER_TEXT", startedAt: 0, endedAt: 6000 },
      { kind: "message", label: "Decide", text: "Summary." },
      { kind: "thinking", label: "Execute", text: "SECOND_PROVIDER_TEXT", startedAt: 6000, endedAt: 9000 },
    ];
    const { view, screen } = setup(entries);
    const links = thoughtLinks(view);
    expect(links).toHaveLength(2);
    expect(new Set(links).size).toBe(2);
    expect(view.toggleThinkingLink(links[0]!)).toBe(true);
    expect(screen()).toContain("FIRST_PROVIDER_TEXT");
    expect(screen()).not.toContain("SECOND_PROVIDER_TEXT");
    expect(view.toggleThinkingLink(links[1]!)).toBe(true);
    expect(screen()).toContain("SECOND_PROVIDER_TEXT");
    expect(view.toggleThinkingLink(links[0]!)).toBe(true);
    expect(screen()).not.toContain("FIRST_PROVIDER_TEXT");
    expect(screen()).toContain("SECOND_PROVIDER_TEXT");
  });

  it("supports keyboard toggling of only the latest thought and global detail resets", () => {
    const { view, screen } = setup([
      { kind: "thinking", label: "Assistant", text: "FIRST_THINKING", startedAt: 0, endedAt: 6000 },
      { kind: "thinking", label: "Assistant", text: "LATEST_THINKING", startedAt: 6000, endedAt: 9000 },
    ]);
    expect(view.toggleLatestThinking()).toBe(true);
    expect(screen()).not.toContain("FIRST_THINKING");
    expect(screen()).toContain("LATEST_THINKING");
    expect(view.toggleDetails()).toBe(true);
    expect(screen()).toContain("FIRST_THINKING");
    expect(screen()).toContain("LATEST_THINKING");
    expect(view.toggleLatestThinking()).toBe(true);
    expect(screen()).toContain("FIRST_THINKING");
    expect(screen()).not.toContain("LATEST_THINKING");
    expect(view.toggleDetails()).toBe(false);
    expect(screen()).not.toMatch(/FIRST_THINKING|LATEST_THINKING/);
  });

  it("accepts only exact renderer-owned, currently mounted thought URLs", () => {
    const entry: FeedEntry = { kind: "thinking", label: "Assistant", key: "HOSTILE_MODEL_ID", text: "TEXT", startedAt: 0 };
    const { feed, view } = setup([entry]);
    expect(view.toggleThinkingLink(`${THOUGHT_LINK_PREFIX}1`)).toBe(false);
    const [link] = thoughtLinks(view);
    for (const unknown of ["https://example.test", `${link}/`, `${link}?x=1`, ` ${link}`, `${link}\n`, `${THOUGHT_LINK_PREFIX}HOSTILE_MODEL_ID`, `${THOUGHT_LINK_PREFIX}9999`]) expect(view.toggleThinkingLink(unknown)).toBe(false);
    expect(view.toggleThinkingLink(link!)).toBe(true);
    feed.entries.splice(0);
    expect(view.toggleThinkingLink(link!)).toBe(false);
    feed.entries.push(entry);
    view.render(0);
    expect(view.toggleThinkingLink(link!)).toBe(false);
  });

  it("bounds expanded thought text as plain text without carrying external OSC commands", () => {
    const entry: FeedEntry = { kind: "thinking", label: "Assistant", text: "**literal thought**\n" + "🧪 中文\x1b]52;c;SECRET\x07\n".repeat(10000), startedAt: 0, endedAt: 6000, expanded: true };
    const { view, screen } = setup([entry]);
    expect(screen().split("\n").length).toBeLessThanOrEqual(42);
    expect(screen()).toContain("∴ **literal thought**");
    expect(screen()).toContain("详情已截断");
    const rendered = view.render(90).join("\n");
    expect(rendered).not.toContain("SECRET");
    const clean = rendered.replace(/\x1b\]8;;(?:xloom-thinking:\d+)?\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(clean).not.toContain("\x1b");
  });

  it.each([0, 1, 2, 3, 4, 8, 20, 90])("keeps thinking links, CJK body and work timers safe at %i columns", width => {
    const { view } = setup([
      { kind: "thinking", label: "Assistant", text: "🧪 中文思考\n| 表格 | 纯文本 |", startedAt: 0, endedAt: 6000, expanded: true },
      { kind: "work", label: "Assistant", text: "", startedAt: 0, endedAt: 6000, workStatus: "done" },
    ]);
    for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
