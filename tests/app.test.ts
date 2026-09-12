import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { AppController, type AppOptions } from "../src/app.js";
import { CHAT_GOAL, defaultConfig, loadConfig, saveNewConfig } from "../src/config.js";
import { BlackboardStore } from "../src/store.js";
import { currentTaskId, readSavedBoard, WorkspaceLock } from "../src/workspace.js";
import type { ChatRequest } from "../src/runtime/chat.js";
import type { LoopEvent, RunRequest } from "../src/types.js";

const roots: string[] = [];
const apps: AppController[] = [];
const usage = { input: 3, output: 2, cost: 0.01 };
function setup(options: AppOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "xloom-app-test-")); roots.push(root);
  const configPath = path.join(root, "xloom.json");
  const config = defaultConfig(CHAT_GOAL);
  const chatRequests: ChatRequest[] = [];
  const runRequests: RunRequest[] = [];
  const chat = { send: vi.fn(async (request: ChatRequest) => { chatRequests.push(request); request.onEvent({ mode: "chat", type: "text", text: "Hello" }); return usage; }), reset: vi.fn() };
  const settings = {
    listModels: vi.fn(async () => [{ provider: "fixture", model: "model-a", name: "Model A" }, { provider: "fixture", model: "model-b", name: "Model B" }]),
    listProviders: vi.fn(async () => [{ id: "fixture", name: "Fixture", authTypes: ["api_key", "oauth"] }]),
    saveApiKey: vi.fn(async (_provider: string, _key: string, _signal?: AbortSignal) => {}),
    login: vi.fn(async (_provider: string, _interaction: AuthInteraction) => {}), logout: vi.fn(async (_provider: string, _signal?: AbortSignal) => {}),
  };
  const runner = { run: vi.fn(async (request: RunRequest) => { runRequests.push(request); return { output: { summary: "No executable plan proposed by this fixture" }, usage }; }) };
  saveNewConfig(configPath, config);
  const app = new AppController(root, configPath, config, { chat, settings, runner, ...options }); apps.push(app);
  const events: LoopEvent[] = []; app.subscribe(event => events.push(event));
  return { root, configPath, config, app, chat, settings, runner, chatRequests, runRequests, events };
}

afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("chat / red-team application boundary", () => {
  it("defaults to chat without creating an empty task database", async () => {
    const test = setup();
    expect(test.app.getSessionInfo()).toMatchObject({ mode: "chat", busy: false, status: "idle" });
    await test.app.chat("private normal conversation");
    expect(test.chatRequests).toHaveLength(1);
    expect(test.runRequests).toHaveLength(0);
    expect(test.app.snapshot().hints).toEqual([]);
    expect(test.app.getSessionInfo().usage).toEqual(usage);
    expect(existsSync(path.join(test.root, ".xloom", "blackboard.sqlite"))).toBe(false);
    expect(() => test.app.start()).toThrow(/\/run/);
  });

  it("starts a fresh task for /run and never forwards chat or old task state", async () => {
    const test = setup();
    await test.app.chat("PRIVATE CHAT MUST NOT ENTER TASK");
    await test.app.runGoal("first authorized fixture goal");
    const firstId = currentTaskId(test.root)!;
    const first = readSavedBoard(test.root);
    expect(first).toMatchObject({ status: "paused", hints: [], facts: [], config: { goal: "first authorized fixture goal", scope: "first authorized fixture goal", context: "" } });
    expect(JSON.stringify(test.runRequests)).not.toContain("PRIVATE CHAT");
    expect(test.runRequests.every(request => request.workspace === test.root && request.blackboardPath?.includes(firstId))).toBe(true);
    test.app.hint("OLD TASK PRIVATE HINT");
    await test.app.runGoal("second fixture goal");
    const secondId = currentTaskId(test.root)!;
    expect(secondId).not.toBe(firstId);
    expect(readSavedBoard(test.root, firstId).hints[0]?.content).toBe("OLD TASK PRIVATE HINT");
    expect(readSavedBoard(test.root).hints).toEqual([]);
    expect(readSavedBoard(test.root).config.goal).toBe("second fixture goal");
    expect(readdirSync(path.join(test.root, ".xloom", "tasks"))).toHaveLength(2);
    expect(loadConfig(test.configPath).goal).toBe(CHAT_GOAL);
  });

  it("ordinary chat never becomes a Hint, including after a red-team task", async () => {
    const test = setup(); await test.app.runGoal("fixture");
    const before = readSavedBoard(test.root);
    await test.app.chat("not a hint");
    expect(test.app.getSessionInfo().mode).toBe("chat");
    expect(readSavedBoard(test.root)).toEqual(before);
    test.app.resetChat();
    expect(test.chat.reset).toHaveBeenCalledOnce();
    expect(test.app.getSessionInfo().usage).toEqual({ input: 0, output: 0, cost: 0 });
    expect(readSavedBoard(test.root)).toEqual(before);
  });

  it("reopens the selected task while starting the UI in chat mode", async () => {
    const test = setup(); await test.app.runGoal("recover fixture goal");
    const id = currentTaskId(test.root);
    await test.app.close();
    const reopened = new AppController(test.root, test.configPath, loadConfig(test.configPath), { runner: test.runner, chat: test.chat, settings: test.settings }); apps.push(reopened);
    expect(reopened.getSessionInfo().mode).toBe("chat");
    expect(reopened.snapshot().config.goal).toBe("recover fixture goal");
    await reopened.start();
    expect(currentTaskId(test.root)).toBe(id);
    expect(reopened.snapshot().status).toBe("paused");
  });

  it("uses unlimited workspace time settings for a saved task and for later chat and runs", async () => {
    const test = setup();
    await test.app.close();
    const legacy = defaultConfig("saved fixture goal");
    legacy.limits.stepTimeoutSeconds = 180;
    legacy.limits.maxMinutes = 5;
    const store = new BlackboardStore(test.root, legacy);
    store.hint("preserved fixture context");
    store.setStatus("paused", "Run time limit reached");
    const before = store.snapshot();
    store.close();
    const app = new AppController(test.root, test.configPath, loadConfig(test.configPath), { runner: test.runner, chat: test.chat, settings: test.settings });
    apps.push(app);
    expect(test.runner.run).not.toHaveBeenCalled();
    expect(app.snapshot()).toMatchObject({ status: "paused", goals: before.goals, hints: before.hints, usage: before.usage });
    expect(app.snapshot().config.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
    await app.start();
    expect(test.runRequests[0]!.snapshot.config.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
    await app.chat("model identity");
    expect(test.chatRequests[0]!.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
    await app.runGoal("new fixture goal");
    expect(test.runRequests.at(-1)!.snapshot.config.limits).toMatchObject({ stepTimeoutSeconds: null, maxMinutes: null });
  });

  it("preserves a legacy root blackboard and keeps newly requested tasks separate", async () => {
    const test = setup(); await test.app.close();
    const store = new BlackboardStore(test.root, defaultConfig("legacy fixture goal")); store.hint("legacy hint"); store.close();
    const oldFile = path.join(test.root, ".xloom", "blackboard.sqlite");
    const app = new AppController(test.root, test.configPath, test.config, { runner: test.runner, chat: test.chat, settings: test.settings }); apps.push(app);
    expect(app.snapshot().config.goal).toBe("legacy fixture goal");
    await app.runGoal("new fixture goal");
    expect(existsSync(oldFile)).toBe(true);
    const old = new BlackboardStore(test.root, defaultConfig("legacy fixture goal"));
    expect(old.snapshot().hints[0]?.content).toBe("legacy hint"); old.close();
  });

  it("rejects empty goals before switching or creating tasks", () => {
    const test = setup();
    expect(() => test.app.runGoal(" ")).toThrow();
    expect(currentTaskId(test.root)).toBeUndefined();
    expect(existsSync(path.join(test.root, ".xloom", "tasks"))).toBe(false);
  });

  it("requires explicit task context for hints and metacognition", () => {
    const test = setup();
    expect(() => test.app.hint("hint")).toThrow(/\/run/);
    expect(() => test.app.requestMetacog()).toThrow(/\/run/);
  });

  it("blocks switching while chatting, cancels, and settles before closing", async () => {
    let signal: AbortSignal | undefined;
    const test = setup({ chat: { reset: vi.fn(), send: request => new Promise((_, reject) => { signal = request.signal; signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); }) } });
    const running = test.app.chat("wait");
    const settled = expect(running).rejects.toThrow("cancelled");
    await Promise.resolve();
    expect(() => test.app.runGoal("not yet")).toThrow(/pause/);
    expect(() => test.app.selectModel("fixture", "model-a")).toThrow(/pause/);
    expect(() => test.app.resetChat()).toThrow(/pause/);
    test.app.pause(); await settled; await test.app.waitForIdle();
    expect(signal?.aborted).toBe(true);
    expect(test.app.getSessionInfo()).toMatchObject({ busy: false, status: "paused" });
  });

  it("cancels a queued operation before it reaches the chat backend", async () => {
    const test = setup(); const running = test.app.chat("queued"); const settled = expect(running).rejects.toThrow();
    test.app.stop(); await settled;
    expect(test.chat.send).not.toHaveBeenCalled();
    expect(test.app.getSessionInfo().busy).toBe(false);
  });

  it("accounts for partial chat usage without fabricating research findings", async () => {
    const test = setup({ chat: { reset: vi.fn(), send: async () => { throw Object.assign(new Error("provider failure"), { usage }); } } });
    await expect(test.app.chat("fixture")).rejects.toThrow("provider failure");
    expect(test.app.getSessionInfo()).toMatchObject({ status: "error", usage });
    expect(test.app.snapshot().findings).toEqual([]);
  });

  it("closes an application with a task exactly once, including repeated cleanup", async () => {
    const test = setup(); await test.app.runGoal("close fixture");
    const store = (test.app as unknown as { store: BlackboardStore }).store;
    const closeStore = vi.spyOn(store, "close");
    await test.app.close();
    await test.app.close();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(test.chat.reset).toHaveBeenCalledOnce();
    expect(existsSync(path.join(test.root, ".xloom", "session.lock"))).toBe(false);
    expect(existsSync(path.join(store.dataDir, "controller.lock"))).toBe(false);
  });
});

describe("application model settings", () => {
  it("selects models per role, persists no keys, and applies to paused tasks", async () => {
    const test = setup(); await test.app.runGoal("fixture");
    await test.app.selectModel("fixture", "model-a", "all");
    await test.app.selectModel("fixture", "model-b", "decide");
    const models = loadConfig(test.configPath).models;
    expect(models.chat?.model).toBe("model-a"); expect(models.execute.model).toBe("model-a"); expect(models.decide.model).toBe("model-b");
    expect(readSavedBoard(test.root).config.models).toEqual(models);
    expect(test.chat.reset).toHaveBeenCalledTimes(2);
    await test.app.chat("chat model"); expect(test.chatRequests[0]?.model.model).toBe("model-a");
  });

  it("rejects unknown models without modifying configuration", async () => {
    const test = setup(); const before = readFileSync(test.configPath, "utf8");
    await expect(test.app.selectModel("unknown", "missing")).rejects.toThrow(/Pi/);
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
  });

  it("passes a secret only to Pi settings, never the model, config or events", async () => {
    const test = setup(); await test.app.selectModel("fixture", "model-a");
    const key = "TEST_SECRET_NOT_A_REAL_KEY";
    await test.app.saveApiKey("fixture", key);
    expect(test.settings.saveApiKey).toHaveBeenCalledWith("fixture", key, expect.any(AbortSignal));
    expect(readFileSync(test.configPath, "utf8")).not.toContain(key);
    expect(JSON.stringify(test.events)).not.toContain(key);
    expect(test.chat.send).not.toHaveBeenCalled(); expect(test.runner.run).not.toHaveBeenCalled();
  });

  it("uses saved credentials instead of a stale explicit key environment override", async () => {
    const test = setup(); await test.app.close();
    test.config.models.execute = { provider: "fixture", model: "model-a", apiKeyEnv: "OLD_KEY_ENV" };
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    await app.saveApiKey("fixture", "fixture-key");
    expect(loadConfig(test.configPath).models.execute.apiKeyEnv).toBeUndefined();
  });

  it("uses Pi model defaults without imposing a maxTokens override or inheriting another model's settings", async () => {
    const test = setup(); await test.app.close();
    test.config.models.execute = { provider: "fixture", model: "old-inline", api: "anthropic-messages", baseUrl: "https://fixture.invalid/v1", apiKeyEnv: "OLD_KEY_ENV", maxTokens: 8192, contextWindow: 64000 };
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    await app.selectModel("fixture", "model-a", "all");
    const expected = { provider: "fixture", model: "model-a" };
    expect(loadConfig(test.configPath).models).toEqual({ chat: expected, decide: expected, execute: expected });
    await app.chat("respect provider defaults");
    expect(test.chatRequests[0]?.model).toEqual(expected);
  });

  it("includes a configured inline alias in the chooser and preserves its endpoint on selection", async () => {
    const test = setup(); await test.app.close();
    const alias = { provider: "fixture-inline", model: "private-alias", api: "anthropic-messages", baseUrl: "https://fixture.invalid/api", apiKeyEnv: "ALIAS_KEY_ENV", maxTokens: 2048 };
    test.config.models.execute = alias;
    const app = new AppController(test.root, test.configPath, test.config, { settings: test.settings, chat: test.chat }); apps.push(app);
    expect(await app.getModels()).toContainEqual({ provider: alias.provider, model: alias.model, name: alias.model });
    await app.selectModel(alias.provider, alias.model, "all");
    expect(loadConfig(test.configPath).models).toEqual({ chat: alias, decide: alias, execute: alias });
    expect((await app.getModels()).filter(model => model.provider === alias.provider && model.model === alias.model)).toHaveLength(1);
  });

  it.each(["model", "apikey", "logout"] as const)("does not start an already-cancelled %s setting operation", async kind => {
    const test = setup();
    const before = readFileSync(test.configPath, "utf8");
    const abort = new AbortController(); abort.abort();
    const pending = kind === "model" ? test.app.selectModel("fixture", "model-a", "all", abort.signal)
      : kind === "apikey" ? test.app.saveApiKey("fixture", "synthetic-key", abort.signal) : test.app.logout("fixture", abort.signal);
    await expect(pending).rejects.toThrow();
    expect(test.settings.listModels).not.toHaveBeenCalled();
    expect(test.settings.saveApiKey).not.toHaveBeenCalled();
    expect(test.settings.logout).not.toHaveBeenCalled();
    expect(test.chat.reset).not.toHaveBeenCalled();
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(test.app.getSessionInfo().busy).toBe(false);
  });

  it("does not persist a model selection cancelled during catalog loading", async () => {
    const test = setup(); await test.app.runGoal("cancel model fixture");
    const before = readFileSync(test.configPath, "utf8");
    const boardBefore = readSavedBoard(test.root);
    let release!: (models: Awaited<ReturnType<typeof test.settings.listModels>>) => void;
    test.settings.listModels.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    const pending = test.app.selectModel("fixture", "model-a", "all", abort.signal);
    const settled = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort();
    release([{ provider: "fixture", model: "model-a", name: "Model A" }]);
    await settled;
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(readSavedBoard(test.root)).toEqual(boardBefore);
    expect(test.chat.reset).not.toHaveBeenCalled();
  });

  it.each(["apikey", "logout"] as const)("propagates an in-flight %s cancellation without committing or resetting chat", async kind => {
    const test = setup();
    const before = readFileSync(test.configPath, "utf8");
    let received: AbortSignal | undefined;
    let committed = false;
    const cancelAwareOperation = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      received = signal;
      signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      // A cancelled backend never reaches its persistence step.
      if (!signal) { committed = true; resolve(); }
    });
    test.settings.saveApiKey.mockImplementation((_provider, _key, signal) => cancelAwareOperation(signal));
    test.settings.logout.mockImplementation((_provider, signal) => cancelAwareOperation(signal));
    const abort = new AbortController();
    const pending = kind === "apikey" ? test.app.saveApiKey("fixture", "synthetic-key", abort.signal) : test.app.logout("fixture", abort.signal);
    const settled = expect(pending).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(received).toBeDefined());
    abort.abort(); await settled;
    expect(received?.aborted).toBe(true);
    expect(committed).toBe(false);
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(test.chat.reset).not.toHaveBeenCalled();
    expect(test.app.getSessionInfo().busy).toBe(false);
  });

  it("rechecks API-key cancellation before clearing environment overrides even if a backend resolves late", async () => {
    const test = setup();
    const before = readFileSync(test.configPath, "utf8");
    let release!: () => void;
    test.settings.saveApiKey.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    const pending = test.app.saveApiKey("fixture", "synthetic-key", abort.signal);
    const settled = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort(); release(); await settled;
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(test.chat.reset).not.toHaveBeenCalled();
  });

  it("restores disk and memory settings when the paused blackboard update fails", async () => {
    const test = setup(); await test.app.runGoal("settings rollback fixture");
    const before = readFileSync(test.configPath, "utf8");
    const boardBefore = readSavedBoard(test.root);
    const selectedBefore = test.app.getSessionInfo().model;
    const store = (test.app as unknown as { store: BlackboardStore }).store;
    vi.spyOn(store, "updateModels").mockImplementation(() => { throw new Error("synthetic SQLite failure"); });
    await expect(test.app.selectModel("fixture", "model-a")).rejects.toThrow("配置已恢复");
    expect(readFileSync(test.configPath, "utf8")).toBe(before);
    expect(readSavedBoard(test.root)).toEqual(boardBefore);
    expect(test.app.getSessionInfo().model).toBe(selectedBefore);
    expect(test.chat.reset).not.toHaveBeenCalled();
  });
});

