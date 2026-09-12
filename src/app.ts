import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { CHAT_GOAL, saveConfig } from "./config.js";
import { LoopController } from "./controller.js";
import { BlackboardStore } from "./store.js";
import { ChatSession, type ChatRequest } from "./runtime/chat.js";
import { PiRunner } from "./runtime/pi-runner.js";
import { SettingsService } from "./runtime/settings.js";
import { projectConfigSchema, usageSchema } from "./schema.js";
import { currentTaskId, readSavedBoard, selectTask, taskDirectory, WorkspaceLock } from "./workspace.js";
import type { AgentRunner, BoardSnapshot, LoopEvent, ProjectConfig, Usage } from "./types.js";

export interface AppOptions {
  runner?: AgentRunner;
  chat?: { send(request: ChatRequest): Promise<Usage>; reset(): void };
  settings?: Pick<SettingsService, "listModels" | "listProviders" | "saveApiKey" | "login" | "logout">;
}

/** Chat owns its history. A red-team task owns a separate blackboard, never that history. */
export class AppController {
  readonly workspace: string;
  private config: ProjectConfig;
  private readonly lock: WorkspaceLock;
  private readonly runner: AgentRunner;
  private readonly chatSession: NonNullable<AppOptions["chat"]>;
  private readonly settings: NonNullable<AppOptions["settings"]>;
  private store?: BlackboardStore;
  private loop?: LoopController;
  private detachLoop?: () => void;
  private listeners = new Set<(event: LoopEvent) => void>();
  private active?: Promise<void>;
  private cancellation?: AbortController;
  private mode: "chat" | "run" = "chat";
  private chatUsage: Usage = { input: 0, output: 0, cost: 0 };
  private chatStatus = "idle";
  private closed = false;
  private closing?: Promise<void>;

  constructor(workspace: string, private readonly configPath: string, config: ProjectConfig, options: AppOptions = {}) {
    this.workspace = realpathSync(workspace);
    this.config = projectConfigSchema.parse(config);
    this.runner = options.runner ?? new PiRunner();
    this.chatSession = options.chat ?? new ChatSession();
    this.settings = options.settings ?? new SettingsService();
    this.lock = new WorkspaceLock(this.workspace);
    try {
      const taskId = currentTaskId(this.workspace);
      if (taskId || existsSync(path.join(taskDirectory(this.workspace), "blackboard.sqlite"))) {
        const saved = readSavedBoard(this.workspace, taskId);
        this.attach(new BlackboardStore(this.workspace, { ...saved.config, models: this.config.models, limits: this.config.limits }, { taskId }));
      }
    } catch (error) { this.lock.close(); throw error; }
  }

  private attach(store: BlackboardStore): void {
    this.detachLoop?.();
    this.store?.close();
    this.store = store;
    this.loop = new LoopController(store, this.runner);
    this.detachLoop = this.loop.subscribe(event => this.emit(event));
  }

