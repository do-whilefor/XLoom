import { afterEach, describe, expect, it, vi } from "vitest";
import { getCapabilities, getOsc8LinkAtColumn, Markdown, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
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
  it.each([20, 90])("aligns prompts, replies, notices and thought headings to the left edge at %i columns", width => {
    const { screen } = setup([
      { kind: "message", label: "You", text: "你是什么模型？" },
      { kind: "notice", label: "xloom", text: "模型请求暂时失败。" },
      { kind: "thinking", label: "Assistant", text: "fixture thought", startedAt: 0, endedAt: 1000 },
      { kind: "message", label: "Assistant", text: "我是测试模型。\n\n第二行。" },
    ]);
    const rows = screen(width).split("\n").map(row => row.trimEnd());
    for (const row of ["❯ 你是什么模型？", "模型请求暂时失败。", "▸ Thought for 1s", "我是测试模型。", "第二行。"]) {
      expect(rows).toContain(row);
    }
  });

  it("uses the full reply width while preserving indentation from the message itself", () => {
    const { screen } = setup([
      { kind: "message", label: "Assistant", text: "abcdefghij".repeat(4) },
      { kind: "message", label: "Assistant", text: "  if (ready) {\n    work();\n  }" },
    ]);
    expect(screen(20).split("\n")).toEqual([
      "abcdefghijabcdefghij", "abcdefghijabcdefghij", "", "  if (ready) {", "    work();", "  }",
    ]);
  });

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

  it("renders a complete terminal report as Markdown, including its conclusion beyond preview limits", () => {
    const { feed, view, screen } = setup();
    const summary = `**任务未完成**\n\n已确认第一项结果。\n\n${"- 已保存结果及其证据引用，下一步仍须核验剩余目标。\n".repeat(500)}\n**第二项尚未完成**，使用 /start 继续。`;
    feed.beginWork();
    feed.runtime({ type: "usage", mode: "execute", text: "", usage: { input: 40, output: 12, cost: 0.1 } });
    feed.result("execute", summary, undefined, true);
    feed.finishWork("paused");
    expect(summary.length).toBeGreaterThan(9000);
    const output = screen();
    expect(output).toContain("任务未完成");
    expect(output).toContain("已确认第一项结果");
    expect(output).toContain("第二项尚未完成，使用 /start 继续。");
    expect(output).toContain("paused");
    expect(output).toContain("52 tokens");
    expect(output).not.toMatch(/\*\*|详情已截断|\$/);
    expect(output.indexOf("第二项尚未完成")).toBeLessThan(output.indexOf("Worked for"));
    for (const line of view.render(90)) expect(visibleWidth(line)).toBeLessThanOrEqual(90);
  });

  it("summarizes completed tools and keeps only the active tool beneath its role group", () => {
    const { screen } = setup([
      { kind: "activity", label: "Decide", text: "规划", details: "LONG_PRIVATE_REASON" },
      { kind: "tool", label: "Read", text: "README.md", state: "running", output: "ENTIRE_DOCUMENT_BODY" },
      { kind: "tool", label: "PowerShell", text: "Get-ChildItem\n-Recurse", state: "done", output: "ALL_FILE_NAMES" },
      { kind: "activity", label: "Execute", text: "验证" },
    ]);
    const rows = screen().split("\n");
    expect(rows[0]).toContain("● Decide · 规划");
    expect(rows.join("\n")).toContain("● Read README.md");
    expect(rows.join("\n")).toMatch(/ran 1 shell command/i);
    expect(rows.at(-2)).toBe("");
    expect(rows.at(-1)).toContain("● Execute · 验证");
    expect(rows.join("\n")).not.toMatch(/Get-ChildItem|LONG_PRIVATE_REASON|ENTIRE_DOCUMENT_BODY|ALL_FILE_NAMES/);
  });

  it("keeps a bounded error summary visible while tool details are folded", () => {
    const { screen } = setup([
      { kind: "tool", label: "Read", text: "missing.txt", state: "error", output: "ENOENT: file is missing\n" + "long detail ".repeat(200) },
    ]);
    const rows = screen().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("failed");
    expect(rows[1]).toContain("✕ Read:");
    expect(rows[1]).toContain("ENOENT: file is missing");
    expect(rows[1]!.length).toBeLessThanOrEqual(90);
    expect(rows.join("\n")).not.toContain("long detail ".repeat(10));
  });

  it("honors error=true even when an inconsistent tool state says done", () => {
    const { screen } = setup([{ kind: "tool", label: "PowerShell", text: "command", state: "done", error: true, output: "Command failed" }]);
    expect(screen()).toContain("✕ PowerShell:");
    expect(screen()).toContain("failed");
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
      const withoutSgr = rendered.replace(/\x1b\]8;;(?:xloom-thinking:\d+)?\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
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

  it.each([28, 40, 50])("avoids narrow CJK table cells after column redistribution at width %i", width => {
    const render = vi.spyOn(Markdown.prototype, "render");
    const { view } = setup([{ kind: "message", label: "Assistant", text: `| ${"long_word_".repeat(8)} | 中 | 文 | 字 |\n| --- | --- | --- | --- |\n| ${"another_word_".repeat(8)} | 甲 | 乙 | 丙 |` }]);
    for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(render).not.toHaveBeenCalled();
  });

  it("renders a CJK table when the full 52-column width fits its cells", () => {
    const render = vi.spyOn(Markdown.prototype, "render");
    const { view } = setup([{ kind: "message", label: "Assistant", text: `| ${"long_word_".repeat(8)} | 中 | 文 | 字 |\n| --- | --- | --- | --- |\n| ${"another_word_".repeat(8)} | 甲 | 乙 | 丙 |` }]);
    const rows = view.render(52);
    expect(render).toHaveBeenCalledWith(52);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(52);
    for (const cell of ["中", "文", "字", "甲", "乙", "丙"]) expect(rows.map(plainText).join("\n")).toContain(cell);
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
    expect(thoughtLinks(view)).toEqual([link, link, link]);
    expect(view.toggleThinkingLink(link!)).toBe(true);
    expect(screen()).not.toContain("真实 provider 思考");
  });

  it("collapses the owning group from any wrapped thought row without changing neighboring groups", () => {
    const { view, screen } = setup([
      { kind: "thinking", label: "Decide", text: "FIRST_PROVIDER_TEXT " + "wrapped 思考 ".repeat(12), startedAt: 0, endedAt: 6000, expanded: true },
      { kind: "message", label: "Decide", text: "Summary boundary." },
      { kind: "thinking", label: "Execute", text: "SECOND_PROVIDER_TEXT", startedAt: 6000, endedAt: 9000, expanded: true },
    ]);
    const rows = view.render(32);
    const boundary = rows.findIndex(row => plainText(row).includes("Summary boundary."));
    const firstGroup = rows.slice(0, boundary).filter(row => plainText(row).trim());
    const firstUrl = getOsc8LinkAtColumn(firstGroup[0]!, 2)!;
    expect(firstGroup.length).toBeGreaterThan(4);
    for (const row of firstGroup) for (let column = 0; column < visibleWidth(row); column++) {
      expect(getOsc8LinkAtColumn(row, column)).toBe(firstUrl);
    }
    expect(getOsc8LinkAtColumn(rows[boundary]!, 3)).toBeUndefined();
    const bodyUrl = getOsc8LinkAtColumn(firstGroup.at(-1)!, 5)!;
    expect(view.toggleThinkingLink(bodyUrl)).toBe(true);
    expect(screen()).not.toContain("FIRST_PROVIDER_TEXT");
    expect(screen()).toContain("SECOND_PROVIDER_TEXT");
    expect(screen()).toContain("▸ Thought for 6s");
    expect(view.toggleThinkingLink(firstUrl)).toBe(true);
    expect(screen()).toContain("FIRST_PROVIDER_TEXT");
  });

  it.each(["done", "running", "error"] as const)("collapses a %s tool-only group from its command, wrapped input, output and diagnostics", state => {
    const { view, screen } = setup([
      { kind: "tool", label: "PowerShell", text: "COMMAND_SOURCE", state, details: "INPUT_DETAIL " + "parameter ".repeat(16), output: "OUTPUT_BODY\n" + (state === "error" ? "Command failed: exit code 1\n" : "") + "wrapped output ".repeat(16), expanded: true },
      { kind: "diagnostic", label: "Execute", text: "DIAGNOSTIC_DETAIL" },
      { kind: "message", label: "Assistant", text: "Result boundary." },
    ]);
    const rows = view.render(32);
    const bodyRows = rows.slice(1, rows.findIndex(row => plainText(row).includes("Result boundary."))).filter(row => plainText(row).trim());
    const link = getOsc8LinkAtColumn(rows[0]!, 2)!;
    expect(bodyRows.length).toBeGreaterThan(8);
    expect(rows.map(plainText).join("\n")).toContain("DIAGNOSTIC_DETAIL");
    for (const row of bodyRows) {
      const bodyLink = getOsc8LinkAtColumn(row, Math.max(0, visibleWidth(row) - 1));
      expect(bodyLink).toBe(link);
      expect(view.toggleThinkingLink(bodyLink!)).toBe(true);
      expect(screen()).not.toMatch(/INPUT_DETAIL|OUTPUT_BODY|DIAGNOSTIC_DETAIL/);
      expect(view.toggleThinkingLink(link)).toBe(true);
      expect(screen()).toContain("OUTPUT_BODY");
    }
  });

  it("binds hostile expanded content only to its own group, with no remote OSC or forged group targets", () => {
    const hostile = "\x1b]8;;https://example.test\x1b\\REMOTE_LINK\x1b]8;;\x1b\\ "
      + "\x1b]8;;xloom-thinking:9999\x07FORGED_LINK\x1b]8;;\x07 "
      + "\x1b]52;c;SECRET\x07 [remote](https://example.test)";
    const { view, screen } = setup([
      { kind: "thinking", label: "Assistant", text: hostile, startedAt: 0, endedAt: 6000, expanded: true },
      { kind: "tool", label: "Read", text: hostile, state: "error", details: hostile, output: hostile },
    ]);
    const rows = view.render(36);
    const ownLink = getOsc8LinkAtColumn(rows[0]!, 2)!;
    const raw = rows.join("\n");
    const urls = [...raw.matchAll(/\x1b\]8;;([^\x1b\x07]*)(?:\x1b\\|\x07)/g)].map(match => match[1]);
    expect(new Set(urls)).toEqual(new Set([ownLink, ""]));
    expect(raw).not.toContain("SECRET");
    expect(screen()).toContain("REMOTE_LINK");
    expect(screen()).toContain("FORGED_LINK");
    expect(view.toggleThinkingLink("xloom-thinking:9999")).toBe(false);
    expect(view.toggleThinkingLink("https://example.test")).toBe(false);
    const bodyLink = getOsc8LinkAtColumn(rows[1]!, 4)!;
    expect(bodyLink).toBe(ownLink);
    expect(view.toggleThinkingLink(bodyLink)).toBe(true);
    expect(screen()).not.toContain("∴");
  });

  it.each([1, 2, 3, 4, 8, 20])("keeps every visible cell of expanded details clickable at %i columns", width => {
    const { view } = setup([
      { kind: "thinking", label: "Assistant", text: "🧪 中文思考 wrapped content", startedAt: 0, endedAt: 6000, expanded: true },
      { kind: "tool", label: "Read", text: "source.md", state: "error", output: "ENOENT: 文件不存在" },
    ]);
    const rows = view.render(width);
    const ownLink = getOsc8LinkAtColumn(rows[0]!, 0)!;
    expect(ownLink).toMatch(/^xloom-thinking:\d+$/);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      for (let column = 0; column < visibleWidth(row); column++) expect(getOsc8LinkAtColumn(row, column)).toBe(ownLink);
      expect(row.endsWith("\x1b]8;;\x1b\\") || visibleWidth(row) === 0).toBe(true);
    }
    expect(view.toggleThinkingLink(ownLink)).toBe(true);
    expect(plainText(view.render(width)[0]!)).toContain("▸");
  });

  it("updates active thinking seconds and freezes elapsed time after it finishes", () => {
    let current = 7600;
    const entry: FeedEntry = { kind: "thinking", label: "Decide", text: "provider text", startedAt: 1000 };
    const { screen } = setup([entry], () => current);
    expect(screen()).toContain("Thinking for 6s");
    current = 10000;
    expect(screen()).toContain("Thinking for 9s");
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
    expect(screen()).toContain("▾ Thinking for 6s");
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
      { kind: "thinking", label: "Assistant", text: "A real provider thought.", startedAt: 9000, endedAt: 1000 },
      { kind: "message", label: "Assistant", text: "Summary boundary." },
      { kind: "thinking", label: "Assistant", text: "", startedAt: Number.NaN, endedAt: Infinity },
      { kind: "work", label: "Assistant", text: "", startedAt: undefined, workStatus: "running" },
    ], () => Number.NaN);
    expect(screen()).toContain("Thought for 0s");
    expect(screen()).toContain("▸ Thinking…");
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

  it.each(["", "Problem:", "∴ Problem：\n"])("does not expose an interrupted empty thought group or dangling heading: %j", text => {
    const { view, screen } = setup([
      { kind: "thinking", label: "Execute", text, startedAt: 1000, endedAt: 1200 },
      { kind: "message", label: "Execute", text: "任务未完成；已提交的第一项结果保留。", final: true },
    ]);
    expect(screen()).toContain("任务未完成");
    expect(screen()).not.toMatch(/Thought|Problem|∴/);
    expect(view.toggleLatestThinking()).toBe(false);
    expect(thoughtLinks(view)).toEqual([]);
    view.toggleDetails();
    expect(screen()).not.toMatch(/Thought|Problem|∴/);
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
      { kind: "message", label: "Assistant", text: "Summary boundary." },
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
    const truncationRow = view.render(90).find(row => plainText(row).includes("详情已截断"))!;
    expect(view.toggleThinkingLink(getOsc8LinkAtColumn(truncationRow, 5)!)).toBe(true);
    expect(screen()).not.toContain("详情已截断");
    expect(screen()).toContain("▸ Thought for 6s");
  });

  it.each([0, 1, 2, 3, 4, 8, 20, 90])("keeps thinking links, CJK body and work timers safe at %i columns", width => {
    const { view } = setup([
      { kind: "thinking", label: "Assistant", text: "🧪 中文思考\n| 表格 | 纯文本 |", startedAt: 0, endedAt: 6000, expanded: true },
      { kind: "work", label: "Assistant", text: "", startedAt: 0, endedAt: 6000, workStatus: "done" },
    ]);
    for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});

describe("Claude-style collapsed activity groups", () => {
  it("folds thinking and successful read/shell calls into one truthful summary row", () => {
    const { screen } = setup([
      { kind: "thinking", label: "Assistant", text: "PRIVATE_PROVIDER_TEXT", startedAt: 0, endedAt: 6000 },
      { kind: "tool", label: "Read", text: "PRIVATE_SOURCE.md", state: "done", output: "PRIVATE_FILE_BODY" },
      { kind: "tool", label: "PowerShell", text: "PRIVATE_COMMAND_ONE", state: "done" },
      { kind: "tool", label: "PowerShell", text: "PRIVATE_COMMAND_TWO", state: "done" },
      { kind: "message", label: "Assistant", text: "The requested checks are complete." },
    ]);
    const output = screen();
    expect(output).toContain("▸ Thought for 6s, read 1 file, ran 2 shell commands");
    expect(output).toContain("The requested checks are complete.");
    expect(output).not.toMatch(/PRIVATE_PROVIDER_TEXT|PRIVATE_SOURCE|PRIVATE_FILE_BODY|PRIVATE_COMMAND/);
    expect(output).not.toMatch(/✓ Read|✓ PowerShell/);
  });

  it("opens the full activity through the retained internal link instead of revealing only thinking", () => {
    const { view, screen } = setup([
      { kind: "thinking", label: "Assistant", text: "**provider thought**", startedAt: 0, endedAt: 6000 },
      { kind: "tool", label: "Read", text: "source.md", state: "done", details: '{"path":"source.md"}', output: "READ_BODY" },
      { kind: "tool", label: "PowerShell", text: "Get-ChildItem", state: "done", output: "COMMAND_OUTPUT" },
    ]);
    const links = thoughtLinks(view);
    expect(links).toHaveLength(1);
    expect(view.toggleThinkingLink(links[0]!)).toBe(true);
    expect(screen()).toContain("▾ Thought for 6s");
    expect(screen()).toContain("∴ **provider thought**");
    expect(screen()).toContain("✓ Read source.md");
    expect(screen()).toContain('{"path":"source.md"}');
    expect(screen()).toContain("READ_BODY");
    expect(screen()).toContain("Get-ChildItem");
    expect(screen()).toContain("COMMAND_OUTPUT");
    expect(view.toggleThinkingLink(links[0]!)).toBe(true);
    expect(screen()).not.toMatch(/READ_BODY|COMMAND_OUTPUT|Get-ChildItem/);
  });

  it("supports a tool-only activity without fabricating provider thinking", () => {
    const { view, screen } = setup([{ kind: "tool", label: "Read", text: "source.md", state: "done", output: "SOURCE_BODY" }]);
    expect(screen()).toMatch(/read 1 file/i);
    expect(screen()).not.toMatch(/Thought|Thinking|SOURCE_BODY/);
    expect(view.toggleLatestThinking()).toBe(true);
    expect(screen()).toContain("SOURCE_BODY");
    expect(screen()).not.toMatch(/Thought|Thinking/);
  });

  it("shows only the latest live tool command with real elapsed minutes under the summary", () => {
    const { screen } = setup([
      { kind: "thinking", label: "Assistant", text: "HIDDEN_THOUGHT", startedAt: 0, endedAt: 1000 },
      { kind: "tool", label: "Read", text: "EARLIER_ACTIVE_FILE", state: "running", startedAt: 0 },
      { kind: "tool", label: "PowerShell", text: "CURRENT_COMMAND", state: "running", startedAt: 1000 },
      { kind: "tool", label: "Read", text: "DONE_FILE", state: "done", startedAt: 0, endedAt: 1000 },
    ], () => 117000);
    expect(screen()).toContain("● PowerShell · 1m56s CURRENT_COMMAND");
    expect(screen()).not.toMatch(/EARLIER_ACTIVE_FILE|DONE_FILE|HIDDEN_THOUGHT/);
    expect(screen().split("\n").filter(row => row.includes("● "))).toHaveLength(1);
  });

  it("keeps failed counts and concise actual failure reasons visible without treating them as successful reads", () => {
    const { screen } = setup([
      { kind: "tool", label: "Read", text: "good.md", state: "done" },
      { kind: "tool", label: "Read", text: "denied.md", state: "error", output: "读取失败：访问被拒绝" },
    ]);
    expect(screen()).toMatch(/read 1 file/i);
    expect(screen()).toContain("1 failed");
    expect(screen()).toContain("✕ Read: 读取失败：访问被拒绝");
    expect(screen()).not.toContain("read 2 files");
    expect(screen()).not.toContain("✓");
  });

  it("summarizes PowerShell parser errors in Chinese while retaining exact error evidence in details", () => {
    const raw = "ParserError: unexpected token PRIVATE_SCRIPT_FRAGMENT\nCLIXML_PAYLOAD";
    const { view, screen } = setup([{ kind: "tool", label: "PowerShell", text: "PRIVATE_COMMAND_SOURCE", state: "error", output: raw }]);
    expect(screen()).toContain("1 failed");
    expect(screen()).toContain("✕ PowerShell 语法错误（展开查看详情）");
    expect(screen()).not.toMatch(/PRIVATE_SCRIPT_FRAGMENT|CLIXML_PAYLOAD|PRIVATE_COMMAND_SOURCE/);
    view.toggleLatestThinking();
    expect(screen()).toContain("PRIVATE_COMMAND_SOURCE");
    expect(screen()).toContain("ParserError: unexpected token PRIVATE_SCRIPT_FRAGMENT");
    expect(screen()).toContain("CLIXML_PAYLOAD");
  });

  it("does not attribute a non-shell parser failure to PowerShell", () => {
    const { screen } = setup([{ kind: "tool", label: "Read", text: "broken-file", state: "error", output: "ParserError: invalid document" }]);
    expect(screen()).toContain("✕ Read: ParserError: invalid document");
    expect(screen()).not.toContain("PowerShell");
  });

  it("keeps the failed count at the visible start of an overlong activity title", () => {
    const { view } = setup([
      { kind: "thinking", label: "Assistant", text: "thinking", startedAt: 0, endedAt: 6000 },
      ...["Read", "Write", "Edit", "PowerShell"].map(label => ({ kind: "tool" as const, label, text: "hidden input", state: "done" as const })),
      { kind: "tool", label: "PowerShell", text: "failed", state: "error", output: "访问失败" },
    ]);
    expect(plainText(view.render(32)[0]!)).toContain("▸ 1 failed");
  });

  it("preserves natural-language, user and error-notice boundaries instead of swallowing them into a group", () => {
    const { view, screen } = setup([
      { kind: "message", label: "Assistant", text: "I will inspect the files." },
      { kind: "tool", label: "Read", text: "one.md", state: "done" },
      { kind: "notice", label: "xloom", text: "User-visible recovery instruction", error: true },
      { kind: "message", label: "You", text: "Please continue." },
      { kind: "tool", label: "Read", text: "two.md", state: "done" },
      { kind: "message", label: "Assistant", text: "Here is the result." },
    ]);
    expect(thoughtLinks(view)).toHaveLength(2);
    const output = screen();
    expect(output).toContain("I will inspect the files.");
    expect(output).toContain("User-visible recovery instruction");
    expect(output).toContain("❯ Please continue.");
    expect(output).toContain("Here is the result.");
    expect(output.indexOf("I will inspect")).toBeLessThan(output.toLowerCase().indexOf("read 1 file"));
    expect(output.indexOf("User-visible recovery")).toBeLessThan(output.indexOf("❯ Please continue"));
  });

  it("globally opens tool-only groups and protocol while keeping local toggles independent", () => {
    const { view, screen } = setup([
      { kind: "tool", label: "Read", text: "one.md", state: "done", output: "FIRST_TOOL_BODY" },
      { kind: "protocol", label: "Decide", text: "RAW_PROTOCOL" },
      { kind: "message", label: "Assistant", text: "Boundary." },
      { kind: "tool", label: "Read", text: "two.md", state: "done", output: "SECOND_TOOL_BODY" },
    ]);
    view.toggleDetails();
    expect(screen()).toContain("FIRST_TOOL_BODY");
    expect(screen()).toContain("SECOND_TOOL_BODY");
    expect(screen()).toContain("RAW_PROTOCOL");
    view.toggleLatestThinking();
    expect(screen()).toContain("FIRST_TOOL_BODY");
    expect(screen()).not.toContain("SECOND_TOOL_BODY");
    view.toggleDetails();
    expect(screen()).not.toMatch(/FIRST_TOOL_BODY|SECOND_TOOL_BODY|RAW_PROTOCOL/);
  });

  it("keeps total work time and model token count without cost or unimplemented background controls", () => {
    const { screen } = setup([{ kind: "work", label: "xloom", text: "", startedAt: 1000, endedAt: 117000, workStatus: "done", tokens: 12345 }]);
    expect(screen()).toContain("Worked for 1m56s");
    expect(screen()).toContain("12,345 tokens");
    expect(screen()).not.toMatch(/\$|cost|后台|Agent|ctrl\+b/i);
  });
});
