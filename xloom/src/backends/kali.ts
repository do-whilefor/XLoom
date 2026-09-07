import { Client, type ClientChannel } from 'ssh2';
import { parseKaliConfig } from '../config.js';
import type { ExternalDetails } from '../case/types.js';
import { redactor } from '../log.js';
import { abortable, BackendError } from './common.js';

export interface KaliInput { command: string; cwd?: string; timeoutMs?: number }
export function validateKaliInput(input: KaliInput) {
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')) throw new Error('kali.command 必须是非空且不含 NUL 的远程脚本');
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd || input.cwd.includes('\0'))) throw new Error('kali.cwd 必须是非空远程目录');
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647)) throw new Error('kali.timeoutMs 必须是 1 至 2147483647 的整数');
}
export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function remoteScript(input: KaliInput) {
  return `/bin/bash -c ${shellQuote((input.cwd !== undefined ? `cd -- ${shellQuote(input.cwd)} || exit $?\n` : '') + input.command)}`;
}
export class KaliBackend {
  state: 'unconfigured' | 'disconnected' | 'connected' | 'error';
  error?: string;
  private client?: Client;
  private connecting?: Promise<Client>;
  private readonly snapshot: unknown;
  private readonly redact: (s: string) => string;
  constructor(config: unknown, secrets: string[] = [], private readonly factory: () => Client = () => new Client()) {
    this.snapshot = structuredClone(config); this.state = config === undefined ? 'unconfigured' : 'disconnected';
    const password = (this.snapshot as { password?: unknown } | undefined)?.password;
    this.redact = redactor(...secrets, ...(typeof password === 'string' ? [password] : []));
  }
  get target() {
    try { const { host, port, username } = parseKaliConfig(this.snapshot); return { host, port, username }; }
    catch { return undefined; }
  }
  private async connect(signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted();
    if (this.client && this.state === 'connected') return this.client;
    if (this.connecting) return abortable(this.connecting, signal);
    const config = parseKaliConfig(this.snapshot);
    const client = this.factory(); this.client = client;
    client.on('error', (e: Error) => { if (this.client === client) { this.state = 'error'; this.error = this.redact(e.message); } });
    client.on('close', () => { if (this.client === client) { this.client = undefined; this.state = 'error'; this.error ??= 'SSH 连接已断开；不会自动重发命令'; } });
    const ready = new Promise<Client>((resolve, reject) => {
      const onError = (e: Error) => { cleanup(); reject(e); };
      const onClose = () => onError(new Error('SSH 在完成密码认证前关闭'));
      const onReady = () => { cleanup(); if (this.client !== client || signal.aborted) { client.destroy(); reject(new Error('SSH 连接已取消')); return; }
        this.state = 'connected'; this.error = undefined; resolve(client); };
      const cleanup = () => { client.off('ready', onReady); client.off('error', onError); client.off('close', onClose); };
      client.once('ready', onReady); client.once('error', onError); client.once('close', onClose);
      // Deliberately password only: no key, agent, keyboard-interactive or ssh config.
      client.connect({ ...config, authHandler: ['password'], tryKeyboard: false, readyTimeout: 60_000, keepaliveInterval: 0 });
    });
    this.connecting = ready;
    try { return await abortable(ready, signal); }
    catch (e) { if (this.client === client) this.client = undefined; client.destroy(); throw e; }
    finally { if (this.connecting === ready) this.connecting = undefined; }
  }
  async execute(input: KaliInput, signal: AbortSignal, output: (stream: 'stdout' | 'stderr', data: Buffer) => void): Promise<ExternalDetails> {
    validateKaliInput(input);
    let submitted = false;
    const source = { backend: 'kali' as const, ...this.target, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) };
    try {
      const client = await this.connect(signal); signal.throwIfAborted();
      return await new Promise<ExternalDetails>((resolve, reject) => {
        let channel: ClientChannel | undefined, done = false;
        let exitCode: number | null = null, exitSignal: string | null = null;
        const finish = (error?: string, interrupted = false) => {
          if (done) return; done = true;
          signal.removeEventListener('abort', abort); client.off('close', disconnect); client.off('error', transportError);
          const known = !error && exitCode !== null;
          const details: ExternalDetails = { ...source, exitCode, signal: exitSignal,
            status: interrupted ? 'interrupted' : error || exitCode !== 0 ? 'error' : 'observed',
            outcome: known ? 'completed' : submitted ? 'unknown' : 'not_started', fatal: !known,
            ...(error ? { error: this.redact(error) } : exitCode !== 0 ? { error: exitCode === null ? 'SSH 通道关闭但未收到退出码；外部结果未知' : `远程命令退出码 ${exitCode}` } : {}) };
          if (details.fatal) { this.state = 'error'; this.error = details.error ?? '远程执行结果未知'; }
          if (error || exitCode === null) {
            try { channel?.signal('TERM'); channel?.close(); } catch { /* best effort; never claim process rollback */ }
          }
          resolve(details);
        };
        const abort = () => finish(String(signal.reason ?? '用户取消'), true);
        const disconnect = () => finish('SSH 断线；已提交命令的外部结果未知');
        const transportError = (e: Error) => finish(e.message);
        client.once('close', disconnect); client.once('error', transportError);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        try {
          submitted = true;
          client.exec(remoteScript(input), { pty: false }, (error, stream) => {
            if (done) { if (stream) { try { stream.signal('TERM'); stream.close(); } catch {} } return; }
            if (error) { submitted = false; finish(`SSH exec 通道未建立：${error.message}`); return; }
            channel = stream;
            const data = (name: 'stdout' | 'stderr') => (chunk: Buffer) => {
              if (done) return;
              try { output(name, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
              catch (e) { finish(`输出保存失败：${String(e)}`); }
            };
            stream.on('data', data('stdout')); stream.stderr.on('data', data('stderr'));
            stream.once('exit', (code: number | null, sig?: string) => { exitCode = typeof code === 'number' ? code : null; exitSignal = sig ?? null; });
            stream.once('close', () => finish()); stream.once('error', (e: Error) => finish(e.message));
            stream.end(); // Noninteractive stdin EOF, no password/sudo prompt input.
          });
        } catch (e) { finish(String(e)); }
      });
    } catch (e) {
      this.state = 'error'; this.error = this.redact(e instanceof Error ? e.message : String(e));
      if (!submitted && !signal.aborted) this.error += '；检查 ~/.xloom/config.json 的 kali 段与服务端密码认证，修改后退出重启';
      throw new BackendError(this.error, { ...source, exitCode: null, signal: null, status: signal.aborted ? 'interrupted' : 'error',
        outcome: submitted ? 'unknown' : 'not_started', fatal: true, error: this.error });
    }
  }
  async close() {
    const client = this.client; this.client = undefined; this.connecting = undefined;
    this.state = this.snapshot === undefined ? 'unconfigured' : 'disconnected'; this.error = undefined;
    if (!client) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { client.destroy(); resolve(); }, 1000);
      client.once('close', () => { clearTimeout(timer); resolve(); });
      client.end();
    });
  }
}
