import chalk from "chalk";
import { Editor, getKeybindings, isKeyRelease, isKeyRepeat, KeybindingsManager, matchesKey, ProcessTerminal, ScrollView, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS, truncateToWidth, TuiAltScreen, VStack,
  type Component, type Focusable, type Terminal } from "@earendil-works/pi-tui";
import { compact, dispatchCommand, EventFeed, fitLines, plainText, statusLine, type UiController } from "./model.js";
import { createSystemClipboard, type Clipboard } from "./clipboard.js";

export type { UiController } from "./model.js";

export interface TuiOptions {
  clipboard?: Clipboard;
  onReady?: (controls: { editor: Editor; tui: TuiAltScreen }) => void;
}

/** Clipboard content is text, never terminal input or executable key sequences. */
export function pasteText(text: string): string {
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("粘贴内容超过 1 MiB，请分段粘贴。");
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

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
export async function runTui(controller: UiController, terminal: Terminal, options: TuiOptions = {}): Promise<void> {
  const clipboard = options.clipboard ?? createSystemClipboard();
  const clipboardTasks = new Set<Promise<unknown>>();
  const trackClipboard = <T>(operation: Promise<T>): Promise<T> => {
    clipboardTasks.add(operation);
    void operation.then(() => clipboardTasks.delete(operation), () => clipboardTasks.delete(operation));
    return operation;
  };
  const tui = new TuiAltScreen(terminal, true, undefined, {
    mouse: true, wheelScrollLines: 3, copyOnSelect: true,
    copySelection: (text) => trackClipboard(Promise.resolve().then(() => clipboard.writeText(text)).catch(() => false)),
    onRightClickPaste: () => { requestPaste(); },
  });
  const feed = new EventFeed();
  let snapshot = controller.snapshot();
  let active: Promise<void> | undefined;
  let closing = false;
  let exitArmedAt: number | undefined;
  let draftGeneration = 0;
  let pastePending: Promise<void> | undefined;
  let terminalPaste: string | undefined;
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
    exitArmedAt = undefined;
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
  const previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
    ...previousBindings.getUserBindings(),
    "tui.editor.historyPrevious": ["up", "ctrl+p"],
    "tui.editor.historyNext": ["down", "ctrl+n"],
    "tui.editor.cursorUp": "alt+up",
    "tui.editor.cursorDown": "alt+down",
  }));
  const insertPaste = (text: string): void => {
    const clean = pasteText(text);
    exitArmedAt = undefined;
    if (clean) editor.insertTextAtCursor(clean);
    tui.requestRender();
  };
  function requestPaste(): void {
    if (closing || pastePending || tui.hasOverlay()) return;
    // Prevent an Enter racing a clipboard read from submitting an incomplete draft.
    editor.disableSubmit = true;
    const generation = draftGeneration;
    const pending = trackClipboard(Promise.resolve().then(() => clipboard.readText()).then(text => {
      if (!closing && generation === draftGeneration && !tui.hasOverlay()) insertPaste(text);
    }).catch(() => {
      if (!closing && generation === draftGeneration) print("xloom", "无法读取剪贴板。可尝试支持括号粘贴的终端。", true);
    }).finally(() => { if (pastePending === pending) { editor.disableSubmit = false; pastePending = undefined; } }));
    pastePending = pending;
  }
  const copySelectionOrDraft = (): void => {
    if (tui.hasActiveSelection()) { void trackClipboard(tui.copyActiveSelectionToClipboard()); return; }
    const text = editor.getExpandedText();
    if (!text) return;
    void trackClipboard(Promise.resolve().then(() => clipboard.writeText(text)).catch(() => false).then(ok => {
      if (!closing) tui.flash(ok ? "已复制输入" : "复制失败");
    }));
  };
  const input = new ResponsiveEditor(editor);
  editor.onSubmit = (text) => {
    if (closing) return;
    exitArmedAt = undefined;
    try {
      dispatchCommand(text, controller, { start, quit, print });
      editor.addToHistory(text);
      editor.setText("");
      tui.scrollToBottom();
    } catch (error) {
      editor.setText(text);
      print("xloom", error instanceof Error ? error.message : String(error), true);
    }
    tui.requestRender();
  };
  const scroll = new ScrollView(new FeedView(feed), { follow: "end", primary: true, scrollbar: "auto", scrollbarStyle: muted });
  tui.setLayoutRoot(new VStack([
    { component: new StatusView(() => ` ${snapshot.config.title.startsWith("xloom") ? compact(snapshot.config.title, 100) : `xloom  ·  ${compact(snapshot.config.title, 100)}`}`, coral), basis: 1, shrink: 0 },
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: input, basis: "auto", shrink: 1, minSize: 1 },
    { component: new StatusView(() => ` ${statusLine(snapshot)}${tui.isFollowingOutput ? "" : " · 历史视图"}`), basis: 1, shrink: 0 },
  ]));
  tui.setFocus(input);

  const unsubscribe = controller.subscribe((event) => {
    if (event.snapshot) snapshot = event.snapshot;
    if (event.type === "runtime" && event.runtime) feed.runtime(event.runtime);
    else if (event.type === "handoff" && event.handoff) feed.handoff(event.handoff);
    else if (event.type === "notice" && event.message) print("xloom", event.message);
    else if (event.type === "board") feed.breakStream();
    else if (event.type === "state") {
      print("Loop", `${snapshot.status}${snapshot.reason ? ` · ${snapshot.reason}` : ""}`);
    }
    tui.requestRender();
  });
  const removeInput = tui.addInputListener((data) => {
    if (closing) return { consume: true };
    // ProcessTerminal normally delivers a complete paste; tolerate split deliveries too.
    if (!tui.hasOverlay() && (terminalPaste !== undefined || data.startsWith("\x1b[200~"))) {
      terminalPaste = (terminalPaste ?? "") + (terminalPaste === undefined ? data.slice(6) : data);
      const end = terminalPaste.lastIndexOf("\x1b[201~");
      if (end !== -1) {
        const text = terminalPaste.slice(0, end) + terminalPaste.slice(end + 6);
        terminalPaste = undefined;
        try { insertPaste(text); }
        catch (error) { print("xloom", error instanceof Error ? error.message : "粘贴失败", true); }
      } else if (terminalPaste.length > 1024 * 1024) {
        // Continue consuming the paste through its end marker, but cap retained memory.
        terminalPaste = terminalPaste.slice(0, 1024 * 1024 + 1) + terminalPaste.slice(-5);
      }
      return { consume: true };
    }
    if (isKeyRelease(data)) return { consume: true };
    if (!matchesKey(data, "ctrl+c")) exitArmedAt = undefined;
    if (tui.hasOverlay()) return undefined;
    if (matchesKey(data, "ctrl+v") || matchesKey(data, "ctrl+shift+v") || matchesKey(data, "shift+insert")) {
      requestPaste();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+shift+c") || matchesKey(data, "ctrl+insert")) {
      copySelectionOrDraft();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (isKeyRepeat(data)) return { consume: true };
      // Clearing a draft also invalidates a delayed clipboard read so it cannot refill it.
      draftGeneration++;
      pastePending = undefined;
      editor.disableSubmit = false;
      if (editor.getExpandedText().length > 0) {
        editor.setText("");
        exitArmedAt = undefined;
        tui.requestRender();
      } else {
        const now = Date.now();
        if (exitArmedAt !== undefined && now >= exitArmedAt && now - exitArmedAt <= 2000) quit();
        else { exitArmedAt = now; tui.flash("2 秒内再按一次 Ctrl+C 退出"); }
      }
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
  feed.add("xloom", snapshot.config.goal);
  if (snapshot.reason && snapshot.status !== "idle") feed.add("恢复状态", snapshot.reason);
  try {
    tui.start();
    options.onReady?.({ editor, tui });
    await exitRequested;
    // Keep the terminal alive until cancellation has finished, then restore it.
    if (active) await active;
    await controller.waitForIdle?.();
    await Promise.allSettled([...clipboardTasks]);
  } finally {
    closing = true;
    unsubscribe();
    removeInput();
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
    setKeybindings(previousBindings);
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
