import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { BoardState, Evidence } from './types.js';

export const PROJECTION_POLICY = Object.freeze({ version: 'b2-projection-v2', workingBytes: 8_192, indexBytes: 2_048, pageBytes: 8_192, excerptBytes: 384, directoryExcerptBytes: 96 });
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const compareIds = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
export function excerpt(text: string, limit: number = PROJECTION_POLICY.excerptBytes): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
  let clipped = ''; for (const character of text) { if (Buffer.byteLength(clipped + character) > limit) break; clipped += character; }
  return { text: clipped, truncated: true };
}

/** Deliberately rechecks real files at every projection boundary, including an unchanged revision.
 * Only recorder-provided HTTP hashes are integrity truth; index hashes never invent evidence. */
export function checkEvidenceMaterials(evidence: Evidence, sessionDir: string): void {
  for (const relative of evidence.artifactPaths) {
    const file = resolve(sessionDir, relative);
    if (!existsSync(file)) throw new Error(`Evidence ${evidence.id} 相关材料缺失：${file}；暂停判断`);
    if (!realpathSync(file).startsWith(realpathSync(sessionDir) + sep) || !statSync(file).isFile()) throw new Error(`Evidence ${evidence.id} 材料越出 Session 或不是普通文件：${file}；暂停判断`);
    const expected = (evidence as Evidence & { artifactSha256?: Record<string, string> }).artifactSha256?.[relative];
    if (expected && digest(readFileSync(file)) !== expected) throw new Error(`Evidence ${evidence.id} 原始材料摘要不符：${file}；暂停判断`);
  }
  if (evidence.http) for (const [relative, expected] of [
    [evidence.http.requestArtifact, evidence.http.requestBodySha256], [evidence.http.responseArtifact, evidence.http.responseBodySha256],
  ]) {
    if (!evidence.artifactPaths.includes(relative) || digest(readFileSync(resolve(sessionDir, relative))) !== expected)
      throw new Error(`Evidence ${evidence.id} 原始材料摘要不符：${resolve(sessionDir, relative)}；暂停判断`);
  }
}

export interface ContextIndexEntry {
  id: string; type: string; status: string; excerpt: { text: string; truncated: boolean };
  source?: { path: string; line: number }; references: string[]; materialPaths: string[];
}
export interface ContextIndexSnapshot { version: string; revision: number; snapshot: string; rootPath: string; pageCount: number; directoryPageCount: number; objectCount: number; }
interface CachedIndex { signature: string; files: Map<string, string>; snapshot: ContextIndexSnapshot; }
const cache = new Map<string, CachedIndex>();

/** Metadata and literal excerpts only. The authoritative objects remain in events.jsonl. */
export function contextIndexEntries(board: BoardState): ContextIndexEntry[] {
  const values: ContextIndexEntry[] = [];
  const add = (id: string, type: string, status: string, text: string, references: string[] = [], materialPaths: string[] = []) =>
    values.push({ id, type, status, excerpt: excerpt(text), references, materialPaths });
  const superseded = new Set(Object.values(board.facts).flatMap((f) => f.supersedes ? [f.supersedes] : []));
  for (const f of Object.values(board.facts)) add(f.id, 'fact', superseded.has(f.id) ? 'superseded' : 'active', f.statement, [...f.evidenceIds, ...(f.supersedes ? [f.supersedes] : [])]);
  for (const h of Object.values(board.hypotheses)) add(h.id, 'hypothesis', h.needsReview ? `${h.status}:needsReview` : h.status, h.claim, [...h.factIds, ...(h.duplicateOf ? [h.duplicateOf] : []), ...(h.verification?.factIds ?? [])]);
  for (const i of Object.values(board.intents)) add(i.id, 'intent', i.state, i.objective, [...i.basisIds, ...(i.verifiesHypothesisId ? [i.verifiesHypothesisId] : [])]);
  for (const p of Object.values(board.attackPaths)) add(p.id, 'path', `revision:${p.revision}`, p.summary, [p.verifiesHypothesisId, ...p.nodeIds, ...p.edges.flatMap((e) => e.evidenceIds)]);
  for (const r of Object.values(board.runs)) add(r.id, 'run', r.status, r.reason ?? r.purpose, [r.intentId, ...r.evidenceIds]);
  for (const e of Object.values(board.evidence)) add(e.id, 'evidence', `${e.status}:${e.kind}`, e.summary, [e.runId], e.artifactPaths);
  for (const h of Object.values(board.hints)) add(h.id, 'hint', h.delivered ? 'delivered' : 'pending', h.content, [h.messageId]);
  return values.sort((a, b) => compareIds(a.id, b.id));
}

/** Publish only complete immutable snapshots. A missing derivative is rebuildable;
 * conflicting bytes at a published immutable path are an explicit corruption error. */
