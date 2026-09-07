import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redactor, redactStructured } from '../log.js';

export const safeSegment = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : createHash('sha256').update(id).digest('hex');
export const PREVIEW_CHARS = 12_000;
export function preview(text: string, limit = PREVIEW_CHARS) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit); const line = head.lastIndexOf('\n');
  return head.slice(0, line > limit / 2 ? line : limit) + '\n[预览已截断；完整材料见文件]';
}
export class ToolArtifacts {
  readonly relativeDir: string;
  readonly dir: string;
  readonly paths: string[] = [];
  constructor(readonly sessionDir: string, runId: string, callId: string, readonly secrets: string[] = []) {
    this.relativeDir = `artifacts/${safeSegment(runId)}/${safeSegment(callId)}`;
    this.dir = join(sessionDir, this.relativeDir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  path(name: string) { if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('无效的资料文件名'); return join(this.dir, name); }
  register(name: string) {
    const path = this.path(name);
    if (!statSync(path).isFile()) throw new Error(`原始资料不是文件：${path}`);
    chmodSync(path, 0o600);
    const rel = `${this.relativeDir}/${name}`;
    if (!this.paths.includes(rel)) this.paths.push(rel);
    return path;
  }
  save(name: string, value: string | object) {
    const redact = redactor(...this.secrets);
    const text = typeof value === 'string' ? redact(value) : JSON.stringify(redactStructured(value, redact, ['execution.json', 'result.json'].includes(name)), null, 2);
    writeFileSync(this.path(name), text, { flag: 'wx', mode: 0o600 });
    return this.register(name);
  }
  available(name: string) { return existsSync(this.path(name)) ? this.register(name) : undefined; }
  previewFile(name: string) {
    const fd = openSync(this.path(name), 'r');
    try { const b = Buffer.alloc(PREVIEW_CHARS * 4); const n = readSync(fd, b, 0, b.length, 0);
      return redactor(...this.secrets)(preview(b.subarray(0, n).toString('utf8'))); }
    finally { closeSync(fd); }
  }
  stream(name: string) { const stream = new ArtifactStream(this.path(name), this.secrets); this.register(name); return stream; }
}
/** Streams to disk with bounded UTF-8 preview, masking secrets even across chunks. */
export class ArtifactStream {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private fd: number;
  private closed = false;
  private seen = 0;
  private head = '';
  private readonly secrets: string[];
  constructor(path: string, secrets: string[]) { this.secrets = secrets.filter(Boolean).sort((a,b) => b.length-a.length); this.fd = openSync(path, 'wx', 0o600); }
  write(bytes: Buffer) { if (this.closed) return; this.pending += this.decoder.write(bytes); this.flush(false); }
  private flush(final: boolean) {
    let output = ''; let index = 0;
    while (index < this.pending.length) {
      const rest = this.pending.slice(index);
      const secret = this.secrets.find((s) => rest.startsWith(s));
      if (secret) { output += '[REDACTED]'; index += secret.length; }
      else if (!final && this.secrets.some((s) => s.startsWith(rest))) break;
      else { output += this.pending[index++]; }
    }
    this.pending = this.pending.slice(index);
    if (output) {
      const bytes = Buffer.from(output);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error('原始输出写入未取得进展'); offset += written;
      }
      this.seen += output.length; this.head += output.slice(0, Math.max(0, PREVIEW_CHARS - this.head.length));
    }
  }
  get preview() { return this.head + (this.seen > this.head.length ? '\n[预览已截断；完整材料见文件]' : ''); }
  close() { if (this.closed) return; try { this.pending += this.decoder.end(); this.flush(true); } finally { this.closed = true; closeSync(this.fd); } }
}