describe("workspace ownership", () => {
  it("concurrent close callers wait for the same cleanup and cannot start new work", async () => {
    let release!: () => void;
    const test = setup({ chat: { reset: vi.fn(), send: () => new Promise(resolve => { release = () => resolve(usage); }) } });
    const running = test.app.chat("pending fixture");
    await Promise.resolve();
    const first = test.app.close();
    const second = test.app.close();
    expect(second).toBe(first);
    let closed = false;
    void first.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => test.app.chat("after close")).toThrow(/已关闭/);
    release(); await running; await Promise.all([first, second]);
    expect(closed).toBe(true);
    expect(existsSync(path.join(test.root, ".xloom", "session.lock"))).toBe(false);
  });

  it("keeps one live application per workspace and releases its own lock", async () => {
    const test = setup();
    expect(() => new WorkspaceLock(test.root)).toThrow(/Another xloom session/);
    await test.app.close();
    const lock = new WorkspaceLock(test.root); lock.close();
    expect(existsSync(path.join(test.root, ".xloom", "session.lock"))).toBe(false);
  });

  it("rejects malformed task pointers without reading outside the workspace", async () => {
    const test = setup(); await test.app.close();
    writeFileSync(path.join(test.root, ".xloom", "current-task.json"), JSON.stringify({ taskId: "../../outside" }));
    expect(() => readSavedBoard(test.root)).toThrow(/Invalid task ID/);
    expect(() => new AppController(test.root, test.configPath, test.config)).toThrow(/Invalid task ID/);
    expect(existsSync(path.join(test.root, ".xloom", "session.lock"))).toBe(false);
  });

  it("recovers a stale session under the recovery guard and releases that guard", async () => {
    const test = setup(); await test.app.close();
    const file = path.join(test.root, ".xloom", "session.lock");
    writeFileSync(file, JSON.stringify({ pid: 123456789, token: "stale-owner" }));
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 123456789) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return realKill(pid, signal);
    });
    const lock = new WorkspaceLock(test.root);
    try {
      const owner = JSON.parse(readFileSync(file, "utf8"));
      expect(owner.pid).toBe(process.pid); expect(owner.token).not.toBe("stale-owner");
      expect(existsSync(`${file}.recovery`)).toBe(false);
      const activeContents = readFileSync(file, "utf8");
      expect(() => new WorkspaceLock(test.root)).toThrow("Another xloom session");
      expect(readFileSync(file, "utf8")).toBe(activeContents);
      expect(existsSync(`${file}.recovery`)).toBe(false);
    } finally { lock.close(); }
    expect(existsSync(file)).toBe(false);
  });

  it("does not inspect or remove an owner when another recovery guard exists", async () => {
    const test = setup(); await test.app.close();
    const file = path.join(test.root, ".xloom", "session.lock");
    const content = JSON.stringify({ pid: 123456789, token: "existing-owner" });
    writeFileSync(file, content); writeFileSync(`${file}.recovery`, "other-recovery-owner");
    const kill = vi.spyOn(process, "kill");
    expect(() => new WorkspaceLock(test.root)).toThrow("Another process is checking");
    expect(kill).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readFileSync(`${file}.recovery`, "utf8")).toBe("other-recovery-owner");
  });

  it("never removes a replacement session lock when closing an older owner", async () => {
    const test = setup(); await test.app.close();
    const lock = new WorkspaceLock(test.root);
    const file = path.join(test.root, ".xloom", "session.lock");
    const replacement = JSON.stringify({ pid: process.pid, token: "replacement-owner" });
    writeFileSync(file, replacement);
    lock.close();
    expect(readFileSync(file, "utf8")).toBe(replacement);
  });
});
