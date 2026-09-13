import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class FileLock {
  private readonly file: string;
  private readonly token = randomUUID();
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
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
