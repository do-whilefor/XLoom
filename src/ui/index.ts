import chalk from "chalk";
import { Editor, matchesKey, ProcessTerminal, ScrollView, truncateToWidth, TuiAltScreen, VStack,
  type Component, type Focusable, type Terminal } from "@earendil-works/pi-tui";
import { compact, dispatchCommand, EventFeed, fitLines, plainText, statusLine, type UiController } from "./model.js";

export type { UiController } from "./model.js";

const coral = chalk.hex("#D98B73");
const muted = chalk.gray;

class FeedView implements Component {
  constructor(private readonly feed: EventFeed) {}
  invalidate(): void {}
  render(width: number): string[] {
    const padding = width >= 6 ? "  " : "";
    const available = Math.max(1, width - padding.length);
    return this.feed.entries.flatMap((entry) => [
      "",
      truncateToWidth(padding + (entry.error ? chalk.red : coral)(plainText(entry.label)), width, ""),
      ...fitLines(entry.text, available).map((line) => padding + line),
    ]);
  }
}

class StatusView implements Component {
  constructor(private readonly content: () => string, private readonly color = muted) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.color(truncateToWidth(plainText(this.content()), Math.max(0, width), width > 3 ? "…" : ""))];
  }
}

/** Avoid a one-cell CJK layout in the upstream editor; propagate IME focus. */
export class ResponsiveEditor implements Component, Focusable {
  constructor(readonly editor: Editor) {}
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  invalidate(): void { this.editor.invalidate(); }
  handleInput(data: string): void { this.editor.handleInput(data); }
  render(width: number): string[] {
    if (width < 4) return [truncateToWidth(">", Math.max(0, width), "")];
    return this.editor.render(width).map((line) => truncateToWidth(line, width, ""));
  }
}

/** Terminal injection is for local tests; production uses Pi's ProcessTerminal. */
export async function runTui(controller: UiController, terminal: Terminal): Promise<void> {
  const tui = new TuiAltScreen(terminal, true, undefined, { copyOnSelect: false });
  const feed = new EventFeed();
  let snapshot = controller.snapshot();
  let active: Promise<void> | undefined;
  let closing = false;
  let interrupted = false;
  let resolveExit!: () => void;
  const exitRequested = new Promise<void>((resolve) => { resolveExit = resolve; });
  const print = (label: string, text: string, error = false): void => {
    feed.breakStream();
    feed.add(label, text, error);
    tui.requestRender();
  };
  const quit = (): void => {
    if (closing) return;
    closing = true;
    try { controller.stop(); }
    catch (error) { print("xloom", error instanceof Error ? error.message : String(error), true); }
    finally { resolveExit(); }
  };
  const start = (): void => {
    if (active || closing) return;
    interrupted = false;
    print("xloom", "Loop 启动。Esc 暂停；/hint 可随时补充黑板。");
    active = Promise.resolve().then(() => closing ? undefined : controller.start()).catch((error: unknown) => {
      print("xloom", error instanceof Error ? error.message : String(error), true);
    }).finally(() => {
      active = undefined;
      snapshot = controller.snapshot();
      tui.requestRender();
    });
  };

  const editor = new Editor(tui, {
    borderColor: coral,
    selectList: { selectedPrefix: coral, selectedText: coral, description: muted, scrollInfo: muted, noMatch: muted },
  }, { paddingX: 1 });
  const input = new ResponsiveEditor(editor);
  editor.onSubmit = (text) => {
    if (closing) return;
    try {
      dispatchCommand(text, controller, { start, quit, print });
      editor.setText("");
    } catch (error) {
      print("xloom", error instanceof Error ? error.message : String(error), true);
    }
    tui.requestRender();
  };
  const scroll = new ScrollView(new FeedView(feed), { follow: "end", primary: true, scrollbar: "auto", scrollbarStyle: muted });
  tui.setLayoutRoot(new VStack([
    { component: new StatusView(() => ` xloom  ·  ${compact(snapshot.config.title, 100)}`, coral), basis: 1, shrink: 0 },
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: input, basis: "auto", shrink: 1, minSize: 1 },
    { component: new StatusView(() => ` ${statusLine(snapshot)}`), basis: 1, shrink: 0 },
    { component: new StatusView(() => " /help · /start · /board    Enter 提交 · Alt+Enter 换行 · Esc 暂停"), basis: 1, shrink: 0, visible: ({ height }) => height >= 10 },
  ]));
  tui.setFocus(input);

  const unsubscribe = controller.subscribe((event) => {
    if (event.snapshot) snapshot = event.snapshot;
    if (event.type === "runtime" && event.runtime) feed.runtime(event.runtime);
    else if (event.type === "notice" && event.message) print("xloom", event.message);
    else if (event.type === "board") feed.breakStream();
    else if (event.type === "state") {
      print("Loop", `${snapshot.status}${snapshot.reason ? ` · ${snapshot.reason}` : ""}`);
    }
    tui.requestRender();
  });
  const removeInput = tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if ((active || snapshot.status === "running") && !interrupted) {
        interrupted = true;
        controller.pause();
        print("xloom", "已中断当前运行，等待取消完成。再次 Ctrl+C 退出。");
      } else quit();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      controller.pause();
      return { consume: true };
    }
    return undefined;
  });
  const signalHandler = (): void => { quit(); };
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);
  feed.add("xloom", `${snapshot.config.goal}\n\n双 Agent · 黑板协作 · read / write / edit / powershell\n输入 /start 开始，/help 查看快捷操作。`);
  if (snapshot.reason) feed.add("恢复状态", snapshot.reason);
  try {
    tui.start();
    await exitRequested;
    // Keep the terminal alive until cancellation has finished, then restore it.
    if (active) await active;
    await controller.waitForIdle?.();
  } finally {
    closing = true;
    unsubscribe();
    removeInput();
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
    try { await terminal.drainInput(300, 30); }
    finally { tui.stop(); }
  }
}

export async function startTui(controller: UiController): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI 需要交互终端。请在 Windows Terminal 中运行，或使用 --headless。");
  }
  await runTui(controller, new ProcessTerminal());
}
