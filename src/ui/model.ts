import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BoardSnapshot, LoopEvent, RuntimeEvent } from "../types.js";

export interface UiController {
  snapshot(): BoardSnapshot;
  subscribe(listener: (event: LoopEvent) => void): () => void;
  start(): Promise<void>;
  pause(): void;
  stop(): void;
  hint(content: string): void;
  requestMetacog(): void;
  waitForIdle?(): Promise<void>;
}

export const HELP = [
  "/start  开始 / 继续    /pause  暂停    /stop  停止",
  "/hint 内容  写入黑板    /meta  请求元认知    /board  查看黑板",
  "/help  帮助    /quit  退出",
  "普通输入仅作为黑板 Hint；两个 Agent 不共享聊天历史。",
  "Enter 提交 · Alt+Enter 换行 · Esc 暂停 · Ctrl+C 中断，再按退出",
  "PageUp / PageDown 或鼠标滚轮查看历史；Ctrl+Shift+F 搜索。",
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

export function statusLine(board: BoardSnapshot): string {
  const tokens = board.usage.input + board.usage.output;
  return `${board.status} · r${board.revision} · step ${board.completedSteps}/${board.config.limits.maxSteps}` +
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

  runtime(event: RuntimeEvent): void {
    const label = event.mode === "metacog" ? "Decide · Meta" : event.mode === "decide" ? "Decide" : "Execute";
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
}

/** Synchronous dispatch keeps input responsive while the loop runs. */
export function dispatchCommand(input: string, controller: UiController, actions: CommandActions): void {
  const value = input.trim();
  if (!value) return;
  if (!value.startsWith("/")) {
    controller.hint(value);
    actions.print("You → Blackboard", value);
    return;
  }
  const [command, ...rest] = value.split(/\s+/);
  const argument = value.slice(command!.length).trim();
  if (rest.length && command !== "/hint") {
    actions.print("xloom", `命令 ${command} 不接受参数。使用 /hint 写入补充信息。`);
    return;
  }
  switch (command) {
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
    case "/quit": actions.quit(); break;
    default: actions.print("xloom", `未知命令 ${compact(command ?? "")}。使用 /help 查看命令。`);
  }
}
