import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClipboard, type SystemClipboardOptions } from "../src/ui/clipboard.js";

function fakeChild() {
  const process = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn(() => true);
  const input: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => input.push(chunk));
  return { process, input: () => Buffer.concat(input), close: (code: number | null = 0) => process.emit("close", code) };
}

function harness(options: Omit<SystemClipboardOptions, "spawn"> = {}) {
  const child = fakeChild();
  const launch = vi.fn(() => child.process as unknown as ChildProcessWithoutNullStreams);
  const clipboard = createSystemClipboard({ platform: "win32", spawn: launch, ...options });
  return { ...child, launch, clipboard };
}

function sequenceHarness(options: Omit<SystemClipboardOptions, "spawn"> = {}) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const launch = vi.fn(() => {
    const child = fakeChild();
    children.push(child);
    return child.process as unknown as ChildProcessWithoutNullStreams;
  });
  const clipboard = createSystemClipboard({ platform: "win32", spawn: launch, ...options });
  return { children, launch, clipboard };
}

afterEach(() => vi.useRealTimers());

describe("Windows system clipboard adapter", () => {
  it("reads exact UTF-8 / CJK / multiline text without adding or trimming a newline", async () => {
    const h = harness();
    const value = "  中文🙂\r\nsecond line\n\n";
    const pending = h.clipboard.readText();
    const bytes = Buffer.from(value, "utf8");
    // Chunking may split a multi-byte code point.
    h.process.stdout.write(bytes.subarray(0, 4));
    h.process.stdout.write(bytes.subarray(4));
    h.close();
    await expect(pending).resolves.toBe(value);
    expect(h.input()).toHaveLength(0);
  });

  it("launches PowerShell 7 hidden, non-interactive and with a static UTF-8 script", async () => {
    const h = harness();
    const pending = h.clipboard.readText();
    h.close();
    await pending;
    expect(h.launch).toHaveBeenCalledWith("pwsh.exe", expect.arrayContaining([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command",
    ]), { windowsHide: true, shell: false, stdio: "pipe" });
    const script = h.launch.mock.calls[0][1].at(-1);
    expect(script).toContain("Get-Clipboard -Raw");
    expect(script).toContain("[Console]::Out.Write($text)");
    expect(script).toContain("UTF8Encoding");
    expect(script).not.toContain("Write-Output");
  });

  it("sends hostile shell strings and multiline CJK as stdin data, never command text", async () => {
    const h = harness();
    const value = "中文🙂\r\n'; $(Get-Secret); `n & echo $env:SECRET | % {$_}\n";
    const pending = h.clipboard.writeText(value);
    expect(h.input()).toEqual(Buffer.from(value, "utf8"));
    expect(JSON.stringify(h.launch.mock.calls[0])).not.toContain("Get-Secret");
    expect(h.launch.mock.calls[0][1].at(-1)).toContain("[Console]::In.ReadToEnd(); Set-Clipboard -Value $text");
    h.close();
    await expect(pending).resolves.toBe(true);
  });

  it("allows an empty string to clear the clipboard", async () => {
    const h = harness();
    const pending = h.clipboard.writeText("");
    expect(h.input()).toHaveLength(0);
    h.close();
    await expect(pending).resolves.toBe(true);
  });

  it("preserves a leading Unicode BOM as clipboard content", async () => {
    const h = harness();
    const pending = h.clipboard.readText();
    h.process.stdout.write(Buffer.from("\ufeff内容"));
    h.close();
    await expect(pending).resolves.toBe("\ufeff内容");
  });

  it("rejects oversized UTF-8 writes before spawning", async () => {
    const h = harness({ maxBytes: 5 });
    await expect(h.clipboard.writeText("中文")).resolves.toBe(false);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("bounds accumulated output bytes and kills the helper", async () => {
    const h = harness({ maxBytes: 5 });
    const pending = h.clipboard.readText();
    const rejection = expect(pending).rejects.toThrow("容量限制");
    h.process.stdout.write("中");
    h.process.stdout.write("文");
    await rejection;
    expect(h.process.kill).toHaveBeenCalledOnce();
    h.close();
  });

  it("allows an output exactly at the byte limit", async () => {
    const h = harness({ maxBytes: 6 });
    const pending = h.clipboard.readText();
    h.process.stdout.write("中文");
    h.close();
    await expect(pending).resolves.toBe("中文");
  });

  it("times out without waiting for child close and tolerates later EPIPE", async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 25 });
    const pending = h.clipboard.readText();
    const rejection = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(h.process.kill).toHaveBeenCalledOnce();
    expect(() => h.process.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }))).not.toThrow();
    h.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timeout after a successful child exit", async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 25 });
    const pending = h.clipboard.readText();
    h.close();
    await pending;
    await vi.advanceTimersByTimeAsync(25);
    expect(h.process.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expose private process errors or stderr to callers", async () => {
    const h = harness();
    const pending = h.clipboard.readText();
    const rejection = expect(pending).rejects.toThrow(/^无法访问系统剪贴板/);
    h.process.stderr.write("PRIVATE CLIPBOARD SECRET");
    h.process.emit("error", new Error("PRIVATE CLIPBOARD SECRET"));
    await rejection;
    expect(h.process.kill).toHaveBeenCalledOnce();
  });

  it("treats nonzero and interrupted child exits as failures", async () => {
    for (const exitCode of [1, null]) {
      const h = harness();
      const pending = h.clipboard.writeText("copy");
      h.close(exitCode);
      await expect(pending).resolves.toBe(false);
    }
  });

  it("bounds stderr without collecting or exposing it", async () => {
    const h = harness();
    const pending = h.clipboard.readText();
    const rejection = expect(pending).rejects.toThrow(/^无法访问系统剪贴板/);
    h.process.stderr.write("x".repeat(16 * 1024 + 1));
    await rejection;
    expect(h.process.kill).toHaveBeenCalledOnce();
  });

  it("rejects malformed UTF-8 instead of silently replacing clipboard characters", async () => {
    const h = harness();
    const pending = h.clipboard.readText();
    const rejection = expect(pending).rejects.toThrow(/^无法访问系统剪贴板/);
    h.process.stdout.write(Buffer.from([0xc3, 0x28]));
    h.close();
    await rejection;
  });

  it.each(["stdin", "stdout", "stderr"] as const)("handles %s stream failures safely", async (name) => {
    const h = harness();
    const pending = h.clipboard.writeText("copy");
    h.process[name].emit("error", new Error("private details"));
    await expect(pending).resolves.toBe(false);
    expect(h.process.kill).toHaveBeenCalledOnce();
  });

  it("converts synchronous spawn errors into safe failures", async () => {
    const clipboard = createSystemClipboard({ platform: "win32", spawn: () => { throw new Error("private path"); } });
    await expect(clipboard.readText()).rejects.toThrow(/^无法访问系统剪贴板/);
    await expect(clipboard.writeText("copy")).resolves.toBe(false);
  });

  it("does not launch Windows helpers on unsupported systems", async () => {
    const h = harness({ platform: "linux" });
    await expect(h.clipboard.readText()).rejects.toThrow("不支持");
    await expect(h.clipboard.writeText("copy")).resolves.toBe(false);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("queues an immediate paste behind the pending copy", async () => {
    const h = sequenceHarness();
    const copied = h.clipboard.writeText("新选择\n中文");
    const pasted = h.clipboard.readText();
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.children[0].input().toString("utf8")).toBe("新选择\n中文");
    h.children[0].close();
    await expect(copied).resolves.toBe(true);
    expect(h.launch).toHaveBeenCalledTimes(2);
    expect(h.launch.mock.calls[1][1].at(-1)).toContain("Get-Clipboard -Raw");
    h.children[1].process.stdout.write("新选择\n中文");
    h.children[1].close();
    await expect(pasted).resolves.toBe("新选择\n中文");
  });

  it("launches rapid successive copies one at a time in FIFO order", async () => {
    const h = sequenceHarness();
    const copies = ["first", "second", "third"].map((text) => h.clipboard.writeText(text));
    expect(h.launch).toHaveBeenCalledTimes(1);
    for (let index = 0; index < copies.length; index++) {
      expect(h.children[index].input().toString("utf8")).toBe(["first", "second", "third"][index]);
      expect(h.children).toHaveLength(index + 1);
      h.children[index].close();
      await expect(copies[index]).resolves.toBe(true);
    }
    expect(h.launch).toHaveBeenCalledTimes(3);
  });

  it("continues queued operations after a failed write without a late EPIPE poisoning them", async () => {
    const h = sequenceHarness();
    const copied = h.clipboard.writeText("first");
    const pasted = h.clipboard.readText();
    h.children[0].process.emit("error", new Error("private details"));
    await expect(copied).resolves.toBe(false);
    expect(h.children).toHaveLength(2);
    h.children[0].process.stdin.emit("error", new Error("late EPIPE"));
    h.children[1].process.stdout.write("existing clipboard");
    h.children[1].close();
    await expect(pasted).resolves.toBe("existing clipboard");
    expect(h.children[1].process.kill).not.toHaveBeenCalled();
  });

  it("continues queued operations after a failed read", async () => {
    const h = sequenceHarness();
    const pasted = h.clipboard.readText();
    const copied = h.clipboard.writeText("next");
    const rejection = expect(pasted).rejects.toThrow(/^无法访问系统剪贴板/);
    h.children[0].close(1);
    await rejection;
    expect(h.children).toHaveLength(2);
    h.children[1].close();
    await expect(copied).resolves.toBe(true);
  });

  it("skips an oversized queued copy without spawning or blocking the next request", async () => {
    const h = sequenceHarness({ maxBytes: 5 });
    const first = h.clipboard.writeText("one");
    const oversized = h.clipboard.writeText("中文");
    const last = h.clipboard.writeText("two");
    h.children[0].close();
    await expect(first).resolves.toBe(true);
    await expect(oversized).resolves.toBe(false);
    expect(h.children).toHaveLength(2);
    expect(h.children[1].input().toString("utf8")).toBe("two");
    h.children[1].close();
    await expect(last).resolves.toBe(true);
    expect(h.launch).toHaveBeenCalledTimes(2);
  });

  it("starts the next helper after timeout with its own full timeout window", async () => {
    vi.useFakeTimers();
    const h = sequenceHarness({ timeoutMs: 25 });
    const first = h.clipboard.writeText("first");
    const second = h.clipboard.writeText("second");
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toBe(false);
    expect(h.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(24);
    expect(h.children[1].process.kill).not.toHaveBeenCalled();
    h.children[1].close();
    await expect(second).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { timeoutMs: Infinity }, { timeoutMs: 0 }, { timeoutMs: 30_001 },
    { maxBytes: NaN }, { maxBytes: 0 }, { maxBytes: 16 * 1024 * 1024 + 1 },
  ])("requires finite bounded limits: %j", (options) => {
    expect(() => createSystemClipboard(options)).toThrow("配置无效");
  });
});
