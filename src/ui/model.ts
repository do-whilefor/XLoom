import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentHandoff, BoardSnapshot, LoopEvent, RuntimeEvent, Usage } from "../types.js";
import type { AuthInteraction } from "@earendil-works/pi-ai";

export type ModelRole = "all" | "chat" | "decide" | "execute";
export type SettingsCommand = "model" | "apikey" | "login" | "logout";
export interface SessionInfo { mode: "chat" | "run"; busy: boolean; model: string; status?: string; usage?: Usage }

export interface UiController {
  snapshot(): BoardSnapshot;
  subscribe(listener: (event: LoopEvent) => void): () => void;
  start(): Promise<void>;
  pause(): void;
  stop(): void;
  hint(content: string): void;
  requestMetacog(): void;
  waitForIdle?(): Promise<void>;
  chat?(text: string): Promise<void>;
  runGoal?(goal: string): Promise<void>;
  resetChat?(): void;
  getSessionInfo?(): SessionInfo;
  getModels?(): Promise<{ provider: string; model: string; name: string }[]>;
  getProviders?(): Promise<{ id: string; name: string; authTypes: string[] }[]>;
  selectModel?(provider: string, model: string, role?: ModelRole, signal?: AbortSignal): Promise<void>;
  saveApiKey?(provider: string, key: string, signal?: AbortSignal): Promise<void>;
  login?(provider: string, interaction: AuthInteraction): Promise<void>;
  logout?(provider: string, signal?: AbortSignal): Promise<void>;
}

export const HELP = [
  "普通输入：和模型聊天，可使用 read / write / edit / powershell；/new 清空聊天",
  "/run 目标  新建双 Agent 任务（不读取聊天历史）",
  "/start  开始 / 继续    /pause  暂停    /stop  停止",
  "/hint 内容  写入黑板    /meta  请求元认知    /board  查看黑板",
  "/help  帮助    /exit 或 /quit  退出",
  "/model [all|chat|decide|execute]  搜索切换模型；默认应用所有角色",
  "/apikey [provider]  私密输入 API Key    /login [provider]  订阅登录    /logout [provider]  移除本地凭据",
  "普通聊天与黑板隔离；补充任务信息请显式使用 /hint。设置期间 Esc 取消。",
  "Enter 提交 · Alt+Enter / Shift+Enter 换行 · ↑/↓ 上一条 / 下一条输入（保留草稿）",
  "Alt+↑/↓ 多行光标移动 · Ctrl+P/N 也可切换历史输入",
  "Ctrl+C：有内容先清空；空输入框 2 秒内连续按两次退出（不会先暂停）",
  "选中即复制；Ctrl+Shift+C / Ctrl+Insert 复制，Ctrl+C 不再用于复制",
  "Ctrl+Shift+C / Ctrl+Insert 复制选择或输入 · Ctrl+V / Shift+Insert / 右键粘贴",
  "应用剪贴板粘贴不会自动提交；终端原生粘贴需支持括号粘贴协议",
  "滚轮 / PageUp / PageDown 滚动会话 · End 回到底部并恢复跟随 · Ctrl+Shift+F 搜索",
].join("\n");

