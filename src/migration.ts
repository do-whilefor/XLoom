import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, saveNewConfig } from "./config.js";
import { FileLock } from "./lock.js";
import { atomicJson, ensureProject, projectDirectory, workspaceIdentity, xloomHome } from "./paths.js";
import { renderBlackboard } from "./store.js";
import { WorkspaceLock } from "./workspace.js";
import type { BoardSnapshot } from "./types.js";

function copyTree(source: string, destination: string, omitted: Set<string>): void {
  if (omitted.has(source)) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Legacy data contains a symbolic link; migration stopped: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) copyTree(path.join(source, entry), path.join(destination, entry), omitted);
  } else if (stat.isFile()) copyFileSync(source, destination);
  else throw new Error(`Unsupported legacy data file: ${source}`);
}

function verifyAndRebase(db: DatabaseSync, oldTask: string, newTask: string, workspace: string, publishedTask: string): void {
  if (Object.values(db.prepare("PRAGMA quick_check").get() ?? {})[0] !== "ok") throw new Error("Legacy blackboard integrity check failed.");
  const row = db.prepare("SELECT value FROM board WHERE id=1").get();
  if (!row) throw new Error("Legacy blackboard is empty.");
  const board = JSON.parse(String(row.value)) as BoardSnapshot;
  for (const evidence of board.evidence) {
    const source = realpathSync(path.resolve(evidence.pathBase === "task" ? oldTask : workspace, evidence.path));
    const archiveRoot = realpathSync(path.join(oldTask, "evidence"));
    const relative = path.relative(archiveRoot, source);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Legacy evidence escaped its archive: ${evidence.id}`);
    const archivePath = path.join("evidence", relative);
    const copied = readFileSync(path.join(newTask, archivePath));
    if (copied.length !== evidence.bytes || createHash("sha256").update(copied).digest("hex") !== evidence.sha256) {
      throw new Error(`Legacy evidence integrity failure: ${evidence.id}. Original data retained.`);
    }
    evidence.path = archivePath.replaceAll("\\", "/");
    evidence.pathBase = "task";
  }
  board.revision++;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE board SET value=? WHERE id=1").run(JSON.stringify(board));
    db.prepare("INSERT INTO events (at,kind,payload) VALUES (?,?,?)").run(new Date().toISOString(), "storage_migrated", JSON.stringify({ version: 1, source: oldTask, evidenceBase: "task" }));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  writeFileSync(path.join(newTask, "blackboard.md"), renderBlackboard(board, publishedTask, workspace));
}

/** Publish a verified copy atomically. Never delete or execute anything from legacy data. */
export async function migrateWorkspace(workspace: string): Promise<boolean> {
  const identity = workspaceIdentity(workspace);
  workspace = identity.workspace;
  const destination = projectDirectory(workspace);
  const legacy = path.join(workspace, ".xloom");
  const legacyConfig = path.join(workspace, "xloom.json");
  if (existsSync(path.join(destination, "project.json"))) { ensureProject(workspace); return false; }
  const comparable = (value: string) => {
    const canonical = existsSync(value) ? realpathSync(value) : path.resolve(value);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  // Starting in the user's home must not mistake the global .xloom for old project data.
  const isGlobalHome = comparable(legacy) === comparable(xloomHome());
  if (isGlobalHome && (existsSync(path.join(legacy, "blackboard.sqlite")) || existsSync(path.join(legacy, "current-task.json")))) {
    throw new Error("XLOOM_HOME points at legacy project data; choose a separate user data directory before migrating.");
  }
  const hasLegacy = existsSync(legacy) && !isGlobalHome;
  if (!hasLegacy && !existsSync(legacyConfig)) return false;
  const lock = new WorkspaceLock(workspace);
  const oldLocks: FileLock[] = [];
  const staging = path.join(path.dirname(destination), `.migration-${randomUUID()}`);
  try {
    if (existsSync(path.join(destination, "project.json"))) { ensureProject(workspace); return false; }
    if (existsSync(destination)) throw new Error(`Unregistered project directory already exists: ${destination}`);
    const databaseDirs: string[] = [];
    const omitted = new Set<string>();
    if (hasLegacy) {
      if (lstatSync(legacy).isSymbolicLink()) throw new Error("Legacy .xloom cannot be a symbolic link.");
      const stagingRelative = path.relative(realpathSync(legacy), path.resolve(staging));
      if (stagingRelative !== ".." && !stagingRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(stagingRelative)) {
        throw new Error("XLOOM_HOME cannot be inside the legacy .xloom directory being migrated.");
      }
      const sessionLock = path.join(legacy, "session.lock");
      oldLocks.push(new FileLock(sessionLock));
      omitted.add(sessionLock); omitted.add(`${sessionLock}.recovery`);
      if (existsSync(path.join(legacy, "blackboard.sqlite"))) databaseDirs.push(legacy);
      const tasks = path.join(legacy, "tasks");
      if (existsSync(tasks)) {
        if (lstatSync(tasks).isSymbolicLink()) throw new Error("Legacy tasks cannot be a symbolic link.");
        for (const entry of readdirSync(tasks, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) throw new Error("Invalid legacy task directory.");
          const directory = path.join(tasks, entry.name);
          if (entry.isDirectory() && existsSync(path.join(directory, "blackboard.sqlite"))) databaseDirs.push(directory);
        }
      }
      const pointer = path.join(legacy, "current-task.json");
      if (existsSync(pointer)) {
        const value = JSON.parse(readFileSync(pointer, "utf8"));
        if (typeof value?.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.taskId)) throw new Error("Invalid task ID.");
        if (!databaseDirs.includes(path.join(tasks, value.taskId))) throw new Error("No blackboard yet for the selected legacy task.");
      }
      for (const directory of databaseDirs) {
        if (lstatSync(path.join(directory, "blackboard.sqlite")).isSymbolicLink()) throw new Error("Legacy blackboard cannot be a symbolic link.");
        const controllerLock = path.join(directory, "controller.lock");
        oldLocks.push(new FileLock(controllerLock));
        omitted.add(controllerLock); omitted.add(`${controllerLock}.recovery`);
        for (const suffix of ["", "-wal", "-shm"]) omitted.add(path.join(directory, `blackboard.sqlite${suffix}`));
      }
      copyTree(legacy, staging, omitted);
    } else mkdirSync(staging, { recursive: true });
    for (const directory of databaseDirs) {
      const relative = path.relative(legacy, directory);
      const newTask = path.join(staging, relative);
      const file = path.join(newTask, "blackboard.sqlite");
      const source = new DatabaseSync(path.join(directory, "blackboard.sqlite"), { readOnly: true });
      try { await backup(source, file); } finally { source.close(); }
      const copied = new DatabaseSync(file);
      try { verifyAndRebase(copied, directory, newTask, workspace, path.join(destination, relative)); }
      finally { copied.close(); }
    }
    if (existsSync(legacyConfig)) saveNewConfig(path.join(staging, "settings.json"), loadConfig(legacyConfig));
    atomicJson(path.join(staging, "project.json"), { version: 1, ...identity, name: path.basename(workspace), migratedFrom: legacy, migratedAt: new Date().toISOString() });
    renameSync(staging, destination);
    return true;
  } finally {
    // Only remove our exact generated staging child; source and published data stay intact.
    if (existsSync(staging) && path.dirname(path.resolve(staging)) === path.dirname(path.resolve(destination)) && path.basename(staging).startsWith(".migration-")) {
      rmSync(staging, { recursive: true, force: true });
    }
    for (const old of oldLocks.reverse()) old.close();
    lock.close();
  }
}
