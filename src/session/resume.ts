import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { BlackboardStore } from '../case/store.js';
import { checkEvidenceMaterials } from '../case/context-index.js';
import type { AgentRole, RoleCursor } from '../case/types.js';
import { configSecrets, publicModelInfo, type ActiveConfig } from '../config.js';
import { redactor } from '../log.js';
import { SessionManager } from '../runtime/session.js';
import type { FileEntry, SessionEntry } from '../vendor/pi/coding-agent/core/session-manager.js';
import { canonicalCwd, readJsonl, readMetadata, Session, type TimelineEntry } from './store.js';

export function validateTranscript(path: string, id: string, cwd: string, config: ActiveConfig) {
  const entries = readJsonl<FileEntry>(path);
  const header = entries[0];
  if (!header || header.type !== 'session' || header.version !== 3 || header.id !== id || header.cwd !== cwd) throw new Error(`角色身份、cwd 或 Pi 格式不支持：${path}`);
  const ids = new Set<string>();
  for (const e of entries.slice(1)) {
    if (e.type === 'session' || !e.id || ids.has(e.id) || (e.parentId !== null && !ids.has(e.parentId))) throw new Error(`Pi 条目引用不完整：${path}`);
    if (!['message', 'custom', 'compaction', 'model_change', 'thinking_level_change', 'session_info', 'label'].includes(e.type)) throw new Error(`Pi 条目类型不支持：${path} (${e.type})`);
    if (e.type === 'message') {
      const m = e.message;
      if (!m || !['user', 'assistant', 'toolResult'].includes(m.role) || !('content' in m) || m.content == null || (m.role === 'assistant' && (!Array.isArray(m.content) || !m.usage || !m.stopReason))) throw new Error(`Pi 消息记录不完整：${path}:${e.id}`);
      if (m.role === 'assistant' && (!['openai-completions', 'anthropic-messages', 'openai-responses'].includes(m.api) || !m.provider || !m.model)) throw new Error(`历史消息协议或来源不支持：${path}:${e.id}`);
    }
    if (e.type === 'compaction' && (!ids.has(e.firstKeptEntryId) || !e.summary?.trim())) throw new Error(`Pi 压缩分界无效：${path}:${e.id}`);
    ids.add(e.id);
  }
  return entries.slice(1) as SessionEntry[];
}
export function acceptedCursor(entries: SessionEntry[], hints: Record<string, { messageId: string }>): RoleCursor {
  const cursor: RoleCursor = { lastSeenRevision: 0, deliveredHintIds: [], deliveredMessageIds: [] };
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) if (e.type === 'custom' && e.customType === 'xloom.input-accepted') {
    const d = e.data as { inputId: string; responseEntryId: string; revision: number; messageIds: string[] };
    const input = byId.get(d.inputId), response = byId.get(d.responseEntryId);
    if (input?.type !== 'custom' || input.customType !== 'xloom.input-prepared' || response?.type !== 'message' || response.message.role !== 'assistant' || !['stop', 'toolUse'].includes(response.message.stopReason)) continue;
    if (!Number.isSafeInteger(d.revision) || d.revision < 0 || !Array.isArray(d.messageIds)) continue;
    cursor.lastSeenRevision = Math.max(cursor.lastSeenRevision, d.revision);
    cursor.deliveredMessageIds = [...new Set([...cursor.deliveredMessageIds, ...d.messageIds])];
  }
  cursor.deliveredHintIds = Object.entries(hints).filter(([, h]) => cursor.deliveredMessageIds.includes(h.messageId)).map(([id]) => id);
  return cursor;
}
export function resumeSession(home: string, id: string, config: ActiveConfig) {
  const metadata = readMetadata(home, id), dir = join(home, 'sessions', id);
  metadata.cwd = canonicalCwd(metadata.cwd);
  const session = new Session(metadata, dir, [], true);
  try {
    const entries: Partial<Record<AgentRole, SessionEntry[]>> = {};
    for (const role of ['probe', 'proof'] as const) if (metadata.agents[role]) entries[role] = validateTranscript(join(dir, metadata.agents[role]!), metadata.agentSessionIds[role]!, metadata.cwd, config);
    const timelineExists = existsSync(session.timelinePath);
    if (!timelineExists && metadata.schemaVersion === 1) throw new Error(`必要记录缺失：${session.timelinePath}`);
    let timeline = timelineExists ? readJsonl<TimelineEntry>(session.timelinePath) : [];
    if (!timelineExists) {
      // M2 compatibility: recover original native inputs and source IDs, never summaries.
      const seen = new Set<string>();
      for (const role of ['probe', 'proof'] as const) {
        const source = new Map((entries[role] ?? []).flatMap((e) => e.type === 'custom' && e.customType === 'xloom.input-source' ? [[(e.data as any).messageId, (e.data as any).sourceMessageId] as const] : []));
        for (const e of entries[role] ?? []) if (e.type === 'message' && e.message.role === 'user') {
          const originalId = (e.message as { xloomInputId?: string }).xloomInputId ?? source.get(e.id) ?? e.id;
          if (!seen.has(originalId)) { seen.add(originalId); const c = e.message.content;
            timeline.push({ type: 'user', id: originalId, timestamp: e.timestamp, content: typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') }); }
        }
      }
      timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
    const timelineIds = new Set<string>();
    for (const e of timeline) {
      if (!e.id || timelineIds.has(e.id) || !Number.isFinite(Date.parse(e.timestamp)) || !['user', 'message', 'control'].includes(e.type) || (e.type === 'user' && typeof e.content !== 'string')) throw new Error(`时间线条目无效：${session.timelinePath}`);
      if (e.type === 'message' && !entries[e.agent]?.some((item) => item.id === e.entryId && item.type === 'message')) throw new Error(`时间线消息引用缺失：${session.timelinePath}:${e.id}`);
      timelineIds.add(e.id);
    }
    const eventsPath = join(dir, 'blackboard/events.jsonl');
    if ((metadata.hasContent || metadata.title) && !existsSync(eventsPath) && !timeline.some((e) => e.type === 'user')) throw new Error(`必要黑板记录缺失：${eventsPath}`);
    // A saved goal in metadata/accepted requests cannot be reconstructed from a missing event log.
    if (!existsSync(eventsPath) && Object.values(entries).some((items) => items?.some((e) => e.type === 'custom' && e.customType === 'xloom.capsule'))) throw new Error(`必要黑板记录缺失：${eventsPath}`);
    const store = new BlackboardStore(dir, undefined, redactor(...configSecrets(config))), board = store.current();
    const originals = new Map(timeline.flatMap((e) => e.type === 'user' ? [[e.id, e.content] as const] : []));
    if (board.revision && originals.get(board.goalMessageId) !== board.originalGoal.request) throw new Error(`原始 Goal 输入缺失或不一致：${session.timelinePath}`);
    for (const hint of Object.values(board.hints)) if (originals.get(hint.messageId) !== hint.content) throw new Error(`原始 Hint 输入缺失或不一致：${session.timelinePath}:${hint.messageId}`);
    for (const change of board.goalChanges) if (!originals.has(change.messageId)) throw new Error(`原始 Goal 变更输入缺失：${session.timelinePath}:${change.messageId}`);
    for (const role of ['probe', 'proof'] as const) {
      if (board.agentSessions[role] && !entries[role]) throw new Error(`必要角色记录缺失：${role}`);
      const sources = new Map((entries[role] ?? []).flatMap((e) => e.type === 'custom' && e.customType === 'xloom.input-source' ? [[(e.data as any).messageId, (e.data as any).sourceMessageId] as const] : []));
      for (const e of entries[role] ?? []) if (e.type === 'message' && e.message.role === 'user') {
        const id = (e.message as { xloomInputId?: string }).xloomInputId ?? sources.get(e.id);
        if (id && (!originals.has(id) || (typeof e.message.content === 'string' && originals.get(id) !== e.message.content))) throw new Error(`Pi 输入来源缺失或不一致：${session.timelinePath}:${id}`);
      }
    }
    for (const role of ['probe', 'proof'] as const) if (board.agentSessions[role] && board.agentSessions[role] !== metadata.agentSessionIds[role]) throw new Error(`黑板与 ${role} Session 身份不符`);
    for (const e of Object.values(board.evidence)) for (const path of e.artifactPaths) {
      const target = resolve(dir, path);
      if (!target.startsWith(dir + sep) || !existsSync(target) || !statSync(target).isFile()) throw new Error(`Evidence ${e.id} 必要材料缺失或引用无效：${target}`);
    }
    for (const evidence of Object.values(board.evidence)) checkEvidenceMaterials(evidence, dir);
    // All essential validation completes before any repairable local projection is written.
    for (const role of ['probe', 'proof'] as const) if (entries[role]) SessionManager.open(join(dir, metadata.agents[role]!)).buildSessionContext();
    session.timeline.push(...timeline);
    if (!timelineExists) writeFileSync(session.timelinePath, timeline.map((e) => JSON.stringify(e) + '\n').join(''), { flag: 'wx', mode: 0o600 });
    for (const e of timeline) if (e.type === 'user') {
      const b = store.current();
      if (!b.revision && /^\s*(继续|continue)\s*$/i.test(e.content)) continue;
      if (!b.revision) store.create(e.content, e.id);
      else if (e.id !== b.goalMessageId && !Object.values(b.hints).some((h) => h.messageId === e.id) && !/^\s*(继续|continue)\s*$/i.test(e.content)) store.addHint(e.content, e.id);
      const change = /^(?:修改目标|更改目标|change goal)\s*[:：]\s*([\s\S]+)$/i.exec(e.content.trim());
      if (change && !store.current().goalChanges.some((c) => c.messageId === e.id)) store.changeGoal(change[1], e.id);
    }
    for (const role of ['probe', 'proof'] as const) if (entries[role]) {
      const cursor = acceptedCursor(entries[role]!, store.current().hints);
      store.restoreCursor(role, cursor); metadata.agentCursors[role] = cursor;
    }
    for (const run of Object.values(store.current().runs)) if (run.status === 'running') {
      const pending = store.current().intents[run.intentId]?.state === 'running';
      store.endRun(run.id, '进程中断；已发生工具动作结果可能未知，先观察当前状态，不自动重放', true);
      if (pending) store.reopen(run.intentId, '恢复中断任务；等待显式输入，以新 Run 判断');
    }
    if (store.current().revision && store.current().execution !== 'paused') store.execution('paused', store.current().outcome, '会话已恢复，等待输入');
    store.rebuildView();
    metadata.schemaVersion = 1; metadata.model = publicModelInfo(config); metadata.hasContent = !!store.current().revision;
    metadata.lastActiveRole = Object.values(store.current().runs).at(-1)?.agent ?? metadata.lastActiveRole;
    if (!metadata.title && store.current().revision) metadata.title = Array.from(redactor(config.apiKey)(store.current().originalGoal.request).replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
    if (metadata.hasContent) metadata.lastActivityAt ??= timeline.filter((e) => e.type === 'user').at(-1)?.timestamp;
    session.save(); session.control('resumed', undefined, '等待输入');
    return { session, store };
  } catch (e) { session.release(); throw e; }
}
