import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BoardSnapshot } from "./types.js";

export function taskDirectory(workspace: string, taskId?: string): string {
  if (taskId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error("Invalid task ID.");
  return taskId ? path.join(workspace, ".xloom", "tasks", taskId) : path.join(workspace, ".xloom");
}

export function currentTaskId(workspace: string): string | undefined {
  const file = path.join(workspace, ".xloom", "current-task.json");
  if (!existsSync(file)) return undefined;
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || !("taskId" in value) || typeof value.taskId !== "string") throw new Error("Invalid current task pointer.");
  taskDirectory(workspace, value.taskId);
  return value.taskId;
}

export function selectTask(workspace: string, taskId: string): void {
  taskDirectory(workspace, taskId);
  const file = path.join(workspace, ".xloom", "current-task.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ taskId }), { flag: "wx" });
  renameSync(temporary, file);
}

export function readSavedBoard(workspace: string, taskId = currentTaskId(workspace)): BoardSnapshot {
  const file = path.join(taskDirectory(workspace, taskId), "blackboard.sqlite");
  if (!existsSync(file)) throw new Error("No blackboard yet. Use /run with a goal, or initialize a headless task first.");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM board WHERE id=1").get();
    if (!row) throw new Error("Blackboard is empty.");
    return JSON.parse(String(row.value)) as BoardSnapshot;
  } finally { db.close(); }
}

/** One active application per target workspace, including independently stored tasks. */
export class WorkspaceLock {
  private readonly file: string;
  private readonly token = randomUUID();
  constructor(workspace: string) {
    const dir = path.join(workspace, ".xloom");
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "session.lock");
    this.acquire();
  }
  private acquire(): void {
    try {
      const fd = openSync(this.file, "wx");
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token })); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-lock recovery. Re-read under this guard: another process
      // may already have replaced the stale owner with a live session.
      const recovery = `${this.file}.recovery`;
      let fd: number;
      try { fd = openSync(recovery, "wx"); }
      catch { throw new Error("Another process is checking the xloom session lock; retry after it finishes. An abandoned recovery lock requires manual inspection."); }
      let stale = false;
      try {
        if (!existsSync(this.file)) stale = true;
        else {
          let previous: { pid?: number };
          try { previous = JSON.parse(readFileSync(this.file, "utf8")); } catch { throw new Error("Unreadable xloom session lock; check for an active process before removing it."); }
          if (!Number.isInteger(previous.pid) || previous.pid! <= 0) throw new Error("Invalid xloom session lock; manual inspection required.");
          try { process.kill(previous.pid!, 0); } catch (checkError) {
            if ((checkError as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(this.file); stale = true; }
          }
          if (!stale) throw new Error(`Another xloom session owns this workspace (PID ${previous.pid}).`);
        }
      } finally { closeSync(fd); unlinkSync(recovery); }
      if (stale) this.acquire();
    }
  }
  close(): void {
    try { if (JSON.parse(readFileSync(this.file, "utf8")).token === this.token) unlinkSync(this.file); } catch { /* Never remove an unknown lock. */ }
  }
}
