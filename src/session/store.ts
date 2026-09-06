import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentRole, RoleCursor } from '../case/types.js';
import { publicModelInfo, type ModelInfo } from '../config.js';

export interface SessionMeta {
  schemaVersion?: number; id: string; cwd: string; createdAt: string; title: string;
  updatedAt?: string; lastActivityAt?: string; hasContent?: boolean; lastActiveRole?: AgentRole;
  agents: Partial<Record<AgentRole, string>>; agentSessionIds: Partial<Record<AgentRole, string>>;
  agentCursors: Partial<Record<AgentRole, RoleCursor>>; model: ModelInfo;
}
export type TimelineEntry = { id: string; timestamp: string } & (
  { type: 'user'; content: string } |
  { type: 'message'; agent: AgentRole; entryId: string; runId?: string } |
  { type: 'control'; action: string; agent?: AgentRole; detail?: string });
export function readJsonl<T>(path: string): T[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`必要记录缺失或无法读取：${path}`); }
  if (text && !text.endsWith('\n')) throw new Error(`记录尾行不完整：${path}；原文件保留，停止恢复`);
  return text.split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) as T; } catch { throw new Error(`记录损坏：${path}:${i + 1}；原文件保留，停止恢复`); }
  });
}
export function canonicalCwd(cwd: string) {
  try { const path = realpathSync(resolve(cwd)); if (!statSync(path).isDirectory()) throw new Error(); accessSync(path, constants.R_OK | constants.X_OK); return path; }
  catch { throw new Error(`工作目录不存在或不可用：${cwd}`); }
}
export const validSessionId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function readMetadata(home: string, id: string): SessionMeta {
  if (!validSessionId(id)) throw new Error('需要完整的 XLoom Session UUID');
  const path = join(home, 'sessions', id, 'session.json');
  let meta: SessionMeta;
  try { meta = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`会话不存在或元数据损坏：${path}`); }
  if (meta.id !== id || (meta.schemaVersion !== undefined && meta.schemaVersion !== 1) || !meta.agents?.probe || !meta.agentSessionIds?.probe || !meta.agentCursors || typeof meta.cwd !== 'string' || !meta.model || typeof meta.title !== 'string' || !Number.isFinite(Date.parse(meta.createdAt))) throw new Error(`会话格式不支持或记录不完整：${path}`);
  for (const role of ['probe', 'proof'] as const) if (meta.agents[role] && (meta.agents[role] !== `agents/${role}.jsonl` || !validSessionId(meta.agentSessionIds[role] ?? ''))) throw new Error(`角色引用无效：${path} (${role})`);
  return meta;
}
export function listSessions(home: string, cwd?: string): SessionMeta[] {
  const dir = join(home, 'sessions'); if (!existsSync(dir)) return [];
  const wanted = cwd && canonicalCwd(cwd);
  return readdirSync(dir).flatMap((id) => {
    try {
      const meta = readMetadata(home, id);
      if (meta.hasContent === undefined) {
        const path = join(dir, id, 'blackboard/events.jsonl');
        const events = existsSync(path) ? readJsonl<{ timestamp: string; type: string }>(path) : [];
        meta.hasContent = events.some((e) => e.type === 'case_created');
        meta.lastActivityAt = events.filter((e) => ['case_created', 'hint_added', 'agent_committed', 'run_started'].includes(e.type)).at(-1)?.timestamp;
      }
      return (!wanted || meta.cwd === wanted) ? [meta] : [];
    } catch { return []; }
  }).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.id.localeCompare(b.id));
}
export function recentSession(home: string, cwd: string) {
  const item = listSessions(home, cwd).find((m) => m.hasContent && m.lastActivityAt);
  if (!item) throw new Error(`当前目录没有可继续的实际工作会话：${canonicalCwd(cwd)}`);
  return item.id;
}
function processIdentity(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
function acquire(dir: string): () => void {
  const path = join(dir, '.writer-lock.json'), guard = join(dir, '.writer-lock.guard');
  // Serialize acquisition/reclamation. An uncertain leftover guard is never stolen.
  try { writeFileSync(guard, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error(`会话占用检查正在进行或状态无法确认：${guard}`); }
  const token = randomUUID();
  try {
    if (existsSync(path)) {
      let owner: { pid: number; identity: string };
      try { owner = JSON.parse(readFileSync(path, 'utf8')); if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.identity) throw new Error(); }
      catch { throw new Error(`会话占用记录无法确认：${path}`); }
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw new Error(`无法确认会话进程 ${owner.pid} 的状态`); }
      if (alive) {
        let identity: string;
        try { identity = processIdentity(owner.pid); } catch { throw new Error(`无法确认会话进程 ${owner.pid} 的身份`); }
        if (identity === owner.identity) throw new Error(`会话正在由进程 ${owner.pid} 使用：${dir}`);
      }
      unlinkSync(path);
    }
    writeFileSync(path, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), token }), { flag: 'wx', mode: 0o600 });
  } finally { unlinkSync(guard); }
  return () => { if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path); };
}
export class Session {
  readonly transcriptPath: string;
  readonly timelinePath: string;
  readonly timeline: TimelineEntry[];
  private failed = false;
  private released = false;
  private readonly unlock: () => void;
  constructor(readonly metadata: SessionMeta, readonly dir: string, timeline?: TimelineEntry[], readonly restored = false) {
    this.unlock = acquire(dir);
    this.transcriptPath = join(dir, 'agents/probe.jsonl'); this.timelinePath = join(dir, 'timeline.jsonl');
    this.timeline = timeline ?? [];
  }
  private writable() { if (this.released || this.failed) throw new Error('会话已释放或保存失败，停止继续写入'); }
  assertSaved() { this.writable(); }
  save() {
    this.writable(); const temp = join(this.dir, 'session.json.tmp');
    try { this.metadata.updatedAt = new Date().toISOString(); writeFileSync(temp, JSON.stringify(this.metadata, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, join(this.dir, 'session.json')); }
    catch (e) { this.failed = true; throw e; }
  }
  append(entry: TimelineEntry) {
    this.writable();
    try { appendFileSync(this.timelinePath, JSON.stringify(entry) + '\n', { mode: 0o600 }); this.timeline.push(entry); }
    catch (e) { this.failed = true; throw e; }
  }
  recordUser(content: string, id: string = randomUUID(), activity = true) {
    if (!this.timeline.some((e) => e.id === id)) this.append({ type: 'user', id, content, timestamp: new Date().toISOString() });
    if (activity) this.activity(); return id;
  }
  control(action: string, agent?: AgentRole, detail?: string) { this.append({ type: 'control', id: randomUUID(), timestamp: new Date().toISOString(), action, agent, detail }); }
  message(agent: AgentRole, entryId: string, runId?: string) { this.append({ type: 'message', id: randomUUID(), timestamp: new Date().toISOString(), agent, entryId, runId }); }
  activity(role?: AgentRole) { this.metadata.hasContent = true; this.metadata.lastActivityAt = new Date().toISOString(); if (role) this.metadata.lastActiveRole = role; this.save(); }
  ensureAgent(role: AgentRole) {
    if (!this.metadata.agents[role]) {
      this.writable(); const id = randomUUID(), path = `agents/${role}.jsonl`;
      writeFileSync(join(this.dir, path), JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: this.metadata.cwd }) + '\n', { flag: 'wx', mode: 0o600 });
      this.metadata.agents[role] = path; this.metadata.agentSessionIds[role] = id;
      this.metadata.agentCursors[role] = { lastSeenRevision: 0, deliveredHintIds: [], deliveredMessageIds: [] }; this.save();
    }
    return { id: this.metadata.agentSessionIds[role]!, path: join(this.dir, this.metadata.agents[role]!) };
  }
  saveCursor(role: AgentRole, cursor: RoleCursor) { this.metadata.agentCursors[role] = structuredClone(cursor); this.save(); }
  setTitle(text: string) { if (!this.metadata.title) { this.metadata.title = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 80).join(''); this.save(); } }
  release() { if (!this.released) { this.unlock(); this.released = true; } }
}
export function createSession(cwd: string, model: ModelInfo, home: string) {
  const id = randomUUID(), dir = join(home, 'sessions', id);
  mkdirSync(join(dir, 'agents'), { recursive: true, mode: 0o700 });
  const session = new Session({ schemaVersion: 1, id, cwd: canonicalCwd(cwd), createdAt: new Date().toISOString(), title: '', hasContent: false,
    agents: {}, agentSessionIds: {}, agentCursors: {}, model: publicModelInfo(model) }, dir);
  try { writeFileSync(session.timelinePath, '', { flag: 'wx', mode: 0o600 }); session.ensureAgent('probe'); return session; }
  catch (e) { session.release(); throw e; }
}