  snapshot(): BoardSnapshot {
    return this.store?.snapshot() ?? {
      revision: 0, config: structuredClone(this.config), status: "idle", outcome: null, reason: "普通聊天；/run 目标启动独立任务",
      goals: [], facts: [], steps: [], findings: [], evidence: [], hints: [], usage: { ...this.chatUsage },
      completedSteps: 0, noProgressCount: 0, lastMetaStep: 0, lastMetaRevision: -1, elapsedMs: 0,
    };
  }
  getSessionInfo() {
    const selected = this.mode === "chat" ? this.config.models.chat ?? this.config.models.execute : this.config.models.decide;
    return { mode: this.mode, busy: !!this.active, model: `${selected.provider}/${selected.model}`, status: this.mode === "chat" ? this.chatStatus : this.store?.snapshot().status ?? "idle", usage: this.mode === "chat" ? { ...this.chatUsage } : this.store?.snapshot().usage };
  }
  subscribe(listener: (event: LoopEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: LoopEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* Isolate rendering from state. */ } } }
  private idle(): void {
    if (this.closed) throw new Error("当前 xloom 会话已关闭。");
    if (this.active) throw new Error("当前调用尚未结束。请先 /pause，等待停止后再切换模式、模型或凭据。");
  }

  private perform(mode: "chat" | "run", operation: (signal: AbortSignal) => Promise<void>, externalSignal?: AbortSignal): Promise<void> {
    this.idle();
    this.mode = mode;
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    const signal = externalSignal ? AbortSignal.any([cancellation.signal, externalSignal]) : cancellation.signal;
    const task = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).finally(() => {
      if (this.active === task) { this.active = undefined; this.cancellation = undefined; }
      this.emit({ type: "session" });
    });
    this.active = task;
    this.emit({ type: "session" });
    return task;
  }
  private addChatUsage(value: unknown): void {
    const result = usageSchema.safeParse(value);
    if (result.success) { this.chatUsage.input += result.data.input; this.chatUsage.output += result.data.output; this.chatUsage.cost += result.data.cost; }
  }
  chat(text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    return this.perform("chat", async signal => {
      this.chatStatus = "running";
      try {
        this.addChatUsage(await this.chatSession.send({ text, workspace: this.workspace, model: this.config.models.chat ?? this.config.models.execute, limits: this.config.limits, signal, onEvent: runtime => this.emit({ type: "runtime", runtime }) }));
        this.chatStatus = "idle";
      } catch (error) {
        if (error && typeof error === "object" && "usage" in error) this.addChatUsage(error.usage);
        this.chatStatus = signal.aborted ? "paused" : "error";
        throw error;
      }
    });
  }
  resetChat(): void { this.idle(); this.chatSession.reset(); this.chatUsage = { input: 0, output: 0, cost: 0 }; this.chatStatus = "idle"; this.mode = "chat"; this.emit({ type: "session" }); }

  runGoal(goal: string): Promise<void> {
    this.idle();
    const config = projectConfigSchema.parse({ ...this.config, goal: goal.trim(), scope: goal.trim(), context: "" });
    const taskId = `task-${randomUUID()}`;
    const store = new BlackboardStore(this.workspace, config, { taskId });
    try { selectTask(this.workspace, taskId); } catch (error) { store.close(); throw error; }
    this.attach(store);
    this.emit({ type: "board", snapshot: store.snapshot() });
    return this.perform("run", async () => this.loop!.start());
  }
  start(): Promise<void> {
    this.idle();
    if (!this.loop) {
      if (this.config.goal === CHAT_GOAL) throw new Error("尚无红队任务，请输入 /run 目标。");
      this.attach(new BlackboardStore(this.workspace, this.config));
    }
    return this.perform("run", async () => this.loop!.start());
  }
  pause(): void { this.cancellation?.abort(); if (this.mode === "run") this.loop?.pause(); this.emit({ type: "session" }); }
  stop(): void { this.cancellation?.abort(); if (this.mode === "run") this.loop?.stop(); this.emit({ type: "session" }); }
  hint(content: string): void { if (!this.loop) throw new Error("尚无黑板，请先 /run 目标。"); this.loop.hint(content); }
  requestMetacog(): void {
    if (!this.loop) throw new Error("尚无红队任务，请先 /run 目标。");
    if (this.active) {
      if (this.mode !== "run") throw new Error("聊天尚未结束，请先 /pause。");
      this.loop.requestMetacog();
    } else {
      void this.perform("run", async () => { this.loop!.requestMetacog(); await this.loop!.waitForIdle(); }).catch(error => this.emit({ type: "notice", message: error instanceof Error ? error.message : String(error) }));
    }
  }
  async waitForIdle(): Promise<void> { await this.active?.catch(() => undefined); await this.loop?.waitForIdle(); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.cancellation?.abort();
    this.closing = Promise.resolve().then(async () => {
      try { this.stop(); await this.waitForIdle(); }
      finally {
        try { this.chatSession.reset(); this.detachLoop?.(); this.store?.close(); }
        finally { this.lock.close(); }
      }
    });
    return this.closing;
  }

  async getModels() {
    const models = await this.settings.listModels();
    for (const configured of Object.values(this.config.models)) {
      if (configured && !models.some(model => model.provider === configured.provider && model.model === configured.model)) models.push({ provider: configured.provider, model: configured.model, name: configured.model });
    }
    return models;
  }
  getProviders() { return this.settings.listProviders(); }
  private persistModels(models: ProjectConfig["models"]): void {
    const config = projectConfigSchema.parse({ ...this.config, models });
    saveConfig(this.configPath, config);
    try { this.store?.updateModels(config.models); }
    catch {
      try { saveConfig(this.configPath, this.config); }
      catch { throw new Error("模型配置已保存，但当前黑板同步失败且无法恢复配置。请退出并重启 xloom 后核对模型设置。"); }
      throw new Error("模型设置未应用：当前黑板更新失败，配置已恢复。请检查本地存储后重试。");
    }
    this.config = config;
    this.chatSession.reset();
    this.emit({ type: "session" });
  }
  selectModel(provider: string, model: string, role: "all" | "chat" | "decide" | "execute" = "all", signal?: AbortSignal): Promise<void> {
    return this.perform(this.mode, async signal => {
      const models = await this.getModels();
      signal.throwIfAborted();
      if (!models.some(item => item.provider === provider && item.model === model)) throw new Error("模型不在 Pi 当前目录中。请检查 provider/model 或 Pi models.json。");
      const next = structuredClone(this.config.models);
      // Keep the endpoint of an explicitly configured alias; built-in choices
      // use Pi defaults instead of inheriting another model's endpoint/limits.
      const configured = Object.values(this.config.models).find(item => item?.provider === provider && item.model === model && (item.api || item.baseUrl));
      for (const target of role === "all" ? ["chat", "decide", "execute"] as const : [role]) next[target] = configured ? { ...configured } : { provider, model };
      this.persistModels(next);
    }, signal);
  }
  private useStoredCredential(provider: string): void {
    const models = structuredClone(this.config.models);
    for (const model of Object.values(models)) if (model?.provider === provider) delete model.apiKeyEnv;
    this.persistModels(models);
  }
  saveApiKey(provider: string, key: string, externalSignal?: AbortSignal): Promise<void> {
    return this.perform(this.mode, async signal => { await this.settings.saveApiKey(provider, key, signal); signal.throwIfAborted(); this.useStoredCredential(provider); }, externalSignal);
  }
  login(provider: string, interaction: AuthInteraction): Promise<void> {
    return this.perform(this.mode, async signal => {
      const combined = interaction.signal ? AbortSignal.any([signal, interaction.signal]) : signal;
      await this.settings.login(provider, { ...interaction, signal: combined });
      combined.throwIfAborted();
      this.useStoredCredential(provider);
    });
  }
  logout(provider: string, externalSignal?: AbortSignal): Promise<void> { return this.perform(this.mode, async signal => { await this.settings.logout(provider, signal); this.chatSession.reset(); }, externalSignal); }
}
