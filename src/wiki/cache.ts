import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { wikiDigest } from "./model.js";

export interface IndexStats {
  storage: "persistent" | "memory"; added: number; updated: number; reused: number; removed: number;
  indexedBytes: number; verifiedOriginals: number; fallbackReason?: string;
}
export const indexStats = (): IndexStats => ({ storage: "persistent", added: 0, updated: 0, reused: 0, removed: 0, indexedBytes: 0, verifiedOriginals: 0 });

/** Disposable term projections only. Never writes to the authoritative board.
 * Unknown, damaged or foreign caches are preserved and bypassed. */
export function withIndexCache<T>(dataDir: string, workspace: string, work: (db: DatabaseSync, stats: IndexStats) => T): T {
  let db: DatabaseSync | undefined;
  const stats = indexStats();
  const schema = `CREATE TABLE owner(version INTEGER, scope TEXT);
    CREATE TABLE entries(namespace TEXT,key TEXT,signature TEXT,payload TEXT,PRIMARY KEY(namespace,key));
    CREATE TABLE terms(namespace TEXT,term TEXT,key TEXT,unit INTEGER,PRIMARY KEY(namespace,term,key,unit));`;
  try {
    // A read of a nonexistent task must not create it (CLI/tests may use virtual boards).
    if (!existsSync(dataDir) || lstatSync(dataDir).isSymbolicLink()) throw new Error("Task directory is unavailable or linked");
    const root = join(dataDir, "cache");
    if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) throw new Error("Cache directory is unavailable or linked");
    mkdirSync(root, { recursive: true });
    const path = join(root, "retrieval.sqlite"), fresh = !existsSync(path);
    if (!fresh && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error("Cache file is unavailable or linked");
    const scope = wikiDigest([realpathSync(dataDir), realpathSync(workspace)]);
    if (!fresh) {
      // Inspect identity read-only before allowing any writes to an existing file.
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        const owner = check.prepare("SELECT version,scope FROM owner").all();
        if (owner.length !== 1 || owner[0]!.version !== 1 || owner[0]!.scope !== scope) throw new Error("Foreign or unsupported retrieval cache");
        check.prepare("SELECT namespace,key,signature,payload FROM entries LIMIT 0").all();
        check.prepare("SELECT namespace,term,key,unit FROM terms LIMIT 0").all();
      } finally { check.close(); }
    }
    db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout=1500");
    if (fresh) { db.exec(schema); db.prepare("INSERT INTO owner VALUES(1,?)").run(scope); }
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db?.close(); db = undefined;
    stats.storage = "memory"; stats.fallbackReason = (error as Error).message;
  }
  const run = (database: DatabaseSync) => { const result = work(database, stats); database.exec("COMMIT"); return result; };
  if (db) {
    try { return run(db); }
    catch (error) {
      // Cache failures must not invalidate public records. Recompute from sources.
      try { db.exec("ROLLBACK"); } catch { /* closed/broken transaction */ }
      Object.assign(stats, indexStats(), { storage: "memory", fallbackReason: (error as Error).message });
    } finally { db.close(); }
  }
  const memory = new DatabaseSync(":memory:");
  try { memory.exec(schema); memory.exec("BEGIN"); return run(memory); }
  finally { memory.close(); }
}

export function cachedEntry<T>(db: DatabaseSync, namespace: string, key: string): { signature: string; value: T } | undefined {
  const row = db.prepare("SELECT signature,payload FROM entries WHERE namespace=? AND key=?").get(namespace, key);
  return row ? { signature: String(row.signature), value: JSON.parse(String(row.payload)) as T } : undefined;
}
/** One indexed read for the namespace, rather than prepare/get per record. */
export function cachedEntries<T>(db: DatabaseSync, namespace: string): Map<string, { signature: string; value: T }> {
  return new Map(db.prepare("SELECT key,signature,payload FROM entries WHERE namespace=?").all(namespace)
    .map(row => [String(row.key), { signature: String(row.signature), value: JSON.parse(String(row.payload)) as T }]));
}
export function removeEntry(db: DatabaseSync, namespace: string, key: string): void {
  db.prepare("DELETE FROM terms WHERE namespace=? AND key=?").run(namespace, key);
  db.prepare("DELETE FROM entries WHERE namespace=? AND key=?").run(namespace, key);
}
export function pruneEntries(db: DatabaseSync, namespace: string, keys: Set<string>): number {
  let count = 0;
  for (const row of db.prepare("SELECT key FROM entries WHERE namespace=?").all(namespace)) if (!keys.has(String(row.key))) { removeEntry(db, namespace, String(row.key)); count++; }
  return count;
}
export function putEntry(db: DatabaseSync, namespace: string, key: string, signature: string, value: unknown, units: string[][]): void {
  removeEntry(db, namespace, key);
  db.prepare("INSERT INTO entries VALUES(?,?,?,?)").run(namespace, key, signature, JSON.stringify(value));
  const insert = db.prepare("INSERT OR IGNORE INTO terms VALUES(?,?,?,?)");
  units.forEach((terms, unit) => terms.forEach(term => insert.run(namespace, term, key, unit)));
}
