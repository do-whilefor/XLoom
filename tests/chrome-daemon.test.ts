import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromeCommand, callPersistentChrome, controlChrome } from "../src/runtime/chrome-daemon.js";
import { createChromeSession, type ChromeOptions } from "../src/runtime/chrome.js";

const servers: Server[] = [], sockets = new Set<Socket>(), roots: string[] = [], bridges: ChromeOptions[] = [];
afterEach(async () => {
  for (const options of bridges.splice(0)) await controlChrome(options, "disconnect");
  for (const socket of sockets) socket.destroy(); sockets.clear();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir())); expect(basename(root)).toMatch(/^xloom-chrome-daemon-/);
    await rm(root, { recursive: true, force: true });
  }
});
async function localServer(handle: (socket: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), "xloom-chrome-daemon-")); roots.push(root);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\xloom-test-${randomUUID()}` : join(root, "socket");
  const server = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); handle(socket); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(address, resolve));
  return address;
}

describe("persistent Chrome CLI protocol", () => {
  it("frames requests and assembles split UTF-8 responses", async () => {
    let request = "";
    const address = await localServer(socket => socket.on("data", chunk => {
      request += chunk.toString();
      if (!request.endsWith("\0")) return;
      const reply = Buffer.from(JSON.stringify({ success: true, result: "用户会话" }) + "\0");
      for (const byte of reply) socket.write(Buffer.from([byte]));
      socket.end();
    }));
    expect(await chromeCommand(address, { method: "status" })).toEqual({ success: true, result: "用户会话" });
    expect(request).toBe('{"method":"status"}\0');
  });
  it.each(["{bad\0", "{}\0", "{\"success\":true}"])("rejects malformed or incomplete replies: %s", async reply => {
    const address = await localServer(socket => socket.once("data", () => socket.end(reply)));
    await expect(chromeCommand(address, { method: "status" })).rejects.toThrow(/Invalid|closed before/);
  });
  it.each(["cancel", "timeout"])("stops a %s wait without stopping the server or replaying an action", async kind => {
    const control = new AbortController(); let actions = 0;
    const address = await localServer(socket => socket.once("data", () => {
      actions++;
      if (actions === 1) { if (kind === "cancel") control.abort(); return; }
      socket.end('{"success":true}\0');
    }));
    await expect(chromeCommand(address, { method: "invoke_tool" }, control.signal, kind === "timeout" ? 100 : 5_000)).rejects.toThrow(/cancelled|timed out/);
    expect(await chromeCommand(address, { method: "status" })).toEqual({ success: true });
    expect(actions).toBe(2);
  });
  it("does not contact a missing endpoint for an already cancelled request", async () => {
    await expect(async () => chromeCommand("missing", { method: "status" }, AbortSignal.abort())).rejects.toThrow();
    await expect(chromeCommand("missing", { method: "status" })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps the pinned upstream daemon across independent processes and tool handles until explicit disconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "xloom-chrome-daemon-")); roots.push(root);
    const options = { workspace: root, artifactsDirectory: join(root, "artifacts") }; bridges.push(options);
    expect(await controlChrome(options, "status")).toEqual({ bridgeRunning: false, manuallyDisconnected: false });
    const child = async (action: string) => JSON.parse((await promisify(execFile)(process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./fixtures/chrome-client.mjs", import.meta.url)), root, action],
      { windowsHide: true, timeout: 30_000 })).stdout);
    // Invalid schema returns before browser attachment. No Chrome, website or model is used.
    const first = await child("call");
    expect(first).toMatchObject({ bridgeRunning: true, manuallyDisconnected: false, pid: expect.any(Number) });
    expect(await child("call")).toEqual(first);
    const session = createChromeSession(options);
    try { await expect(session.tool.execute("fixture", { action: "call", tool: "take_snapshot", args: { pageId: "invalid" } })).rejects.toThrow(/pageId|number/); }
    finally { await session.close(); }
    expect(await controlChrome(options, "status")).toEqual(first);
    // Channel changes never silently replace the user's existing connection.
    await expect(controlChrome({ ...options, config: { channel: "beta" } }, "status")).rejects.toThrow("settings changed");
    expect(await controlChrome(options, "status")).toEqual(first);
    await controlChrome({ ...options, config: { channel: "beta" } }, "disconnect");
    expect(await controlChrome(options, "status")).toEqual({ bridgeRunning: false, manuallyDisconnected: true });
    await expect(callPersistentChrome(options, "take_snapshot", { pageId: "invalid" })).rejects.toThrow("manually disconnected");
    await controlChrome(options, "connect");
    expect(await child("status")).toEqual({ bridgeRunning: false, manuallyDisconnected: false });
    const restarted = await child("call");
    expect(restarted.bridgeRunning).toBe(true); expect(restarted.pid).not.toBe(first.pid);
  }, 60_000);
});
