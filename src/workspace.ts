import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureProject, projectDirectory, workspaceLockPath } from "./paths.js";
import { FileLock } from "./lock.js";
import type { BoardSnapshot } from "./types.js";

export function taskDirectory(workspace: string, taskId?: string): string {
  if (taskId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error("Invalid task ID.");
  return taskId ? path.join(projectDirectory(workspace), "tasks", taskId) : projectDirectory(workspace);
}

export function currentTaskId(workspace: string): string | undefined {
  const file = path.join(projectDirectory(workspace), "current-task.json");
  if (!existsSync(file)) return undefined;
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || !("taskId" in value) || typeof value.taskId !== "string") throw new Error("Invalid current task pointer.");
  taskDirectory(workspace, value.taskId);
  return value.taskId;
}

export function selectTask(workspace: string, taskId: string): void {
  taskDirectory(workspace, taskId);
  ensureProject(workspace);
  const file = path.join(projectDirectory(workspace), "current-task.json");
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
export class WorkspaceLock extends FileLock {
  constructor(workspace: string) { super(workspaceLockPath(workspace)); }
}
