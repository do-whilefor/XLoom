import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

/** Desktop interaction only. This is never exposed as an Agent tool. */
export interface Clipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<boolean>;
}

export interface SystemClipboardOptions {
  /** Injection points let tests exercise the adapter without touching the real clipboard. */
  spawn?: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  platform?: NodeJS.Platform;
  executable?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const STDERR_MAX_BYTES = 16 * 1024;
const PRELUDE = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
  "$WarningPreference = 'SilentlyContinue'; $InformationPreference = 'SilentlyContinue'; " +
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); " +
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";
const READ_SCRIPT = PRELUDE + "$text = Get-Clipboard -Raw; if ($null -ne $text) { [Console]::Out.Write($text) }";
const WRITE_SCRIPT = PRELUDE + "$text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text";

/**
 * PowerShell 7 is already a Windows MVP dependency. Always launch it asynchronously,
 * hidden, and without profiles; clipboard data travels only through UTF-8 stdio.
 */
export function createSystemClipboard(options: SystemClipboardOptions = {}): Clipboard {
  const launch = options.spawn ?? spawn;
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? "pwsh.exe";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new Error("剪贴板超时或容量配置无效。");
  }

  const invoke = (script: string, input?: string): Promise<string> => {
    if (platform !== "win32") return Promise.reject(new Error("当前系统不支持内置剪贴板，请使用终端的复制粘贴快捷键。"));
    if (input !== undefined && Buffer.byteLength(input, "utf8") > maxBytes) {
      return Promise.reject(new Error("剪贴板内容超过容量限制。"));
    }
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error, value = ""): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) {
          // Do not await close: a broken process must not keep the input UI blocked.
          try { child?.kill(); } catch { /* The helper may already have exited. */ }
          reject(error);
        } else resolve(value);
      };
      const failed = (): void => finish(new Error("无法访问系统剪贴板，请使用终端的复制粘贴快捷键。"));
      try {
        child = launch(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
          windowsHide: true,
          shell: false,
          stdio: "pipe",
        });
        timer = setTimeout(() => finish(new Error("剪贴板访问超时，请重试。")), timeoutMs);
        child.once("error", failed);
        // Retain error listeners after settlement, including for a late EPIPE after kill.
        child.stdin.on("error", failed);
        child.stdout.on("error", failed);
        child.stderr.on("error", failed);
        child.stdout.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
          stdoutBytes += buffer.length;
          if (stdoutBytes > maxBytes) finish(new Error("剪贴板内容超过容量限制。"));
          else chunks.push(buffer);
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          // Bound diagnostics without storing or surfacing their potentially private content.
          stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
          if (stderrBytes > STDERR_MAX_BYTES) failed();
        });
        child.once("close", (code) => {
          if (settled) return;
          if (code !== 0) { failed(); return; }
          try {
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
            finish(undefined, text);
          } catch { failed(); }
        });
        child.stdin.end(input === undefined ? undefined : Buffer.from(input, "utf8"));
      } catch { failed(); }
    });
  };

  // A paste issued immediately after a copy must observe that copy, not race a
  // second PowerShell process. Failures settle the queue without poisoning it.
  let tail: Promise<void> | undefined;
  const enqueue = (operation: () => Promise<string>): Promise<string> => {
    const result = tail ? tail.then(operation) : operation();
    const settled = result.then(() => undefined, () => undefined);
    tail = settled;
    void settled.then(() => { if (tail === settled) tail = undefined; });
    return result;
  };

  return {
    readText: () => enqueue(() => invoke(READ_SCRIPT)),
    writeText: async (text) => {
      try { await enqueue(() => invoke(WRITE_SCRIPT, text)); return true; }
      catch { return false; }
    },
  };
}
