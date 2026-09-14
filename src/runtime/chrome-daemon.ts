import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileLock } from "../lock.js";
import { atomicJson, projectDirectory, workspaceIdentity, xloomHome } from "../paths.js";
import { chromeServerParameters, type ChromeOptions } from "./chrome.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Reply = { success: boolean; result?: string; error?: string };
type Address = { id: string; socket: string; pidFile: string; stateFile: string; daemon: string; args: string[]; env: Record<string, string>; workspace: string };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The pinned package's local CLI protocol: one NUL-terminated JSON request per socket. */
export function chromeCommand(socketPath: string, command: object, signal?: AbortSignal, timeout = 125_000): Promise<Reply> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (error?: Error, reply?: Reply) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", aborted); socket.destroy();
      if (error) reject(error); else resolve(reply!);
    };
    const aborted = () => finish(new Error("Chrome wait cancelled; the browser operation may still finish. Inspect state before retrying."));
    const timer = setTimeout(() => finish(new Error("Chrome response timed out; the operation was not replayed. Inspect state before retrying.")), timeout);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    socket.on("connect", () => socket.write(`${JSON.stringify(command)}\0`));
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new Error("Chrome connection closed before returning a result; no action was replayed.")));
    socket.on("data", chunk => {
      const end = chunk.indexOf(0), part = end < 0 ? chunk : chunk.subarray(0, end);
      bytes += part.length;
      if (bytes > 64 * 1024 * 1024) { finish(new Error("Chrome response exceeds 64 MiB; no action was replayed.")); return; }
      chunks.push(part);
      if (end < 0) return;
      try {
        const reply = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
        if (typeof reply?.success !== "boolean") throw new Error("Missing success flag");
        finish(undefined, reply);
      }
      catch { finish(new Error("Invalid Chrome daemon response.")); }
    });
  });
}

async function address(options: ChromeOptions): Promise<Address> {
  const parameters = chromeServerParameters(options);
  const base = dirname(dirname(parameters.args![0]!));
  const utils = await import(pathToFileURL(join(base, "daemon", "utils.js")).href);
  const workspace = workspaceIdentity(options.workspace).workspace;
  const identity = `${resolve(xloomHome())}:${workspace}`;
  const id = createHash("sha256").update(`xloom-chrome-v1:${process.platform === "win32" ? identity.toLowerCase() : identity}`).digest("hex").slice(0, 32);
  const directory = projectDirectory(workspace);
  return { id, socket: utils.getSocketPath(id), pidFile: utils.getPidFilePath(id), daemon: utils.DAEMON_SCRIPT_PATH,
    stateFile: join(directory, "chrome.json"), workspace, env: parameters.env!,
    // These roots survive individual runs and Chat resets. Private transcripts are never sent to the daemon.
    args: [...parameters.args!.slice(1).filter(arg => !arg.startsWith("--workspace=")), `--workspace=${workspace}`, `--workspace=${directory}`] };
}

async function blocked(entry: Address) {
  try { return JSON.parse(await readFile(entry.stateFile, "utf8")).disconnected === true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function status(entry: Address) {
  try {
    // The upstream socket opens before MCP initialization finishes. Wait for its ready response.
    const reply = await chromeCommand(entry.socket, { method: "status" }, undefined, 15_000);
    if (!reply.success) throw new Error(reply.error ?? "Chrome daemon status failed.");
    const value = JSON.parse(reply.result!);
    if (value.version !== "1.9.0" || JSON.stringify(value.args) !== JSON.stringify(entry.args)) {
      throw new Error("Chrome connection settings changed; use /chrome disconnect, then /chrome connect. The existing connection was retained.");
    }
    return value as { pid: number; version: string; startDate: string };
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

async function ensureStarted(entry: Address, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (await blocked(entry)) throw new Error("Chrome was manually disconnected. Use /chrome connect before calling it again.");
  if (await status(entry)) return;
  const lock = new FileLock(`${entry.stateFile}.lock`);
  try {
    if (await blocked(entry)) throw new Error("Chrome was manually disconnected. Use /chrome connect before calling it again.");
    if (await status(entry)) return;
    signal?.throwIfAborted();
    const { getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const child = spawn(process.execPath, [entry.daemon, ...entry.args], { detached: true, windowsHide: true, stdio: "ignore", cwd: entry.workspace,
      env: { ...getDefaultEnvironment(), ...entry.env, CHROME_DEVTOOLS_MCP_SESSION_ID: entry.id } });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (await status(entry)) return;
      await pause(100);
    }
    throw new Error("Chrome daemon did not become ready. Inspect /chrome status before retrying.");
  } finally { lock.close(); }
}

/** Only invocation waits are cancelled; the existing MCP/browser connection stays alive. */
export async function callPersistentChrome(options: ChromeOptions, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  const entry = await address(options);
  await ensureStarted(entry, signal);
  const reply = await chromeCommand(entry.socket, { method: "invoke_tool", tool, args }, signal);
  if (!reply.success) throw new Error(reply.error ?? "Chrome tool failed; no action was replayed.");
  return JSON.parse(reply.result!) as CallToolResult;
}

/** Explicit user controls. Neither application shutdown nor model tools call disconnect. */
export async function controlChrome(options: ChromeOptions, action: "status" | "disconnect" | "connect") {
  const entry = await address(options);
  if (action === "status") {
    const running = await status(entry);
    return { bridgeRunning: !!running, manuallyDisconnected: await blocked(entry), ...(running ? { pid: running.pid, startedAt: running.startDate } : {}) };
  }
  const lock = new FileLock(`${entry.stateFile}.lock`);
  try {
    atomicJson(entry.stateFile, { disconnected: action === "disconnect" });
    if (action === "disconnect") {
      // Stop via the owned socket, never by killing an unverified PID from a stale file.
      try { await chromeCommand(entry.socket, { method: "stop" }, undefined, 10_000); }
      catch (error) {
        if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return { manuallyDisconnected: true };
        throw error;
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try { await readFile(entry.pidFile); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { manuallyDisconnected: true }; throw error; }
        await pause(100);
      }
      throw new Error("Chrome disconnect is still pending; check /chrome status.");
    }
    return { manuallyDisconnected: false, message: "Chrome is enabled for the next tool call; Chrome may ask for permission." };
  } finally { lock.close(); }
}
