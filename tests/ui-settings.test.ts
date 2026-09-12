import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { visibleWidth, type Editor, type Terminal, type TuiAltScreen } from "@earendil-works/pi-tui";
import type { BoardSnapshot, LoopEvent } from "../src/types.js";
import { runTui } from "../src/ui/index.js";
import { EventFeed, plainText, statusLine, type UiController } from "../src/ui/model.js";
import { SettingsPanel } from "../src/ui/settings-dialog.js";

class MemoryTerminal implements Terminal {
  output = "";
  stopped = false;
  input: (data: string) => void = () => {};
  columns = 90;
  rows = 26;
  kittyProtocolActive = false;
  start(onInput: (data: string) => void): void { this.input = onInput; }
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
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

function launch() {
  const board: BoardSnapshot = {
    revision: 0, status: "idle", outcome: null, reason: "", completedSteps: 0, noProgressCount: 0,
    lastMetaStep: 0, lastMetaRevision: 0, usage: { input: 0, output: 0, cost: 0 },
    config: { version: 1, title: "xloom", goal: "stored task", scope: "localhost", context: "",
      models: { decide: { provider: "test", model: "test" }, execute: { provider: "test", model: "test" } },
      limits: { maxNoProgress: 3, maxMinutes: null, maxTokens: null, maxCost: null, maxTurnsPerRun: 5, stepTimeoutSeconds: 60, metacogEvery: 3 } },
    goals: [], facts: [], steps: [], findings: [], evidence: [], hints: [],
  };
  const listeners = new Set<(event: LoopEvent) => void>();
  const info = { mode: "chat" as "chat" | "run", busy: false, model: "opencode-go/deepseek-v4-flash" };
  const controller = {
    snapshot: vi.fn(() => board),
    subscribe: vi.fn((listener: (event: LoopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    start: vi.fn(async () => {}), pause: vi.fn(), stop: vi.fn(), hint: vi.fn(), requestMetacog: vi.fn(),
    chat: vi.fn(async (_text: string) => {}), runGoal: vi.fn(async (_text: string) => {}), resetChat: vi.fn(),
    getSessionInfo: vi.fn(() => info),
    getModels: vi.fn(async () => [
      { provider: "anthropic", model: "claude-sonnet-4", name: "Claude Sonnet" },
      { provider: "opencode-go", model: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    ]),
    getProviders: vi.fn(async () => [
      { id: "anthropic", name: "Anthropic", authTypes: ["api_key", "oauth"] },
      { id: "opencode-go", name: "OpenCode Go", authTypes: ["api_key"] },
    ]),
    selectModel: vi.fn(async (_provider: string, _model: string, _role?: string, _signal?: AbortSignal) => {}), saveApiKey: vi.fn(async (_provider: string, _key: string, _signal?: AbortSignal) => {}),
    login: vi.fn(async (_provider: string, _interaction: AuthInteraction) => {}), logout: vi.fn(async (_provider: string, _signal?: AbortSignal) => {}),
  } satisfies UiController;
  const terminal = new MemoryTerminal();
  const clipboard = { readText: vi.fn(async () => "PRIVATE_CLIPBOARD_KEY"), writeText: vi.fn(async () => true) };
  let controls!: { editor: Editor; tui: TuiAltScreen };
  const session = runTui(controller, terminal, { clipboard, onReady: value => { controls = value; } });
  const submit = (text: string): void => { controls.editor.setText(text); terminal.input("\r"); };
  const close = async (): Promise<void> => {
    if (!terminal.stopped) {
      if (controls.tui.hasOverlay()) { terminal.input("\x1b"); await vi.waitFor(() => expect(controls.tui.hasOverlay()).toBe(false)); }
      submit("/exit");
    }
    await session;
  };
  cleanup.push(close);
  const settled = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { ...controls, board, info, controller, terminal, clipboard, submit, close, settled, session, listeners };
}

describe("ordinary chat and dual-agent task UI", () => {
  it("shows chat status without resurrecting the stored task and labels chat runtime distinctly", () => {
    const app = launch();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("chat · idle");
    expect(plainText(app.terminal.output)).not.toContain("stored task");
    expect(statusLine(app.board, app.info)).toContain("deepseek-v4-flash");
    expect(statusLine(app.board, { ...app.info, usage: { input: 7, output: 5, cost: 0.1 } })).toContain("12 tokens · $0.100");
    const feed = new EventFeed();
    feed.runtime({ type: "text", mode: "chat", text: "hello" });
    feed.runtime({ type: "tool_start", mode: "chat", toolName: "read", text: "read file" });
    expect(feed.entries.map(entry => entry.label)).toEqual(["Assistant", "Read"]);
    expect(feed.entries.map(entry => entry.kind)).toEqual(["message", "tool"]);
  });

  it("routes normal text, /run goal and /hint independently", async () => {
    const app = launch();
    app.submit("hello model");
    expect(app.controller.chat).toHaveBeenCalledWith("hello model");
    expect(app.controller.hint).not.toHaveBeenCalled();
    await app.settled();
    app.submit("/run https://localhost 对象边界");
    expect(app.controller.runGoal).toHaveBeenCalledWith("https://localhost 对象边界");
    app.submit("/hint account A");
    expect(app.controller.hint).toHaveBeenCalledWith("account A");
    await app.settled();
    app.submit("/new");
    expect(app.controller.resetChat).toHaveBeenCalledOnce();
  });

  it("rejects new messages/settings while busy without converting them to hints", () => {
    const app = launch();
    app.info.busy = true;
    for (const command of ["new chat", "/run new task", "/model"]) app.submit(command);
    expect(app.controller.chat).not.toHaveBeenCalled();
    expect(app.controller.runGoal).not.toHaveBeenCalled();
    expect(app.controller.getModels).not.toHaveBeenCalled();
    expect(app.controller.hint).not.toHaveBeenCalled();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("/pause");
  });

  it("aborts active chat on exit and waits until cancellation settles", async () => {
    const app = launch();
    let release!: () => void;
    app.controller.chat.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    app.submit("in flight");
    app.submit("/exit");
    expect(app.controller.stop).toHaveBeenCalledOnce();
    expect(app.terminal.stopped).toBe(false);
    release();
    await app.session;
    expect(app.terminal.stopped).toBe(true);
  });
});

describe("Pi-style model and credential dialogs", () => {
  it("searches the full model/provider name and switches the selected role", async () => {
    const app = launch();
    app.submit("/model decide");
    await app.settled();
    expect(app.tui.hasOverlay()).toBe(true);
    app.terminal.input("flash");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("deepseek-v4-flash");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.selectModel).toHaveBeenCalledWith("opencode-go", "deepseek-v4-flash", "decide", expect.any(AbortSignal)));
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it("accepts a masked API key without rendering it or recording it in editor history", async () => {
    const app = launch();
    app.submit("/board");
    app.submit("/apikey opencode-go");
    await app.settled();
    app.terminal.input("PRIVATE_TEST_KEY");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("•••");
    expect(app.terminal.output).not.toContain("PRIVATE_TEST_KEY");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("opencode-go", "PRIVATE_TEST_KEY", expect.any(AbortSignal)));
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("/board");
    expect(app.controller.chat).not.toHaveBeenCalled();
    expect(app.controller.hint).not.toHaveBeenCalled();
  });

  it("selects API provider first when /apikey has no argument", async () => {
    const app = launch();
    app.submit("/apikey");
    await app.settled();
    app.terminal.input("opencode");
    app.terminal.input("\r");
    await app.settled();
    app.terminal.input("PRIVATE_SELECTED_KEY");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("opencode-go", "PRIVATE_SELECTED_KEY", expect.any(AbortSignal)));
  });

  it("never saves or retains accidentally inline credentials", async () => {
    const app = launch();
    app.submit("/board");
    app.submit("/apikey opencode-go PRIVATE_INLINE_KEY");
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_INLINE_KEY");
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    expect(app.tui.hasOverlay()).toBe(false);
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("/board");
  });

  it("pastes secrets privately and requires Enter rather than treating pasted control bytes as commands", async () => {
    const app = launch();
    app.submit("/apikey opencode-go");
    await app.settled();
    app.terminal.input("\x16");
    await vi.waitFor(() => expect(app.clipboard.readText).toHaveBeenCalledOnce());
    await app.settled();
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_CLIPBOARD_KEY");
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("opencode-go", "PRIVATE_CLIPBOARD_KEY", expect.any(AbortSignal)));
  });

  it("cancels API key entry on Escape without storing a key", async () => {
    const app = launch();
    app.submit("/apikey anthropic");
    await app.settled();
    app.terminal.input("PRIVATE_CANCELLED_KEY");
    app.terminal.input("\x1b");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    expect(app.controller.pause).not.toHaveBeenCalled();
    expect(app.terminal.output).not.toContain("PRIVATE_CANCELLED_KEY");
  });

  it.each(["apikey", "model", "logout"] as const)("passes cancellation through an in-flight %s commit", async command => {
    const app = launch();
    let signal: AbortSignal | undefined;
    const wait = (value?: AbortSignal): Promise<void> => {
      signal = value;
      return new Promise((_resolve, reject) => value!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    };
    app.controller.saveApiKey.mockImplementation((_provider, _key, value) => wait(value));
    app.controller.selectModel.mockImplementation((_provider, _model, _role, value) => wait(value));
    app.controller.logout.mockImplementation((_provider, value) => wait(value));
    app.submit(command === "model" ? "/model" : `/${command} anthropic`);
    await app.settled();
    if (command === "apikey") app.terminal.input("PRIVATE_KEY_IN_FLIGHT");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(signal).toBeDefined());
    app.terminal.input("\x1b");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(signal?.aborted).toBe(true);
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).not.toContain("PRIVATE_KEY_IN_FLIGHT");
    expect(plainText(app.terminal.output)).toContain("设置已取消");
  });

  it("does not save an old draft when Enter races a private clipboard read", async () => {
    const app = launch();
    let resolve!: (text: string) => void;
    app.clipboard.readText.mockImplementation(() => new Promise(done => { resolve = done; }));
    app.submit("/apikey anthropic");
    await app.settled();
    app.terminal.input("OLD");
    app.terminal.input("\x16");
    app.terminal.input("\r");
    expect(app.controller.saveApiKey).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(app.clipboard.readText).toHaveBeenCalledOnce());
    app.terminal.input("\x03");
    app.terminal.input("NEW_KEY");
    resolve("STALE_SECRET");
    await app.settled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.controller.saveApiKey).toHaveBeenCalledWith("anthropic", "NEW_KEY", expect.any(AbortSignal)));
  });

  it("honors cancellation while a provider catalog is loading before starting login", async () => {
    const app = launch();
    let resolve!: (providers: Awaited<ReturnType<typeof app.controller.getProviders>>) => void;
    app.controller.getProviders.mockImplementation(() => new Promise(done => { resolve = done; }));
    app.submit("/login anthropic");
    app.terminal.input("\x1b");
    resolve([{ id: "anthropic", name: "Anthropic", authTypes: ["oauth"] }]);
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.login).not.toHaveBeenCalled();
  });

  it("uses Pi auth interactions and hides login codes from feed/history", async () => {
    const app = launch();
    let code = "";
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.example/login?state=PRIVATE_AUTH_STATE", instructions: "请打开此登录链接" });
      code = await interaction.prompt({ type: "manual_code", message: "登录码" });
    });
    app.submit("/login anthropic");
    await app.settled();
    app.terminal.input("PRIVATE_LOGIN_CODE");
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_LOGIN_CODE");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(code).toBe("PRIVATE_LOGIN_CODE");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_AUTH_STATE");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("");
  });

  it.each(["auth_url", "device_code", "info"] as const)("copies exact raw %s login URLs without wrapping or terminal-control content", async type => {
    const app = launch();
    const url = `https://auth.example/login?state=${"a".repeat(180)}&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback`;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify(type === "auth_url" ? { type, url, instructions: "Browser opened automatically\x1b[2J" }
        : type === "device_code" ? { type, verificationUri: url, userCode: "CODE" }
          : { type, message: "Login", links: [{ url, label: "Browser" }] });
      await interaction.prompt({ type: "manual_code", message: "Paste code" });
    });
    app.submit("/login anthropic");
    await app.settled();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("本界面不自动打开浏览器");
    expect(plainText(app.terminal.output)).toContain("Ctrl+L");
    app.terminal.input("\x0c");
    await vi.waitFor(() => expect(app.clipboard.writeText).toHaveBeenCalledWith(url));
    expect(app.clipboard.writeText.mock.calls[0]?.[0]).not.toMatch(/[\n\r\x1b]/);
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "https://auth.example/?state=secret\x1b[2J", "https://auth.example/\nsecret"])("does not copy an unsafe or control-bearing auth URL %j", async url => {
    const app = launch();
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url });
      await interaction.prompt({ type: "manual_code", message: "Code" });
    });
    app.submit("/login anthropic");
    await app.settled();
    app.terminal.input("\x0c");
    await app.settled();
    expect(app.clipboard.writeText).not.toHaveBeenCalled();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).not.toContain("Ctrl+L");
  });

  it("filters /login providers to OAuth and rejects API-only providers", async () => {
    const app = launch();
    app.submit("/login opencode-go");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.login).not.toHaveBeenCalled();
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("不支持此认证方式");
  });

  it("allows an empty OAuth text prompt for the default GitHub Copilot domain", async () => {
    const app = launch();
    let domain: string | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      domain = await interaction.prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" });
    });
    app.submit("/login anthropic");
    await app.settled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(domain).toBe("");
  });

  it("shows non-secret OAuth text only in the current dialog, never in chat/history", async () => {
    const app = launch();
    let domain = "";
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      domain = await interaction.prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" });
    });
    app.submit("/login anthropic");
    await app.settled();
    app.terminal.input("github.example.test");
    app.tui.renderNow(true);
    expect(plainText(app.terminal.output)).toContain("github.example.test");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(domain).toBe("github.example.test");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("github.example.test");
    app.terminal.input("\x1b[A");
    expect(app.editor.getExpandedText()).toBe("");
    expect(app.controller.chat).not.toHaveBeenCalled();
  });

  it.each(["secret", "manual_code"] as const)("continues to require non-empty, masked OAuth %s input", async type => {
    const app = launch();
    let entered: string | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      entered = await interaction.prompt({ type, message: "Enter credential" });
    });
    app.submit("/login anthropic");
    await app.settled();
    app.terminal.input("\r");
    await app.settled();
    expect(app.tui.hasOverlay()).toBe(true);
    expect(entered).toBeUndefined();
    app.terminal.input("PRIVATE_NONEMPTY_CREDENTIAL");
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_NONEMPTY_CREDENTIAL");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(entered).toBe("PRIVATE_NONEMPTY_CREDENTIAL");
  });

  it("supports Pi login option selectors and keeps device-code notifications transient", async () => {
    const app = launch();
    let selected = "";
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      interaction.notify({ type: "device_code", userCode: "DEVICE-CODE", verificationUri: "https://auth.example/device" });
      selected = await interaction.prompt({ type: "select", message: "Choose account", options: [
        { id: "personal", label: "Personal" }, { id: "business", label: "Business" },
      ] });
    });
    app.submit("/login anthropic");
    await app.settled();
    app.terminal.input("\x1b[B");
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(selected).toBe("business");
    app.terminal.output = "";
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("DEVICE-CODE");
  });

  it("propagates Escape cancellation to the OAuth flow", async () => {
    const app = launch();
    let signal: AbortSignal | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      signal = interaction.signal;
      await interaction.prompt({ type: "secret", message: "Enter secret" });
    });
    app.submit("/login anthropic");
    await vi.waitFor(() => expect(signal).toBeDefined());
    app.terminal.input("\x1b");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(signal?.aborted).toBe(true);
  });

  it("aborts pending login during terminal exit and restores terminal", async () => {
    const app = launch();
    let signal: AbortSignal | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      signal = interaction.signal;
      await interaction.prompt({ type: "manual_code", message: "Paste code" });
    });
    app.submit("/login anthropic");
    await vi.waitFor(() => expect(signal).toBeDefined());
    process.emit("SIGTERM");
    await app.session;
    expect(signal?.aborted).toBe(true);
    expect(app.terminal.stopped).toBe(true);
  });

  it("handles callback-cancelled auth prompts without cancelling the whole flow", async () => {
    const app = launch();
    const promptAbort = new AbortController();
    let signal: AbortSignal | undefined;
    app.controller.login.mockImplementation(async (_provider, interaction) => {
      signal = interaction.signal;
      await interaction.prompt({ type: "manual_code", message: "Code", signal: promptAbort.signal }).catch(() => {});
    });
    app.submit("/login anthropic");
    await vi.waitFor(() => expect(signal).toBeDefined());
    promptAbort.abort();
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(signal?.aborted).toBe(false);
  });

  it("requires confirmation for logout and keeps provider error details private", async () => {
    const app = launch();
    app.controller.logout.mockRejectedValue(new Error("PRIVATE_PROVIDER_ERROR"));
    app.submit("/logout anthropic");
    await app.settled();
    expect(app.controller.logout).not.toHaveBeenCalled();
    app.terminal.input("\r");
    await vi.waitFor(() => expect(app.tui.hasOverlay()).toBe(false));
    expect(app.controller.logout).toHaveBeenCalledWith("anthropic", expect.any(AbortSignal));
    app.tui.renderNow(true);
    expect(app.terminal.output).not.toContain("PRIVATE_PROVIDER_ERROR");
  });
});

