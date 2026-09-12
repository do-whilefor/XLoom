import { describe, expect, it, vi } from "vitest";
import { Editor, TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { BoardSnapshot, LoopEvent } from "../src/types.js";
import { ResponsiveEditor, runTui } from "../src/ui/index.js";
import { dispatchCommand, EventFeed, fitLines, formatBoard, plainText, statusLine, type UiController } from "../src/ui/model.js";

function snapshot(): BoardSnapshot {
  return {
    revision: 2, status: "idle", outcome: null, reason: "", completedSteps: 1, noProgressCount: 0,
    lastMetaStep: 0, lastMetaRevision: 0, usage: { input: 100, output: 80, cost: 0.02 },
    config: { version: 1, title: "测试项目", goal: "检查授权对象的安全边界", scope: "localhost", context: "",
      models: { decide: { provider: "test", model: "test" }, execute: { provider: "test", model: "test" } },
      limits: { maxSteps: 10, maxNoProgress: 3, maxMinutes: 10, maxTokens: 10000, maxCost: 1, maxTurnsPerRun: 5, stepTimeoutSeconds: 60, metacogEvery: 3 } },
    goals: [{ id: "g1", description: "验证对象归属", parentId: null, status: "active", factIds: [] }],
    facts: [{ id: "f1", description: "已保存响应", stepId: "s1", evidenceIds: ["e1"] }],
    steps: [{ id: "s1", goalId: "g1", from: [], description: "账户对比", successSignal: "实际响应差异", evidencePlan: "保存响应", priority: 1, status: "done", attempts: 1, runId: "r1", leaseUntil: null }],
    findings: [{ id: "v1", key: "key", target: "localhost", title: "待复核线索", status: "technical_hit", rating: "unrated", evidenceIds: ["e1"], factIds: ["f1"], next: "验证影响" }],
    evidence: [{ id: "e1", path: ".xloom/runs/r1/response.txt", sha256: "a".repeat(64), bytes: 22, description: "响应", runId: "r1", stepId: "s1" }],
    hints: [],
  };
}

function fakeController() {
  const board = snapshot();
  const listeners = new Set<(event: LoopEvent) => void>();
  const controller = {
    snapshot: vi.fn(() => board),
    subscribe: vi.fn((listener: (event: LoopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    start: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), hint: vi.fn(), requestMetacog: vi.fn(),
  } satisfies UiController;
  return { board, controller, listeners };
}

class MemoryTerminal implements Terminal {
  output = "";
  stopped = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  kittyProtocolActive = false;
  constructor(public columns = 40, public rows = 18) {}
  start(onInput: (data: string) => void, onResize: () => void): void { this.input = onInput; this.resize = onResize; }
  stop(): void { this.stopped = true; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  submit(text: string): void { for (const char of text) this.input(char); this.input("\r"); }
}

describe("TUI formatting", () => {
  it.each([0, 1, 2, 4, 12, 30, 80])("fits Chinese, emoji and long tokens into %i columns", (width) => {
    const lines = fitLines("双 Agent 元认知 🧪 · token_abcdefghijklmnopqrstuvwxyz\n第二行", width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("strips terminal control sequences from external content", () => {
    const text = plainText("ok\x1b[2J\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[31mred\x1b[0m\x00\r\n中文");
    expect(text).toBe("okred\n中文");
    expect(text).not.toContain("\x1b");
  });

  it("shows concise FGS, findings and evidence references without inventing ratings", () => {
    const board = snapshot();
    const text = formatBoard(board);
    expect(text).toContain("Goals (1)");
    expect(text).toContain("Facts (1)");
    expect(text).toContain("Steps (1)");
    expect(text).toContain("technical_hit/unrated");
    expect(text).toContain("e1 .xloom/runs/r1/response.txt");
    expect(text).toContain("next: 验证影响");
    expect(statusLine(board)).toContain("180 tokens");
  });

  it("bounds streamed output and updates one collapsed entry per tool call", () => {
    const feed = new EventFeed(3, 40);
    feed.runtime({ type: "text", mode: "decide", text: "a".repeat(20) });
    feed.runtime({ type: "text", mode: "decide", text: "b".repeat(40) });
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.text.length).toBeLessThanOrEqual(41);
    feed.runtime({ type: "tool_start", mode: "execute", text: "test", toolName: "powershell", toolCallId: "t1" });
    feed.runtime({ type: "tool_update", mode: "execute", text: "x".repeat(10000), toolName: "powershell", toolCallId: "t1" });
    feed.runtime({ type: "tool_end", mode: "execute", text: "saved evidence", toolName: "powershell", toolCallId: "t1" });
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[1]!.text).toBe("[done] saved evidence");
    feed.add("note", "first");
    feed.add("note", "last");
    expect(feed.entries).toHaveLength(3);
    expect(feed.entries[0]!.label).toContain("powershell");
  });

  it("labels metacognition as Decide, not a third agent", () => {
    const feed = new EventFeed();
    feed.runtime({ type: "text", mode: "metacog", text: "复核证据" });
    expect(feed.entries[0]!.label).toBe("Decide · Meta");
  });

  it("keeps editor CJK and IME focus safe on narrow terminals", () => {
    const terminal = new MemoryTerminal();
    const tui = new TuiAltScreen(terminal);
    const identity = (text: string) => text;
    const editor = new Editor(tui, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } }, { paddingX: 1 });
    const responsive = new ResponsiveEditor(editor);
    responsive.focused = true;
    editor.setText("测试中文 🧪\n多行输入");
    expect(editor.focused).toBe(true);
    for (const width of [0, 1, 2, 3, 4, 12, 80]) {
      for (const line of responsive.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

describe("TUI command routing", () => {
  it("sends plain input and /hint to blackboard, never to an agent session", () => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn() };
    dispatchCommand("账户 A 属于组织甲", controller, actions);
    dispatchCommand("/hint  账户 B\n属于组织乙", controller, actions);
    expect(controller.hint.mock.calls).toEqual([["账户 A 属于组织甲"], ["账户 B\n属于组织乙"]]);
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("routes all lifecycle and inspection commands", () => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn() };
    for (const command of ["/start", "/pause", "/stop", "/meta", "/board", "/help", "/quit", "/exit"]) dispatchCommand(command, controller, actions);
    expect(actions.start).toHaveBeenCalledOnce();
    expect(controller.pause).toHaveBeenCalledOnce();
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(controller.requestMetacog).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledTimes(2);
    expect(actions.print.mock.calls.some(([label]) => label === "Blackboard")).toBe(true);
  });

  it("does not silently treat unknown commands as agent instructions", () => {
    const { controller } = fakeController();
    const actions = { start: vi.fn(), quit: vi.fn(), print: vi.fn() };
    for (const command of ["/unknown", "/hint", "/stop now", "/exit now", "  "]) dispatchCommand(command, controller, actions);
    expect(controller.hint).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    expect(actions.quit).not.toHaveBeenCalled();
    expect(actions.print).toHaveBeenCalledTimes(4);
  });
});

describe("TUI lifecycle", () => {
  it("waits for a controller-started idle /meta run before restoring the terminal", async () => {
    const { controller, listeners, board } = fakeController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const waitForIdle = vi.fn(() => pending);
    controller.requestMetacog.mockImplementation(() => {
      board.status = "running";
      for (const listener of listeners) listener({ type: "state", snapshot: board });
    });
    const terminal = new MemoryTerminal();
    const session = runTui(Object.assign(controller, { waitForIdle }), terminal);
    terminal.submit("/meta");
    expect(controller.requestMetacog).toHaveBeenCalledOnce();
    expect(controller.start).not.toHaveBeenCalled();
    terminal.input("\x03");
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    terminal.input("\x03");
    expect(controller.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledOnce());
    expect(terminal.stopped).toBe(false);
    release();
    await session;
    expect(terminal.stopped).toBe(true);
  });

  it("coalesces duplicate starts and does not execute a queued start after quit", async () => {
    const { controller } = fakeController();
    const terminal = new MemoryTerminal();
    const session = runTui(controller, terminal);
    terminal.submit("/start");
    terminal.submit("/start");
    terminal.submit("/quit");
    await session;
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(terminal.stopped).toBe(true);
  });

  it("remains responsive while the loop runs and awaits cancellation before restoring terminal", async () => {
    const { controller, listeners } = fakeController();
    let release!: () => void;
    controller.start.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const terminal = new MemoryTerminal(24, 14);
    const session = runTui(controller, terminal);
    terminal.submit("/start");
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledOnce());
    terminal.submit("补充身份对比");
    expect(controller.hint).toHaveBeenCalledWith("补充身份对比");
    terminal.input("\x03");
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    terminal.input("\x03");
    expect(controller.stop).toHaveBeenCalledOnce();
    expect(terminal.stopped).toBe(false);
    release();
    await session;
    expect(terminal.stopped).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it("renders runtime updates and exits cleanly from idle", async () => {
    const { controller, listeners, board } = fakeController();
    const terminal = new MemoryTerminal(12, 12);
    const session = runTui(controller, terminal);
    for (const listener of listeners) {
      listener({ type: "runtime", runtime: { type: "text", mode: "execute", text: "检查中文边界 🧪" } });
      listener({ type: "state", snapshot: { ...board, status: "paused", reason: "用户暂停" } });
    }
    terminal.input("\x1b");
    expect(controller.pause).toHaveBeenCalledOnce();
    terminal.submit("/board");
    terminal.submit("/quit");
    await session;
    expect(terminal.stopped).toBe(true);
    expect(plainText(terminal.output)).toContain("xloom");
    expect(listeners.size).toBe(0);
  });
});
