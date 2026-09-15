import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  if (value && typeof value === "object" && "taskId" in value && value.taskId === null) return undefined;
  if (!value || typeof value !== "object" || !("taskId" in value) || typeof value.taskId !== "string") throw new Error("Invalid current task pointer.");
  taskDirectory(workspace, value.taskId);
  return value.taskId;
}

export function selectTask(workspace: string, taskId: string | null): void {
  taskDirectory(workspace, taskId ?? undefined);
  ensureProject(workspace);
  const file = path.join(projectDirectory(workspace), "current-task.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ taskId }), { flag: "wx" });
  renameSync(temporary, file);
}

export function readSavedBoard(workspace: string, taskId: string | null = currentTaskId(workspace) ?? null): BoardSnapshot {
  const file = path.join(taskDirectory(workspace, taskId ?? undefined), "blackboard.sqlite");
  if (!existsSync(file)) throw new Error("No blackboard yet. Use /run with a goal, or initialize a headless task first.");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM board WHERE id=1").get();
    if (!row) throw new Error("Blackboard is empty.");
    return JSON.parse(String(row.value)) as BoardSnapshot;
  } finally { db.close(); }
}

export interface TaskInfo {
  id: string; directory: string; selected: boolean; goal?: string; status?: string; error?: string;
}

/** Inventory only: never recover runs, acquire a controller lock or rebuild Wiki. */
export function listTasks(workspace: string, selected: string | null = currentTaskId(workspace) ?? "@legacy"): TaskInfo[] {
  const project = projectDirectory(workspace);
  const root = path.join(project, "tasks");
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("Task directory cannot be a symbolic link.");
  const ids = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)).map(entry => entry.name) : [];
  if (existsSync(path.join(project, "blackboard.sqlite"))) ids.push("@legacy");
  return ids.sort().map(id => {
    const directory = taskDirectory(workspace, id === "@legacy" ? undefined : id);
    const item: TaskInfo = { id, directory, selected: id === selected };
    try {
      const file = path.join(directory, "blackboard.sqlite");
      if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) throw new Error("Invalid task database.");
      const board = readSavedBoard(workspace, id === "@legacy" ? null : id);
      return { ...item, goal: board.config.goal, status: board.status };
    } catch { return { ...item, error: "任务数据库不可读取；原件保留。" }; }
  });
}

/** One active application per target workspace, including independently stored tasks. */
export class WorkspaceLock extends FileLock {
  constructor(workspace: string) { super(workspaceLockPath(workspace)); }
}
