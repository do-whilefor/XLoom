import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { BoardSnapshot, Evidence } from "../types.js";
import { evidencePath } from "../paths.js";
import { terms } from "./catalog.js";
import { wikiGenerator } from "./format.js";
import { cachedEntry, pruneEntries, putEntry, removeEntry, withIndexCache } from "./cache.js";
import { wikiDigest } from "./model.js";

const fingerprint = (s: Stats) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
const inside = (root: string, file: string) => { const r = relative(root, file); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface OriginalLocator { evidenceId: string; sha256: string; byteOffset: number; byteLength: number }
export type OriginalReadRequest = Omit<OriginalLocator, "byteLength"> & { byteLength?: number };
export function originalReadPath(locator: OriginalReadRequest): string {
  return `xloom://original?${new URLSearchParams(Object.entries(locator).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`;
}

function archivePath(evidence: Evidence, dataDir: string, workspace: string): string {
  const root = join(dataDir, "evidence"), file = evidencePath(evidence, dataDir, workspace);
  if (lstatSync(root).isSymbolicLink() || !inside(root, file) || !inside(realpathSync(root), realpathSync(file))) throw new Error("Evidence escaped its task archive");
  let parent = root;
  for (const part of relative(root, file).split(sep)) {
    parent = join(parent, part);
    if (lstatSync(parent).isSymbolicLink()) throw new Error("Evidence archive links are not supported");
  }
  return file;
}

/** Full streamed SHA/size/UTF-8 verification. Windows overlap at UTF-8 boundaries;
 * limits bound retained results, never silently cut the source corpus. */
function scan(evidence: Evidence, dataDir: string, workspace: string, window: (text: string, offset: number) => void,
  bytes?: (chunk: Buffer, offset: number) => void) {
  const file = archivePath(evidence, dataDir, workspace), fd = openSync(file, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Evidence must be a regular file");
    const checksum = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let total = 0, decodedBytes = 0, tail: Buffer = Buffer.alloc(0), textValid = true, count: number;
    const deliver = (text: string) => {
      const current = Buffer.from(text, "utf8"), combined = Buffer.concat([tail, current]);
      if (current.length) window(combined.toString("utf8"), decodedBytes - tail.length);
      decodedBytes += current.length;
      let start = Math.max(0, combined.length - 256);
      while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
      tail = Buffer.from(combined.subarray(start));
    };
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, count); checksum.update(chunk); bytes?.(chunk, total); total += count;
      if (textValid) {
        try { if (chunk.includes(0)) textValid = false; else deliver(decoder.decode(chunk, { stream: true })); }
        catch { textValid = false; }
      }
    }
    if (textValid) { try { deliver(decoder.decode()); } catch { textValid = false; } }
    if (fingerprint(before) !== fingerprint(fstatSync(fd)) || fingerprint(before) !== fingerprint(lstatSync(file))) throw new Error("Evidence changed during read");
    if (checksum.digest("hex") !== evidence.sha256 || total !== evidence.bytes) throw new Error("Evidence SHA-256/size mismatch");
    if (!textValid) throw new Error("Evidence is not UTF-8 text; inspect the original with its appropriate reader");
    return { file, fingerprint: fingerprint(before) };
  } finally { closeSync(fd); }
}