// Tool output and remote content must never become terminal control sequences.
export function plainText(value: string): string {
  return stripTerminalSequences(value).replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function compact(value: string, limit = 180): string {
  const clean = plainText(value).replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function fitLines(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const clean = plainText(value);
  if (width === 1) return clean.split("\n").map((line) => truncateToWidth(line, width, ""));
  return wrapTextWithAnsi(clean, width).map((line) => truncateToWidth(line, width, ""));
}

export function statusLine(board: BoardSnapshot, session?: SessionInfo): string {
  if (session?.mode === "chat") return `chat · ${session.status ?? (session.busy ? "running" : "idle")} · ${compact(session.model, 120)}` +
    (session.usage ? ` · ${(session.usage.input + session.usage.output).toLocaleString("en-US")} tokens · $${session.usage.cost.toFixed(3)}` : "");
  const tokens = board.usage.input + board.usage.output;
  return `${session ? "run · " : ""}${board.status} · r${board.revision} · step ${board.completedSteps}` +
    ` · ${tokens.toLocaleString("en-US")} tokens · $${board.usage.cost.toFixed(3)}` +
    (board.outcome ? ` · ${board.outcome}` : "");
}

export function formatBoard(board: BoardSnapshot): string {
  const lines = [statusLine(board), `目标：${compact(board.config.goal, 300)}`];
  if (board.reason) lines.push(`状态：${compact(board.reason, 300)}`);
  const section = <T>(title: string, values: T[], count: number, format: (value: T) => string): void => {
    lines.push("", `${title} (${values.length})`);
    if (!values.length) lines.push("  —");
    else {
      if (values.length > count) lines.push(`  … 仅显示最近 ${count} 条`);
      lines.push(...values.slice(-count).map((item) => `  ${format(item)}`));
    }
  };
  section("Goals", board.goals, 8, (g) => `${g.id} [${g.status}] ${compact(g.description)}`);
  section("Facts", board.facts, 10, (f) => `${f.id} ${compact(f.description)} → ${f.evidenceIds.join(", ") || "无证据引用"}`);
  section("Steps", board.steps, 10, (s) => `${s.id} [${s.status}] ${s.goalId} ← ${s.from.join(",") || "—"} · ${compact(s.description)}`);
  section("Findings", board.findings, 8, (f) => `${f.id} [${f.status}/${f.rating}] ${compact(f.title)}\n    evidence: ${f.evidenceIds.join(", ") || "—"}\n    next: ${compact(f.next)}`);
  section("Evidence", board.evidence, 8, (e) => `${e.id} ${compact(e.path)} · sha256:${e.sha256.slice(0, 12)}`);
  section("Hints", board.hints, 4, (h) => `${h.id} ${compact(h.content)}`);
  return lines.join("\n");
}

export interface FeedEntry { label: string; text: string; key?: string; error?: boolean }

/** UI-only event feed. It is never passed back to either Agent. */
export class EventFeed {
  readonly entries: FeedEntry[] = [];
  constructor(private readonly maxEntries = 160, private readonly maxText = 3200) {}

  add(label: string, text: string, error = false): void {
    this.entries.push({ label, text: plainText(text).slice(0, 9000), error });
    this.trim();
  }

  handoff(event: AgentHandoff): void {
    this.breakStream();
    const label = event.mode === "metacog" ? "Decide · Meta" : event.role === "execute" ? "Execute" : "Decide";
    this.add(label, `r${event.revision} · ${event.trigger.kind}${event.stepId ? ` · ${event.stepId}` : ""}\n${event.trigger.reason}`);
  }

  runtime(event: RuntimeEvent): void {
    const label = event.mode === "chat" ? "Assistant" : event.mode === "metacog" ? "Decide · Meta" : event.mode === "decide" ? "Decide" : "Execute";
    if (event.type === "text") {
      const last = this.entries.at(-1);
      if (last?.label === label && last.key === "stream") {
        const joined = last.text + plainText(event.text);
        last.text = joined.length > this.maxText ? `…${joined.slice(-this.maxText)}` : joined;
      } else {
        this.entries.push({ label, text: plainText(event.text).slice(-this.maxText), key: "stream" });
      }
    } else if (event.type === "notice") {
      this.add(label, compact(event.text, 700), event.isError);
    } else {
      const key = `tool:${event.toolCallId ?? event.toolName ?? "unknown"}`;
      const existing = this.entries.findLast((entry) => entry.key === key);
      const state = event.type === "tool_start" ? "running" : event.type === "tool_end" ? (event.isError ? "error" : "done") : "running";
      const entry = existing ?? { key, label: `${label} · ${event.toolName ?? "tool"}`, text: "" };
      entry.text = `[${state}] ${compact(event.text, 240)}`;
      entry.error = event.isError;
      if (!existing) this.entries.push(entry);
    }
    this.trim();
  }

  breakStream(): void {
    const last = this.entries.at(-1);
    if (last?.key === "stream") delete last.key;
  }

  private trim(): void {
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}

export interface CommandActions {
  start(): void;
  quit(): void;
  print(label: string, text: string): void;
  chat?(text: string): void;
  run?(goal: string): void;
  settings?(command: SettingsCommand, argument: string): void;
}

/** Credential commands and accidental inline credentials never enter editor history. */
export function recordCommandHistory(input: string): boolean {
  return !/^\/(?:apikey|login)\b/i.test(input.trim());
}

/** Synchronous dispatch keeps input responsive while the loop runs. */
export function dispatchCommand(input: string, controller: UiController, actions: CommandActions): void {
  const value = input.trim();
  if (!value) return;
  if (!value.startsWith("/")) {
    if (actions.chat && controller.chat) actions.chat(value);
    else actions.print("xloom", "当前演示未连接聊天模型；使用 run 启动真实 TUI。任务补充请使用 /hint。");
    return;
  }
  const [command, ...rest] = value.split(/\s+/);
  const argument = value.slice(command!.length).trim();
  if (rest.length && !["/hint", "/run", "/model", "/apikey", "/login", "/logout"].includes(command!)) {
    actions.print("xloom", `命令 ${command} 不接受参数。`);
    return;
  }
  switch (command) {
    case "/run":
      if (!argument) actions.print("xloom", "用法：/run 目标和目标范围");
      else if (actions.run && controller.runGoal) actions.run(argument);
      else actions.print("xloom", "当前演示不支持新建真实任务。请使用 run 启动真实 TUI。");
      break;
    case "/new":
      if (controller.resetChat) { controller.resetChat(); actions.print("xloom", "已清空普通聊天；任务黑板保留。"); }
      else actions.print("xloom", "当前演示没有普通聊天会话。");
      break;
    case "/model":
      if (argument && !["all", "chat", "decide", "execute"].includes(argument)) actions.print("xloom", "用法：/model [all|chat|decide|execute]");
      else if (actions.settings) actions.settings("model", argument);
      else actions.print("xloom", "当前模式不支持模型设置。");
      break;
    case "/apikey":
    case "/login":
    case "/logout":
      if (rest.length > 1) actions.print("xloom", "只填写 provider；API Key 和登录码请在私密输入框中输入，不要放在命令里。");
      else if (actions.settings) actions.settings(command.slice(1) as SettingsCommand, argument);
      else actions.print("xloom", "当前模式不支持凭据设置。");
      break;
    case "/start": actions.start(); break;
    case "/pause": controller.pause(); actions.print("xloom", "已请求暂停；正在取消当前运行。"); break;
    case "/stop": controller.stop(); actions.print("xloom", "已请求停止；黑板与证据保留。"); break;
    case "/meta": controller.requestMetacog(); actions.print("xloom", "已请求 Decide 在下一调度点进行元认知复核。"); break;
    case "/hint":
      if (!argument) actions.print("xloom", "用法：/hint 补充信息");
      else { controller.hint(argument); actions.print("You → Blackboard", argument); }
      break;
    case "/board": actions.print("Blackboard", formatBoard(controller.snapshot())); break;
    case "/help": actions.print("xloom", HELP); break;
    case "/exit":
    case "/quit": actions.quit(); break;
    default: actions.print("xloom", `未知命令 ${compact(command ?? "")}。使用 /help 查看命令。`);
  }
}