describe("private settings input component", () => {
  it.each(["text", "select"] as const)("discards secret kill-ring and undo data before a new %s prompt", type => {
    const submitted = vi.fn();
    const panel = new SettingsPanel("Login", () => {});
    panel.focused = true;
    panel.setPrompt("Secret", { secret: true }, submitted);
    panel.handleInput("SYNTHETIC_PRIVATE_KEY");
    panel.handleInput("\x15");
    panel.setPrompt("Next prompt", type === "text" ? { allowEmpty: true } : { items: [{ value: "ok", label: "Continue" }] }, submitted);
    expect(panel.focused).toBe(true);
    panel.handleInput("\x19");
    panel.handleInput("\x1a");
    expect(panel.render(90).join("\n")).not.toContain("SYNTHETIC_PRIVATE_KEY");
    panel.handleInput("\r");
    expect(submitted).toHaveBeenCalledWith(type === "text" ? "" : "ok");
    panel.setPrompt("Another secret", { secret: true }, submitted);
    panel.handleInput("SYNTHETIC_DISPOSED_KEY");
    panel.handleInput("\x15");
    panel.clear();
    panel.setPrompt("After clear", { allowEmpty: true }, submitted);
    panel.handleInput("\x19");
    expect(panel.render(90).join("\n")).not.toContain("SYNTHETIC_DISPOSED_KEY");
  });

  it("never renders secret text even in narrow terminals", () => {
    const panel = new SettingsPanel("API Key", () => {});
    panel.focused = true;
    panel.setPrompt("秘密输入", { secret: true }, () => {});
    panel.handleInput("SUPER_PRIVATE_VALUE");
    for (const width of [0, 1, 2, 4, 20, 90]) {
      const lines = panel.render(width);
      expect(lines.join("\n")).not.toContain("SUPER_PRIVATE_VALUE");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("treats split bracketed paste as text, supports Ctrl+C clearing, and ignores stale paste", () => {
    const submitted = vi.fn();
    const panel = new SettingsPanel("API Key", () => {});
    panel.setPrompt("Key", { secret: true }, submitted);
    const old = panel.version;
    panel.handleInput("\x1b[200~secret\r\n");
    panel.handleInput("\x03");
    panel.handleInput("\x1b[201~");
    expect(submitted).not.toHaveBeenCalled();
    panel.handleInput("\r");
    expect(submitted).toHaveBeenCalledWith("secret");
    panel.handleInput("\x03");
    panel.setPrompt("New key", { secret: true }, submitted);
    panel.paste("STALE_KEY", old);
    panel.handleInput("\r");
    expect(submitted).toHaveBeenCalledOnce();
  });
});