export function searchOriginals(board: BoardSnapshot, dataDir: string, workspace: string, query: string, limit = 6, refresh = false) {
  if (!query.trim() || query.length > 4000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Use a nonempty query up to 4000 characters and limit 1–20.");
  const tokens = [...new Set(terms(query))];
  if (!tokens.length) throw new Error("Query has no searchable terms");
  return withIndexCache(dataDir, workspace, (db, index) => {
    type Hit = { locator: OriginalLocator; readPath: string; snippet: string; score: number; matchedTerms: string[] };
    type Window = { offset: number; byteLength: number };
    const hits: Hit[] = [], issues: { evidenceId: string; reason: string }[] = [], inspected: { evidenceId: string; file: string; fingerprint: string }[] = [];
    const windows = new Map<string, Window[]>();
    index.removed = pruneEntries(db, "original", new Set(board.evidence.map(item => item.id)));
    for (const evidence of board.evidence) {
      let cacheOperation = false;
      try {
        const file = archivePath(evidence, dataDir, workspace), stat = lstatSync(file);
        if (!stat.isFile()) throw new Error("Evidence must be a regular file");
        const signature = wikiDigest([evidence.path, evidence.pathBase, evidence.sha256, evidence.bytes, fingerprint(stat)]);
        cacheOperation = true;
        const previous = cachedEntry<Window[]>(db, "original", evidence.id);
        if (previous && (!Array.isArray(previous.value) || previous.value.some(window => !Number.isSafeInteger(window?.offset) || window.offset < 0
          || !Number.isSafeInteger(window?.byteLength) || window.byteLength < 1))) throw new Error("Invalid original cache windows");
        cacheOperation = false;
        let current: Window[];
        if (!refresh && previous?.signature === signature) { current = previous.value; index.reused++; }
        else {
          current = []; const units: string[][] = [];
          scan(evidence, dataDir, workspace, (text, offset) => {
            current.push({ offset, byteLength: Buffer.byteLength(text) }); units.push([...new Set(terms(text))]);
          });
          index.indexedBytes += evidence.bytes;
          previous ? index.updated++ : index.added++;
          cacheOperation = true;
          putEntry(db, "original", evidence.id, signature, current, units);
          cacheOperation = false;
        }
        windows.set(evidence.id, current);
        inspected.push({ evidenceId: evidence.id, file, fingerprint: fingerprint(stat) });
      } catch (error) {
        if (cacheOperation) throw error;
        removeEntry(db, "original", evidence.id);
        issues.push({ evidenceId: evidence.id, reason: (error as Error).message });
      }
    }
    const selected = new Map<string, Set<number>>();
    const lookup = db.prepare("SELECT key,unit FROM terms WHERE namespace='original' AND term=?");
    for (const term of tokens) for (const row of lookup.all(term)) {
      const key = String(row.key), set = selected.get(key) ?? new Set<number>();
      set.add(Number(row.unit)); selected.set(key, set);
    }
    let matchedWindows = 0;
    const order = (a: Hit, b: Hit) => b.score - a.score || a.locator.evidenceId.localeCompare(b.locator.evidenceId) || a.locator.byteOffset - b.locator.byteOffset;
    for (const evidence of board.evidence) {
      if (!windows.has(evidence.id) || !selected.has(evidence.id)) continue;
      const offsets = new Set([...selected.get(evidence.id)!].map(unit => windows.get(evidence.id)![unit]?.offset));
      const candidates: Hit[] = []; let matches = 0;
      try {
        scan(evidence, dataDir, workspace, (text, offset) => {
          if (!offsets.has(offset)) return;
          const words = new Set(terms(text)), matchedTerms = tokens.filter(term => words.has(term));
          if (!matchedTerms.length) return;
          matches++;
          const key = [...matchedTerms].sort((a, b) => b.length - a.length)[0]!;
          const position = Math.max(0, text.toLowerCase().indexOf(key));
          let start = Math.max(0, position - 160), end = Math.min(text.length, position + 1200);
          if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
          if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
          const snippet = text.slice(start, end);
          const locator = { evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: offset + Buffer.byteLength(text.slice(0, start)), byteLength: Buffer.byteLength(snippet) };
          if (!locator.byteLength) return;
          candidates.push({ locator, readPath: originalReadPath(locator), snippet, matchedTerms, score: matchedTerms.reduce((sum, term) => sum + 1 + Math.min(term.length, 24) / 24, 0) });
          candidates.sort(order); if (candidates.length > limit) candidates.length = limit;
        });
        index.verifiedOriginals++; matchedWindows += matches;
        hits.push(...candidates); hits.sort(order); if (hits.length > limit) hits.length = limit;
      } catch (error) { issues.push({ evidenceId: evidence.id, reason: (error as Error).message }); }
    }
    for (const item of inspected) {
      try { if (fingerprint(lstatSync(item.file)) !== item.fingerprint) throw new Error("changed"); }
      catch { issues.push({ evidenceId: item.evidenceId, reason: "Evidence changed during search; retry" }); }
    }
    const unavailable = new Set(issues.map(item => item.evidenceId));
    const valid = hits.filter(hit => !unavailable.has(hit.locator.evidenceId));
    return { generator: wikiGenerator, type: "original_search", evidence: false, boardRevision: board.revision, query,
      coverage: "All registered task evidence bodies, indexed in overlapping UTF-8 windows. Unchanged file fingerprints reuse term postings; candidate originals are fully hash/size/UTF-8 verified before delivery. No private transcripts or other tasks.",
      notice: "Lexical source windows are navigation, not independent evidence or an answer. Read originals and inspect conditions/corrections. Warm no-match is not a fresh integrity audit and does not establish absence; use refresh=true to rebuild from bytes.",
      index,
      complete: !issues.length, inspectedCount: inspected.length, registeredCount: board.evidence.length, matchedWindows,
      deferredWindows: Math.max(0, matchedWindows - valid.length), issues, hits: valid };
  });
}

export function readOriginal(board: BoardSnapshot, dataDir: string, workspace: string, request: OriginalReadRequest) {
  const evidence = board.evidence.find(item => item.id === request.evidenceId);
  if (!evidence) throw new Error("Unknown evidence ID in this task");
  if (request.sha256 !== evidence.sha256) throw new Error("Stale evidence locator; search the current original again");
  const { byteOffset } = request;
  const byteLength = request.byteLength ?? Math.min(4096, evidence.bytes - byteOffset);
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 8192 || byteOffset + byteLength > evidence.bytes)
    throw new Error("Original locator must be within the registered file, with byteLength 1–8192");
  const chunks: Buffer[] = [];
  scan(evidence, dataDir, workspace, () => {}, (chunk, offset) => {
    const start = Math.max(byteOffset, offset), end = Math.min(byteOffset + byteLength, offset + chunk.length);
    if (start < end) chunks.push(Buffer.from(chunk.subarray(start - offset, end - offset)));
  });
  let selected = Buffer.concat(chunks);
  // Default pages end on a UTF-8 boundary; explicit search locators remain exact.
  if (request.byteLength === undefined && byteOffset + byteLength < evidence.bytes) {
    for (let removed = 0; removed < 4; removed++) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(selected); break; }
      catch { if (removed === 3) break; selected = selected.subarray(0, -1); }
    }
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(selected); }
  catch { throw new Error("Locator splits UTF-8 characters; use an exact returned search locator"); }
  const locator = { evidenceId: evidence.id, sha256: evidence.sha256, byteOffset, byteLength: selected.length };
  const end = byteOffset + selected.length;
  return { generator: wikiGenerator, type: "original_read", evidence: false, boardRevision: board.revision, locator, rangeSha256: hash(selected),
    originalFile: evidencePath(evidence, dataDir, workspace), integrity: "verified", text,
    omittedBefore: byteOffset, omittedAfter: evidence.bytes - end,
    ...(end < evidence.bytes ? { nextReadPath: originalReadPath({ evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: end }) } : {}),
    ...(byteOffset ? { startReadPath: originalReadPath({ evidenceId: evidence.id, sha256: evidence.sha256, byteOffset: 0 }) } : {}),
    sourceContextReadPath: `xloom://record?${new URLSearchParams({ kind: "evidence", id: evidence.id })}`,
    notice: "Verified archive bytes, not a Wiki page or a new observation. Follow nextReadPath/startReadPath for omitted context; preserve source conditions and corrections from the delivered source package. Delivery does not mean reviewed or true." };
}