export function ensureContextIndex(board: BoardState, sessionDir: string, entries = contextIndexEntries(board)): ContextIndexSnapshot | undefined {
  const eventsPath = join(sessionDir, 'blackboard', 'events.jsonl');
  if (!existsSync(eventsPath)) return undefined; // Pure in-memory callers have no persistent material to promise.
  // A historical navigation snapshot must use its own original event prefix;
  // later derived read receipts cannot change its source map or content hash.
  const eventText = readFileSync(eventsPath, 'utf8').split('\n').slice(0, board.revision).join('\n') + '\n';
  const signature = digest(JSON.stringify([PROJECTION_POLICY, board.revision, entries, digest(eventText)]));
  const key = resolve(sessionDir), previous = cache.get(key);
  let prepared: CachedIndex;
  if (previous?.signature === signature) prepared = previous;
  else {
    const sources = new Map<string, { line: number; object: unknown }>();
    const eventLines = eventText.split('\n'), eventLineBytes = eventLines.map((line) => Buffer.byteLength(line));
    const visit = (value: unknown, line: number): void => {
      if (!value || typeof value !== 'object') return;
      if ('id' in value && typeof value.id === 'string') sources.set(value.id, { line, object: value });
      for (const child of Object.values(value)) if (typeof child === 'object') visit(child, line);
    };
    eventLines.forEach((line, index) => { if (line.trim()) visit(JSON.parse(line), index + 1); });
    const snapshotName = `r${board.revision}-${signature.slice(0, 24)}`;
    const directory = join(sessionDir, 'blackboard', 'context-index', snapshotName);
    const files = new Map<string, string>();
    const rows: unknown[] = [];
    const base = { derived: true, caseId: basename(sessionDir), version: PROJECTION_POLICY.version, revision: board.revision, snapshot: snapshotName };
    const sourceFor = (id: string): unknown => {
      const original = sources.get(id); if (!original) return undefined;
      const source = { path: eventsPath, line: original.line };
      const serialized = JSON.stringify(original.object);
      const serializedBytes = Buffer.byteLength(serialized), originalSha256 = digest(serialized);
      if (serializedBytes <= 4096 && eventLineBytes[original.line - 1] <= PROJECTION_POLICY.pageBytes) return source;
      // Literal JSON text, no summary/reducer mutation. Code-point boundaries
      // preserve exact UTF-8 bytes, and 2 KiB leaves room for JSON re-escaping.
      const chunks: Array<{ offset: number; text: string }> = [];
      let chunk = '', offset = 0, size = 0;
      for (const character of serialized) {
        const length = Buffer.byteLength(character);
        if (size + length > 2048) { chunks.push({ offset, text: chunk }); offset += size; chunk = ''; size = 0; }
        chunk += character; size += length;
      }
      if (chunk) chunks.push({ offset, text: chunk });
      let next: string | null = null;
      for (let at = chunks.length - 1; at >= 0; at--) {
        const content: string = JSON.stringify({ ...base, sourceObjectId: id, format: 'literal-json-chunk', original: source,
          totalBytes: serializedBytes, originalSha256, byteOffset: chunks[at].offset, text: chunks[at].text, next }, null, 1) + '\n';
        if (Buffer.byteLength(content) > PROJECTION_POLICY.pageBytes) throw new Error(`对象 ${id} 原文分段超量；暂停发布`);
        next = `object-${id}-${at + 1}-${digest(content)}.json`; files.set(next, content);
      }
      return { path: join(directory, next!), format: 'literal-json-chunks', totalBytes: serializedBytes, originalSha256,
        note: '事件对象原 JSON 的逐字分段，按 next 读取并拼接 text；不是摘要或已读材料，旧状态不能覆盖当前 Capsule' };
    };
    for (const entry of entries) {
      const { references, materialPaths, ...metadata } = entry;
      const source = sourceFor(entry.id);
      rows.push({ ...metadata, ...(source ? { source } : {}), referenceCount: references.length, materialCount: materialPaths.length });
      for (const id of references) rows.push({ id: entry.id, relation: 'references', targetId: id });
      for (const path of materialPaths) rows.push({ id: entry.id, relation: 'material', path: resolve(sessionDir, path) });
    }
    const groups: unknown[][] = []; let current: unknown[] = [];
    // The worst-case continuation header is reserved before accepting any row.
    const page = (items: unknown[], next: string | null) => JSON.stringify({ ...base, next, entries: items }, null, 1) + '\n';
    for (const row of rows) {
      if (Buffer.byteLength(page([...current, row], `page-999999999999-${'f'.repeat(64)}.json`)) > PROJECTION_POLICY.pageBytes) {
        if (!current.length) throw new Error('派生索引单条 metadata/材料路径超过页预算；暂停发布');
        groups.push(current); current = [];
        if (Buffer.byteLength(page([row], `page-999999999999-${'f'.repeat(64)}.json`)) > PROJECTION_POLICY.pageBytes) throw new Error('派生索引单条 metadata/材料路径超过页预算；暂停发布');
      }
      current.push(row);
    }
    if (current.length || !groups.length) groups.push(current);
    let firstPage: string | null = null;
    const detailPages = new Map<string, string>();
    for (let index = groups.length - 1; index >= 0; index--) {
      const content = page(groups[index], firstPage);
      firstPage = `page-${index + 1}-${digest(content)}.json`; files.set(firstPage, content);
      for (const row of groups[index] as Array<{ id: string; type?: string }>) if (row.type) detailPages.set(row.id, firstPage);
    }
    // A compact directory copies only literal neutral metadata and the exact
    // detailed-page locator. It never replaces the complete pages or sources.
    // One-line JSON also keeps a whole 8 KiB page within read's default line cap.
    const directoryRows = entries.map(entry => {
      const shortened = excerpt(entry.excerpt.text, PROJECTION_POLICY.directoryExcerptBytes), detailPage = detailPages.get(entry.id);
      if (!detailPage) throw new Error(`对象 ${entry.id} 缺少完整索引页定位；暂停发布`);
      return { id: entry.id, type: entry.type, status: entry.status,
        excerpt: { text: shortened.text, truncated: shortened.truncated || entry.excerpt.truncated }, detailPage };
    });
    const directoryPage = (items: typeof directoryRows, next: string | null) => JSON.stringify({ ...base, format: 'directory', next, entries: items }) + '\n';
    const directoryGroups: Array<typeof directoryRows> = []; let directoryCurrent: typeof directoryRows = [];
    const directoryNext = `directory-999999999999-${'f'.repeat(64)}.json`;
    for (const row of directoryRows) {
      if (Buffer.byteLength(directoryPage([...directoryCurrent, row], directoryNext)) > PROJECTION_POLICY.pageBytes) {
        if (!directoryCurrent.length) throw new Error('轻量目录单条 metadata 超过页预算；暂停发布');
        directoryGroups.push(directoryCurrent); directoryCurrent = [];
        if (Buffer.byteLength(directoryPage([row], directoryNext)) > PROJECTION_POLICY.pageBytes) throw new Error('轻量目录单条 metadata 超过页预算；暂停发布');
      }
      directoryCurrent.push(row);
    }
    if (directoryCurrent.length || !directoryGroups.length) directoryGroups.push(directoryCurrent);
    let firstDirectory: string | null = null;
    for (let index = directoryGroups.length - 1; index >= 0; index--) {
      const content = directoryPage(directoryGroups[index], firstDirectory);
      firstDirectory = `directory-${index + 1}-${digest(content)}.json`; files.set(firstDirectory, content);
    }
    const root = JSON.stringify({ ...base, firstDirectory, directoryPageCount: directoryGroups.length,
      directoryExcerptBytes: PROJECTION_POLICY.directoryExcerptBytes, firstPage, pageCount: groups.length, objectCount: entries.length,
      order: 'numeric object ID; metadata then explicit references/materials', pageBytes: PROJECTION_POLICY.pageBytes,
      instruction: '先 read firstDirectory，按字面短摘录定位所需对象；目录按 next 翻页，再 read 匹配条目的 detailPage（相对本目录）取得完整 metadata/source。所需关系或材料行未达 referenceCount/materialCount 时，按详细页 next 补读至该对象计数齐全。firstPage 是详细页兼容起点，无需从头扫描全部详情。excerpt 非全文；旧状态不能覆盖当前 Capsule。索引读取为 derived，不能作为本次目标实验。' }, null, 1) + '\n';
    const rootName = `root-${digest(root)}.json`; files.set(rootName, root);
    prepared = { signature, files, snapshot: { version: PROJECTION_POLICY.version, revision: board.revision, snapshot: snapshotName, rootPath: join(directory, rootName), pageCount: groups.length, directoryPageCount: directoryGroups.length, objectCount: entries.length } };

  }
  const directory = join(sessionDir, 'blackboard', 'context-index', prepared.snapshot.snapshot);
  const missing: Array<[string, string]> = [];
  for (const [name, content] of prepared.files) {
    const path = join(directory, name);
    if (!existsSync(path)) missing.push([name, content]);
    else if (readFileSync(path, 'utf8') !== content) throw new Error(`派生索引损坏：${path}；暂停，须显式移除损坏副本后由事件重建`);
  }
  if (missing.length) {
    mkdirSync(directory, { recursive: true });
    // Root is last: no model receives a reference until every expected page exists.
    for (const [name, content] of missing) {
      const temporary = join(directory, `.${name}.${process.pid}.tmp`);
      try { writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); renameSync(temporary, join(directory, name)); }
      catch (error) { rmSync(temporary, { force: true }); throw new Error(`派生索引生成失败：${name}；未发布入口`, { cause: error }); }
    }
  }
  cache.set(key, prepared);
  return prepared.snapshot;
}

/** A content hash in every referenced filename also validates historical pages
 * after restart, without trusting revision, mtime or a process-local cache. */
export function assertContextIndexRead(path: string): void {
  if (!resolve(path).includes(`${sep}blackboard${sep}context-index${sep}`)) return;
  const match = /^(?:root|page-\d+|directory-\d+|object-[A-Za-z0-9]+-\d+)-([a-f0-9]{64})\.json$/.exec(basename(path));
  if (!match) throw new Error(`派生索引文件名/内容标识无效：${path}；暂停读取`);
  if (!existsSync(path)) throw new Error(`派生索引缺页：${path}；须由事件重建后再读取`);
  if (digest(readFileSync(path)) !== match[1]) throw new Error(`派生索引损坏或内容摘要不符：${path}；暂停读取`);
}
